-- Team rules: clock-in and timesheet rules that apply to one department.
--
-- Run AFTER 20261121120000_supervisor_departments.sql,
-- 20261122120000_multi_company_memberships.sql and
-- 20261122130000_multi_company_supervisor_scope.sql (all already applied).
--
-- A team row holds only the settings that team changes. Anything it leaves
-- out comes from companies.settings, exactly as before. The effective rules
-- for a person are   companies.settings || department_rules.rules   for the
-- department their membership in that company puts them in.
--
-- Keys a team may set:
--   early_clock_in_minutes   int     how long before a scheduled shift (that
--                                    day) someone may clock in. false = no limit.
--   late_after_minutes       int     clock-ins more than this after the shift
--                                    start are flagged late (time_punches.late_minutes)
--                                    and the admins and the person's supervisors
--                                    are notified. false = not tracked.
--   require_geofence         bool    same meaning as the company setting.
--   require_gps              bool    refuse a clock-in/out with GPS off.
--   allow_kiosk              bool    false = the shared clock-in turns them away.
--   allow_break_10/30/60     bool    same meaning as the company settings.
--   punch_round_minutes      int     same meaning as the company setting.
--   daily_overtime_hours     num     same meaning as the company setting.
--   daily_double_time_hours  num     same meaning as the company setting.
--   overtime_threshold_hours num     same meaning as the company setting.
--   require_edit_note        bool    an admin/supervisor changing this team's
--                                    punches must give a reason.
--
-- The same keys are company defaults in companies.settings (App rules), where
-- early/late are a number or null.
--
-- Who may edit: company admins (and super admins) any team; a supervisor only
-- a team they supervise as a whole department (an assignment with no
-- employee_id), in the company they have selected.
--
-- Function bodies below are the latest ones from 20261122120000 (clock_punch,
-- break_punch, switch_location, kiosk_state, kiosk_punch), changed only to
-- read member_rules() instead of companies.settings and to apply the new
-- rules. manager_*_punch are NOT redefined: the note rule is a trigger on
-- time_punch_audit, which every one of them writes in the same transaction.
--
-- Re-runnable. Paste the whole file into the Studio SQL editor.

begin;

-- ---------------------------------------------------------------- table ----

