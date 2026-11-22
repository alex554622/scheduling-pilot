-- Connect the schedule to time cards: an optional, admin-controlled App rule.
--
-- The rule itself lives in companies.settings like every other App rule
-- ("schedule_lateness", default off; "late_grace_minutes", default 5), so no
-- table changes. Only company admins can update companies (policy
-- "company_admin_update"), which is what keeps the toggle admin-only.
--
-- Lateness is computed, never stored on the punch. The app works it out from
-- shifts and punches (src/lib/lateness.ts); these functions are the same rule
-- for the shared clock-in device, which has no session and so cannot read
-- shifts itself. Because nothing is stored, a shift moved or unpublished after
-- someone clocked in changes the answer on the next read, and turning the rule
-- off leaves nothing behind.
--
-- The rule, matching src/lib/lateness.ts:
-- * only published shifts assigned to the person count;
-- * a clock-in belongs to the shift under way at that moment (the latest
--   start, if two overlap), or failing that to the next shift starting within
--   4 hours;
-- * only the first clock-in of a shift is judged;
-- * late = more than late_grace_minutes whole minutes after the shift start.

create or replace function public.punch_match_shift(_user uuid, _company uuid, _at timestamptz)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from (
    -- under way: latest start first
    (select id, 0 as rank, -extract(epoch from starts_at) as ord
       from public.shifts
      where employee_id = _user and company_id = _company and published
        and starts_at <= _at and ends_at > _at
      order by starts_at desc
      limit 1)
    union all
    -- upcoming within 4 hours: earliest start first
    (select id, 1 as rank, extract(epoch from starts_at) as ord
       from public.shifts
      where employee_id = _user and company_id = _company and published
        and starts_at > _at and starts_at <= _at + interval '4 hours'
      order by starts_at asc
      limit 1)
  ) c
  order by rank, ord
  limit 1;
$$;

-- Minutes late for a clock-in, or null when the rule is off, the clock-in
-- matches no shift, it is not the shift's first clock-in, or it is within the
-- grace period.
create or replace function public.punch_late_minutes(_user uuid, _company uuid, _at timestamptz)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s jsonb;
  grace int;
  sid uuid;
  start_at timestamptz;
  mins int;
begin
  select coalesce(settings, '{}'::jsonb) into s from public.companies where id = _company;
  if not coalesce((s->>'schedule_lateness')::boolean, false) then return null; end if;
  grace := greatest(0, coalesce((s->>'late_grace_minutes')::int, 5));

  sid := public.punch_match_shift(_user, _company, _at);
  if sid is null then return null; end if;
  select starts_at into start_at from public.shifts where id = sid;

  if exists (
    select 1 from public.time_punches p
     where p.user_id = _user and p.kind = 'in'
       and p.at < _at and p.at >= start_at - interval '4 hours'
       and public.punch_match_shift(_user, _company, p.at) = sid
  ) then
    return null;
  end if;

  mins := greatest(0, floor(extract(epoch from (_at - start_at)) / 60)::int);
  if mins <= grace then return null; end if;
  return mins;
end;
$$;

revoke all on function public.punch_match_shift(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.punch_late_minutes(uuid, uuid, timestamptz) from public, anon, authenticated;

-- kiosk_punch, as in 20261122120000_multi_company_memberships, plus
-- "late_minutes" in the reply for a late clock-in so the device can say so.
create or replace function public.kiosk_punch(_token text, _code text, _action text, _minutes integer default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
  uid uuid;
  cid uuid;
  c record;
  s jsonb;
  last_kind text;
  last_break_minutes int;
  next_kind text;
  bmin int;
  locked timestamptz;
  late int;
  row public.time_punches;
begin
  r := public.kiosk_resolve(_token, _code);
  if not (r->>'ok')::boolean then return r; end if;
  uid := (r->>'user_id')::uuid;
  cid := (r->>'company_id')::uuid;

  select latitude, longitude, coalesce(settings, '{}'::jsonb) as settings into c
    from public.companies where id = cid;
  s := c.settings;

  select kind, break_minutes into last_kind, last_break_minutes
    from public.time_punches
   where user_id = uid and company_id = cid
   order by at desc, created_at desc, id desc
   limit 1;

  if last_kind = 'break_start' and not public.is_company_manager(uid, cid) then
    locked := public.break_locked_until(uid, cid);
    if locked is not null then
      return jsonb_build_object('ok', false, 'message',
        format('Your break isn''t over yet — %s min left. Only an admin can end it early.',
               greatest(1, ceil(extract(epoch from locked - now()) / 60))::int));
    end if;
  end if;

  if _action = 'clock' then
    next_kind := case when last_kind is null or last_kind = 'out' then 'in' else 'out' end;
    bmin := null;
  elsif _action = 'break' then
    if last_kind is null or last_kind = 'out' then
      return jsonb_build_object('ok', false, 'message', 'Clock in before starting a break.');
    end if;
    next_kind := case when last_kind = 'break_start' then 'break_end' else 'break_start' end;
    if next_kind = 'break_start' then
      if _minutes is null or _minutes not in (10, 30, 60) then
        return jsonb_build_object('ok', false, 'message', 'Pick a break length: 10, 30 or 60 minutes.');
      end if;
      if (_minutes = 10 and not coalesce((s->>'allow_break_10')::boolean, true))
         or (_minutes = 30 and not coalesce((s->>'allow_break_30')::boolean, true))
         or (_minutes = 60 and not coalesce((s->>'allow_break_60')::boolean, true)) then
        return jsonb_build_object('ok', false, 'message', 'That break length is turned off in your App rules.');
      end if;
      bmin := _minutes;
    else
      bmin := last_break_minutes;
    end if;
  else
    return jsonb_build_object('ok', false, 'message', 'Unknown action.');
  end if;

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, distance_m, within_geofence, break_minutes)
  values (uid, cid, next_kind, c.latitude, c.longitude,
          case when c.latitude is not null then 0 else null end, true, bmin)
  returning * into row;

  if row.kind = 'in' then
    late := public.punch_late_minutes(uid, cid, row.at);
  end if;

  return jsonb_build_object('ok', true, 'name', r->>'name', 'kind', row.kind, 'at', row.at)
    || case when late is not null then jsonb_build_object('late_minutes', late) else '{}'::jsonb end;
end; $$;
