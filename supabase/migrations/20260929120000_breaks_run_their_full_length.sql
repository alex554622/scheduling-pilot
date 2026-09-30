-- A break runs the length the employee picked. Nobody ends their own 10, 30 or
-- 60-minute break early — not from the time clock, not from the shared clock-in
-- screen, and not by clocking straight out of it. Only an admin can end a break
-- before its time is up (Who's clocked in, or a punch correction).
--
-- The rule lives on the table, not in break_punch alone: the "punch_insert_self"
-- policy lets an employee insert their own time_punches row directly, so a check
-- only in the RPC could be walked around with one PostgREST call.

-- When the caller's open break is allowed to end, or null when there is no
-- break still running (none open, an older break with no length, or time up).
-- Same "last punch" ordering as clock_punch/break_punch.
create or replace function public.break_locked_until(_user uuid)
returns timestamptz
language sql stable security definer set search_path = public
as $$
  select case
           when p.kind = 'break_start'
                and p.break_minutes is not null
                and p.at + make_interval(mins => p.break_minutes) > now()
           then p.at + make_interval(mins => p.break_minutes)
         end
    from public.time_punches p
   where p.user_id = _user
   order by p.at desc, p.created_at desc, p.id desc
   limit 1;
$$;

revoke all on function public.break_locked_until(uuid) from public, anon, authenticated;

create or replace function public.enforce_break_length()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  ends_at timestamptz;
begin
  -- Ending a break, or clocking out while on one, both close it.
  if new.kind not in ('break_end', 'out') then return new; end if;

  -- Operators on the database directly (no request JWT) and the service role.
  if auth.jwt() is null or auth.jwt()->>'role' = 'service_role' then return new; end if;

  -- An admin may end anyone's break early, their own included. kiosk_punch
  -- checks for itself, since the tablet may be signed in as an admin.
  if auth.uid() is not null and public.is_company_manager(auth.uid(), new.company_id) then
    return new;
  end if;

  ends_at := public.break_locked_until(new.user_id);
  if ends_at is null then return new; end if;

  raise exception 'Your break isn''t over yet — % min left. Only an admin can end it early.',
    greatest(1, ceil(extract(epoch from ends_at - now()) / 60))::int;
end; $$;

revoke all on function public.enforce_break_length() from public, anon, authenticated;

drop trigger if exists trg_enforce_break_length on public.time_punches;
create trigger trg_enforce_break_length
before insert on public.time_punches
for each row execute function public.enforce_break_length();

-- ---- shared clock-in screen ----

-- Also reports when a running break may end, so the screen can hold the
-- "End break" button until then.
create or replace function public.kiosk_state(_token text, _code text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
  last_kind text;
  s jsonb;
  uid uuid;
  cid uuid;
  locked timestamptz;
begin
  r := public.kiosk_resolve(_token, _code);
  if not (r->>'ok')::boolean then return r; end if;
  uid := (r->>'user_id')::uuid;
  cid := (r->>'company_id')::uuid;

  select kind into last_kind from public.time_punches
   where user_id = uid
   order by at desc, created_at desc, id desc
   limit 1;

  select coalesce(settings, '{}'::jsonb) into s from public.companies where id = cid;

  if not public.is_company_manager(uid, cid) then
    locked := public.break_locked_until(uid);
  end if;

  return jsonb_build_object(
    'ok', true,
    'name', r->>'name',
    'state', case
               when last_kind is null or last_kind = 'out' then 'out'
               when last_kind = 'break_start' then 'on_break'
               else 'in'
             end,
    'break_ends_at', locked,
    'breaks', jsonb_build_object(
      '10', coalesce((s->>'allow_break_10')::boolean, true),
      '30', coalesce((s->>'allow_break_30')::boolean, true),
      '60', coalesce((s->>'allow_break_60')::boolean, true)
    )
  );
end; $$;

-- As before, plus the break-length rule. The trigger can't be relied on here:
-- it exempts an admin session, and the tablet may be signed in as one while an
-- employee punches with their code. The employee's own role is what counts.
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
   where user_id = uid
   order by at desc, created_at desc, id desc
   limit 1;

  if last_kind = 'break_start' and not public.is_company_manager(uid, cid) then
    locked := public.break_locked_until(uid);
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

  return jsonb_build_object('ok', true, 'name', r->>'name', 'kind', row.kind, 'at', row.at);
end; $$;

revoke all on function public.kiosk_state(text, text) from public;
revoke all on function public.kiosk_punch(text, text, text, integer) from public;
grant execute on function public.kiosk_state(text, text) to anon, authenticated;
grant execute on function public.kiosk_punch(text, text, text, integer) to anon, authenticated;