create table if not exists public.department_rules (
  department_id uuid primary key references public.departments(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  rules         jsonb not null default '{}'::jsonb,
  updated_by    uuid references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now()
);
create index if not exists department_rules_company_idx on public.department_rules(company_id);

alter table public.time_punches add column if not exists late_minutes integer;

-- ------------------------------------------------------------ validation ----

create or replace function public.clean_team_rules(_rules jsonb)
returns jsonb language plpgsql immutable set search_path = public
as $$
declare
  k text;
  v jsonb;
  n numeric;
  out_rules jsonb := '{}'::jsonb;
begin
  if _rules is null then return out_rules; end if;
  if jsonb_typeof(_rules) <> 'object' then raise exception 'team rules must be an object'; end if;

  for k, v in select * from jsonb_each(_rules) loop
    -- null means "use the company's setting": leave the key out.
    if v is null or jsonb_typeof(v) = 'null' then continue; end if;

    if k in ('require_geofence', 'require_gps', 'allow_kiosk',
             'allow_break_10', 'allow_break_30', 'allow_break_60', 'require_edit_note') then
      if jsonb_typeof(v) <> 'boolean' then raise exception '% must be true or false', k; end if;
    elsif k in ('early_clock_in_minutes', 'late_after_minutes') and v = 'false'::jsonb then
      null; -- switched off for this team, whatever the company sets
    elsif k in ('early_clock_in_minutes', 'late_after_minutes', 'punch_round_minutes') then
      if jsonb_typeof(v) <> 'number' then raise exception '% must be a number', k; end if;
      n := (v #>> '{}')::numeric;
      if n <> trunc(n) or n < 0 then raise exception '% must be a whole number of minutes', k; end if;
      if k = 'early_clock_in_minutes' and n > 720 then raise exception 'early clock-in can be at most 720 minutes'; end if;
      if k = 'late_after_minutes' and n > 240 then raise exception 'late after can be at most 240 minutes'; end if;
      if k = 'punch_round_minutes' and n > 60 then raise exception 'rounding can be at most 60 minutes'; end if;
    elsif k in ('daily_overtime_hours', 'daily_double_time_hours', 'overtime_threshold_hours') then
      if jsonb_typeof(v) <> 'number' then raise exception '% must be a number', k; end if;
      n := (v #>> '{}')::numeric;
      if n < 0 or n > 168 then raise exception '% must be between 0 and 168 hours', k; end if;
    else
      raise exception 'unknown team rule: %', k;
    end if;

    out_rules := out_rules || jsonb_build_object(k, v);
  end loop;
  return out_rules;
end; $$;

-- ------------------------------------------------------------ permission ----

create or replace function public.can_manage_team_rules(_user uuid, _department uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _user is not null and exists (
    select 1 from public.departments d
     where d.id = _department
       and (public.is_company_manager(_user, d.company_id)
            or (d.company_id = public.current_company_id()
                and public.is_supervisor(_user, d.company_id)
                and exists (select 1 from public.supervisor_assignments a
                             where a.company_id = d.company_id
                               and a.department_id = d.id
                               and a.supervisor_id = _user
                               and a.employee_id is null)))
  );
$$;
revoke all on function public.can_manage_team_rules(uuid, uuid) from public, anon;
grant execute on function public.can_manage_team_rules(uuid, uuid) to authenticated;

-- The teams the caller may edit rules for, in the selected company.
create or replace function public.my_rule_departments()
returns setof uuid language sql stable security definer set search_path = public
as $$
  select d.id from public.departments d
   where d.company_id = public.current_company_id()
     and public.can_manage_team_rules(auth.uid(), d.id);
$$;
revoke all on function public.my_rule_departments() from public, anon;
grant execute on function public.my_rule_departments() to authenticated;

-- --------------------------------------------------------- guard trigger ----

create or replace function public.department_rules_guard()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  select d.company_id into new.company_id from public.departments d where d.id = new.department_id;
  if new.company_id is null then raise exception 'that team does not exist'; end if;
  new.rules := public.clean_team_rules(new.rules);
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end; $$;

drop trigger if exists department_rules_guard on public.department_rules;
create trigger department_rules_guard
  before insert or update on public.department_rules
  for each row execute function public.department_rules_guard();

-- ------------------------------------------------------------------- RLS ----

alter table public.department_rules enable row level security;
grant select, insert, update, delete on public.department_rules to authenticated;
grant all on public.department_rules to service_role;

-- Everyone in the company can read them: the time clock needs its own team's.
drop policy if exists department_rules_select on public.department_rules;
create policy department_rules_select on public.department_rules for select to authenticated
  using (public.is_member(auth.uid(), company_id)
         or public.has_role(auth.uid(), 'super_admin'::public.app_role));

drop policy if exists department_rules_insert on public.department_rules;
create policy department_rules_insert on public.department_rules for insert to authenticated
  with check (public.can_manage_team_rules(auth.uid(), department_id));

drop policy if exists department_rules_update on public.department_rules;
create policy department_rules_update on public.department_rules for update to authenticated
  using (public.can_manage_team_rules(auth.uid(), department_id))
  with check (public.can_manage_team_rules(auth.uid(), department_id));

drop policy if exists department_rules_delete on public.department_rules;
create policy department_rules_delete on public.department_rules for delete to authenticated
  using (public.can_manage_team_rules(auth.uid(), department_id));

-- -------------------------------------------------------- effective rules ----

-- Company settings with the person's team rules laid over them. Internal: it
-- takes any user and company, so only the security-definer functions call it.
create or replace function public.member_rules(_user uuid, _company uuid)
returns jsonb language sql stable security definer set search_path = public
as $$
  select coalesce((select c.settings from public.companies c where c.id = _company), '{}'::jsonb)
      || coalesce((select dr.rules
                     from public.company_memberships m
                     join public.department_rules dr on dr.department_id = m.department_id
                    where m.user_id = _user and m.company_id = _company
                    limit 1), '{}'::jsonb);
$$;
revoke all on function public.member_rules(uuid, uuid) from public, anon, authenticated;

-- The shift a clock-in belongs to, and what the team's rules say about it.
-- Returns {} (nothing to say), {"error": "..."} (too early) or {"late": n}.
-- Only a published shift that starts today (company time) and hasn't ended
-- counts; with none, neither rule applies. A clock-in after an earlier one
-- for the same shift (back from a split, say) is neither early nor late.
create or replace function public.clock_in_check(_user uuid, _company uuid, _rules jsonb)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  tz text;
  st timestamptz;
  -- Only a number counts: null (company) and false (team) both mean "off".
  early int := case when jsonb_typeof(_rules->'early_clock_in_minutes') = 'number'
                    then (_rules->>'early_clock_in_minutes')::numeric::int end;
  late_after int := case when jsonb_typeof(_rules->'late_after_minutes') = 'number'
                         then (_rules->>'late_after_minutes')::numeric::int end;
  mins int;
begin
  if early is null and late_after is null then return '{}'::jsonb; end if;

  select coalesce(c.timezone, 'UTC') into tz from public.companies c where c.id = _company;
  tz := coalesce(tz, 'UTC');

  select s.starts_at into st
    from public.shifts s
   where s.employee_id = _user and s.company_id = _company and s.published
     and s.ends_at > now()
     and (s.starts_at at time zone tz)::date = (now() at time zone tz)::date
   order by s.starts_at
   limit 1;
  if st is null then return '{}'::jsonb; end if;

  if exists (select 1 from public.time_punches p
              where p.user_id = _user and p.company_id = _company and p.kind = 'in'
                and p.at >= st - make_interval(mins => greatest(coalesce(early, 0), 120))) then
    return '{}'::jsonb;
  end if;

  if early is not null and now() < st - make_interval(mins => early) then
    return jsonb_build_object('error',
      format('Too early to clock in: your shift starts at %s. You can clock in from %s.',
             to_char(st at time zone tz, 'FMHH12:MI AM'),
             to_char((st - make_interval(mins => early)) at time zone tz, 'FMHH12:MI AM')));
  end if;

  if late_after is not null and now() > st then
    mins := floor(extract(epoch from now() - st) / 60)::int;
    if mins > late_after then return jsonb_build_object('late', mins); end if;
  end if;
  return '{}'::jsonb;
end; $$;
revoke all on function public.clock_in_check(uuid, uuid, jsonb) from public, anon, authenticated;

-- Tell the company admins, and whoever supervises the person, about a late
-- clock-in. Muted like any other kind through wants_notification().
create or replace function public.notify_late_clock_in(_user uuid, _company uuid, _minutes int)
returns void language plpgsql security definer set search_path = public
as $$
declare
  who text;
begin
  if _minutes is null then return; end if;
  select coalesce(nullif(trim(full_name), ''), 'An employee') into who
    from public.profiles where id = _user;

  insert into public.notifications (user_id, type, title, body, link)
  select distinct ur.user_id, 'late_clock_in', 'Late clock-in',
         format('%s clocked in %s min after their shift started.', who, _minutes),
         '/timecards'
    from public.user_roles ur
    join public.company_memberships m
      on m.user_id = ur.user_id and m.company_id = ur.company_id and m.status = 'active'
   where ur.company_id = _company
     and ur.user_id <> _user
     and (ur.role = 'company_admin'::public.app_role
          or (ur.role = 'supervisor'::public.app_role and public.supervises(ur.user_id, _user)))
     and public.wants_notification(ur.user_id, 'late_clock_in');
end; $$;
revoke all on function public.notify_late_clock_in(uuid, uuid, int) from public, anon, authenticated;

-- -------------------------------------------------------- edit-note rule ----

-- Every manager_*_punch function writes an audit row in the same transaction
-- as the change, so refusing the row refuses the change.
create or replace function public.require_edit_note()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.actor_id is null or new.actor_id = new.user_id then return new; end if;
  if coalesce(trim(new.reason), '') <> '' then return new; end if;
  if coalesce((public.member_rules(new.user_id, new.company_id)->>'require_edit_note')::boolean, false) then
    raise exception 'A note is required when changing time for this team. Say why in the note box.';
  end if;
  return new;
end; $$;

drop trigger if exists require_edit_note on public.time_punch_audit;
create trigger require_edit_note
  before insert on public.time_punch_audit
  for each row execute function public.require_edit_note();

-- ---------------------------------------------------------- clock_punch ----

create or replace function public.clock_punch(_lat double precision, _lng double precision, _accuracy double precision default null)
returns public.time_punches
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  cid uuid;
  c record;
  s jsonb;
  require_geo boolean;
  has_gps boolean := _lat is not null and _lng is not null;
  last_kind text;
  next_kind text;
  dist double precision;
  who text;
  chk jsonb := '{}'::jsonb;
  row public.time_punches;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  cid := public.current_company_id();
  if cid is null then raise exception 'you must be a member of a company'; end if;

  select latitude, longitude, geofence_radius_m
    into c
  from public.companies where id = cid;
  s := public.member_rules(uid, cid);
  require_geo := coalesce((s->>'require_geofence')::boolean, true);

  if not has_gps and coalesce((s->>'require_gps')::boolean, false) then
    raise exception 'Your team needs your GPS location to clock in or out. Turn on location and try again.';
  end if;

  if has_gps and c.latitude is not null and c.longitude is not null then
    dist := public.haversine_m(c.latitude, c.longitude, _lat, _lng);
    if require_geo and dist > coalesce(c.geofence_radius_m, 200) then
      raise exception 'You are % meters from the worksite (allowed: %m). Move closer to clock in/out.',
        round(dist)::int, c.geofence_radius_m;
    end if;
  else
    dist := null;
  end if;

  select kind into last_kind from public.time_punches
    where user_id = uid and company_id = cid
    order by at desc, created_at desc, id desc
    limit 1;

  -- on the clock unless there is no punch yet, or the last one was 'out'
  next_kind := case
                 when last_kind is null or last_kind = 'out' then 'in'
                 else 'out'
               end;

  if next_kind = 'in' then
    chk := public.clock_in_check(uid, cid, s);
    if chk ? 'error' then raise exception '%', chk->>'error'; end if;
  end if;

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, accuracy_m, distance_m, within_geofence, late_minutes)
  values (uid, cid, next_kind, _lat, _lng, _accuracy, dist, has_gps, (chk->>'late')::int)
  returning * into row;

  perform public.notify_late_clock_in(uid, cid, row.late_minutes);

  -- No location while the company has a geofence: tell the admins.
  if not has_gps and require_geo and c.latitude is not null and c.longitude is not null then
    select coalesce(nullif(trim(full_name), ''), 'An employee') into who
      from public.profiles where id = uid;

    insert into public.notifications (user_id, type, title, body, link)
    select distinct ur.user_id, 'punch_without_gps',
           case when next_kind = 'in' then 'Clock-in without GPS' else 'Clock-out without GPS' end,
           who || ' clocked ' || next_kind || ' with their GPS location turned off.',
           '/timecards'
      from public.user_roles ur
      join public.company_memberships m on m.user_id = ur.user_id and m.company_id = ur.company_id and m.status = 'active'
     where ur.company_id = cid
       and ur.role = 'company_admin'::public.app_role
       and ur.user_id <> uid
       and public.wants_notification(ur.user_id, 'punch_without_gps');
  end if;

  return row;
end;
$function$;

-- ---------------------------------------------------------- break_punch ----

create or replace function public.break_punch(_lat double precision, _lng double precision, _accuracy double precision default null, _minutes integer default null)
returns public.time_punches
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  cid uuid;
  c record;
  s jsonb;
  require_geo boolean;
  has_gps boolean := _lat is not null and _lng is not null;
  allow10 boolean; allow30 boolean; allow60 boolean;
  last_kind text;
  last_break_minutes int;
  next_kind text;
  dist double precision;
  row public.time_punches;
  bmin int;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  cid := public.current_company_id();
  if cid is null then raise exception 'you must be a member of a company'; end if;

  select latitude, longitude, geofence_radius_m into c from public.companies where id = cid;
  s := public.member_rules(uid, cid);
  require_geo := coalesce((s->>'require_geofence')::boolean, true);
  allow10 := coalesce((s->>'allow_break_10')::boolean, true);
  allow30 := coalesce((s->>'allow_break_30')::boolean, true);
  allow60 := coalesce((s->>'allow_break_60')::boolean, true);

  if has_gps and c.latitude is not null and c.longitude is not null then
    dist := public.haversine_m(c.latitude, c.longitude, _lat, _lng);
    if require_geo and dist > coalesce(c.geofence_radius_m, 200) then
      raise exception 'You are % meters from the worksite (allowed: %m).',
        round(dist)::int, c.geofence_radius_m;
    end if;
  end if;

  select kind, break_minutes into last_kind, last_break_minutes
    from public.time_punches
    where user_id = uid and company_id = cid
    order by at desc, created_at desc, id desc
    limit 1;

  if last_kind is null or last_kind = 'out' then
    raise exception 'You need to clock in before starting a break.';
  end if;

  next_kind := case when last_kind = 'break_start' then 'break_end' else 'break_start' end;

  if next_kind = 'break_start' then
    if _minutes is null or _minutes not in (10, 30, 60) then
      raise exception 'Pick a break length: 10, 30, or 60 minutes.';
    end if;
    if (_minutes = 10 and not allow10)
       or (_minutes = 30 and not allow30)
       or (_minutes = 60 and not allow60) then
      raise exception 'That break length is disabled by your company''s App rules.';
    end if;
    bmin := _minutes;
  else
    bmin := last_break_minutes;
  end if;

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, accuracy_m, distance_m, within_geofence, break_minutes)
  values (uid, cid, next_kind, _lat, _lng, _accuracy, dist, has_gps, bmin)
  returning * into row;
  return row;
end;
$function$;

-- ------------------------------------------------------- switch_location ----

create or replace function public.switch_location(
  _location uuid,
  _lat double precision,
  _lng double precision,
  _accuracy double precision default null
)
returns public.location_moves
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  c record;
  require_geo boolean;
  dist double precision;
  last_kind text;
  row public.location_moves;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if _lat is null or _lng is null then raise exception 'location required'; end if;

  cid := public.current_company_id();
  if cid is null then raise exception 'you must be a member of a company'; end if;

  if not exists (select 1 from public.locations where id = _location and company_id = cid) then
    raise exception 'that location is not in this company';
  end if;
  if exists (select 1 from public.employee_locations where employee_id = uid and company_id = cid)
     and not exists (select 1 from public.employee_locations
                      where employee_id = uid and location_id = _location) then
    raise exception 'you are not set up to work at that location';
  end if;

  -- The same distance rule as clock_punch.
  select latitude, longitude, geofence_radius_m into c
    from public.companies where id = cid;
  require_geo := coalesce((public.member_rules(uid, cid)->>'require_geofence')::boolean, true);
  if c.latitude is not null and c.longitude is not null then
    dist := public.haversine_m(c.latitude, c.longitude, _lat, _lng);
    if require_geo and dist > coalesce(c.geofence_radius_m, 200) then
      raise exception 'You are % meters from the worksite (allowed: %m). Move closer to clock in/out.',
        round(dist)::int, c.geofence_radius_m;
    end if;
  end if;

  select kind into last_kind from public.time_punches
   where user_id = uid and company_id = cid
   order by at desc, created_at desc, id desc
   limit 1;
  if last_kind is null or last_kind = 'out' then
    raise exception 'Clock in first.';
  end if;
  if last_kind = 'break_start' then
    raise exception 'End your break before changing location.';
  end if;

  if public.current_work_location(uid, cid) is not distinct from _location then
    raise exception 'You are already at that location.';
  end if;

  insert into public.location_moves (company_id, user_id, location_id)
  values (cid, uid, _location)
  returning * into row;
  return row;
end; $$;

-- ----------------------------------------------------------- kiosk_state ----

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

  s := public.member_rules(uid, cid);
  if not coalesce((s->>'allow_kiosk')::boolean, true) then
    return jsonb_build_object('ok', false, 'message',
      'Your team can''t use the shared clock-in. Clock in from the app on your own phone.');
  end if;

  select kind into last_kind from public.time_punches
   where user_id = uid and company_id = cid
   order by at desc, created_at desc, id desc
   limit 1;

  if not public.is_company_manager(uid, cid) then
    locked := public.break_locked_until(uid, cid);
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

-- ----------------------------------------------------------- kiosk_punch ----

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
  chk jsonb := '{}'::jsonb;
  row public.time_punches;
begin
  r := public.kiosk_resolve(_token, _code);
  if not (r->>'ok')::boolean then return r; end if;
  uid := (r->>'user_id')::uuid;
  cid := (r->>'company_id')::uuid;

  select latitude, longitude into c
    from public.companies where id = cid;
  s := public.member_rules(uid, cid);

  if not coalesce((s->>'allow_kiosk')::boolean, true) then
    return jsonb_build_object('ok', false, 'message',
      'Your team can''t use the shared clock-in. Clock in from the app on your own phone.');
  end if;

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
    if next_kind = 'in' then
      chk := public.clock_in_check(uid, cid, s);
      if chk ? 'error' then
        return jsonb_build_object('ok', false, 'message', chk->>'error');
      end if;
    end if;
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

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, distance_m, within_geofence, break_minutes, late_minutes)
  values (uid, cid, next_kind, c.latitude, c.longitude,
          case when c.latitude is not null then 0 else null end, true, bmin, (chk->>'late')::int)
  returning * into row;

  perform public.notify_late_clock_in(uid, cid, row.late_minutes);

  return jsonb_build_object('ok', true, 'name', r->>'name', 'kind', row.kind, 'at', row.at);
end; $$;

commit;

notify pgrst, 'reload schema';
