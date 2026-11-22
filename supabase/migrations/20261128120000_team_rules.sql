-- Team rules: clock-in and timesheet rules that apply to one department.
--
-- Run AFTER every earlier migration, in particular
-- 20261124120000_reconcile_clock_punch_and_absences.sql (GPS grace period) and
-- 20261125120000_schedule_lateness.sql (lateness against the schedule).
--
-- A team row (department_rules) holds only the settings that team changes.
-- Anything it leaves out comes from companies.settings (App rules), exactly
-- as before. The effective rules for a person are
--     companies.settings || department_rules.rules
-- for the department their membership in that company puts them in
-- (member_rules()).
--
-- Keys a team may set:
--   early_clock_in_minutes   int|false  minutes before a published shift (that
--                                       day) someone may clock in. false = no
--                                       limit. Company default: null (no limit).
--   schedule_lateness        bool       mark late clock-ins (see
--                                       20261125120000_schedule_lateness.sql).
--   late_grace_minutes       int        minutes after the shift start that still
--                                       count as on time.
--   require_geofence         bool       as the company setting.
--   require_gps              bool       refuse Clock IN with GPS off, with no
--                                       7-day grace period. Clock OUT is never
--                                       refused.
--   allow_kiosk              bool       false = the shared clock-in turns them away.
--   allow_break_10/30/60     bool       as the company settings.
--   punch_round_minutes      int        as the company setting.
--   daily_overtime_hours     num        as the company setting.
--   daily_double_time_hours  num        as the company setting.
--   overtime_threshold_hours num        as the company setting.
--   require_edit_note        bool       an admin or supervisor changing someone's
--                                       punches must give a reason.
--
-- A late clock-in (schedule_lateness on) now also notifies the company admins
-- and the person's supervisors.
--
-- Who may edit: company admins (and super admins) any team; a supervisor only
-- a team they supervise as a whole department (an assignment with no
-- employee_id), in the company they have selected.
--
-- Redefined here, from their latest versions plus the team rules:
--   clock_punch         20261124120000_reconcile (multi-company + GPS grace)
--   kiosk_punch         20261125120000_schedule_lateness (late_minutes reply)
--   punch_late_minutes  20261125120000_schedule_lateness, reading member_rules()
--   break_punch, switch_location, kiosk_state   20261122120000_multi_company
-- manager_*_punch are NOT redefined: the note rule is a trigger on
-- time_punch_audit, which each of them writes in the same transaction.
--
-- An earlier draft of this file stored lateness on time_punches.late_minutes
-- and had a "late_after_minutes" team rule. If that draft was applied, this
-- removes both, and restores the GPS grace period and the kiosk's late reply
-- it had replaced.
--
-- Re-runnable. Paste the whole file into the Studio SQL editor.

begin;

-- Stop here, changing nothing, if what this builds on isn't live.
do $$
begin
  if to_regprocedure('public.current_company_id()') is null
     or to_regclass('public.company_memberships') is null
     or to_regclass('public.supervisor_assignments') is null
     or to_regclass('public.gps_off_grace') is null
     or to_regprocedure('public.punch_match_shift(uuid, uuid, timestamp with time zone)') is null then
    raise exception 'multi-company, supervisor, GPS grace or schedule lateness migrations are missing; apply those first';
  end if;
end;
$$;

-- ---------------------------------------------------------------- table ----

create table if not exists public.department_rules (
  department_id uuid primary key references public.departments(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  rules         jsonb not null default '{}'::jsonb,
  updated_by    uuid references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now()
);
create index if not exists department_rules_company_idx on public.department_rules(company_id);

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

    if k in ('require_geofence', 'require_gps', 'allow_kiosk', 'schedule_lateness',
             'allow_break_10', 'allow_break_30', 'allow_break_60', 'require_edit_note') then
      if jsonb_typeof(v) <> 'boolean' then raise exception '% must be true or false', k; end if;
    elsif k = 'early_clock_in_minutes' and v = 'false'::jsonb then
      null; -- no limit for this team, whatever the company sets
    elsif k in ('early_clock_in_minutes', 'late_grace_minutes', 'punch_round_minutes') then
      if jsonb_typeof(v) <> 'number' then raise exception '% must be a number', k; end if;
      n := (v #>> '{}')::numeric;
      if n <> trunc(n) or n < 0 then raise exception '% must be a whole number of minutes', k; end if;
      if k = 'early_clock_in_minutes' and n > 720 then raise exception 'early clock-in can be at most 720 minutes'; end if;
      if k = 'late_grace_minutes' and n > 240 then raise exception 'the grace period can be at most 240 minutes'; end if;
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

-- The earlier draft's late rule is gone; main's lateness keys replace it.
update public.department_rules
   set rules = rules - 'late_after_minutes'
 where rules ? 'late_after_minutes';

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
-- takes any user and company, so only security-definer functions call it.
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

-- Why a clock-in now would be too early, or null when it isn't. Only a
-- published shift that starts today (company time) and hasn't ended counts;
-- with none there is no limit. A clock-in after an earlier one for the same
-- shift (back from a split, say) is never too early.
create or replace function public.early_clock_in_error(_user uuid, _company uuid, _rules jsonb)
returns text language plpgsql stable security definer set search_path = public
as $$
declare
  tz text;
  st timestamptz;
  -- Only a number counts: null (company) and false (team) both mean no limit.
  early int := case when jsonb_typeof(_rules->'early_clock_in_minutes') = 'number'
                    then (_rules->>'early_clock_in_minutes')::numeric::int end;
begin
  if early is null then return null; end if;

  select coalesce(c.timezone, 'UTC') into tz from public.companies c where c.id = _company;
  tz := coalesce(tz, 'UTC');

  select s.starts_at into st
    from public.shifts s
   where s.employee_id = _user and s.company_id = _company and s.published
     and s.ends_at > now()
     and (s.starts_at at time zone tz)::date = (now() at time zone tz)::date
   order by s.starts_at
   limit 1;
  if st is null or now() >= st - make_interval(mins => early) then return null; end if;

  if exists (select 1 from public.time_punches p
              where p.user_id = _user and p.company_id = _company and p.kind = 'in'
                and p.at >= st - make_interval(mins => greatest(early, 120))) then
    return null;
  end if;

  return format('Too early to clock in: your shift starts at %s. You can clock in from %s.',
                to_char(st at time zone tz, 'FMHH12:MI AM'),
                to_char((st - make_interval(mins => early)) at time zone tz, 'FMHH12:MI AM'));
end; $$;
revoke all on function public.early_clock_in_error(uuid, uuid, jsonb) from public, anon, authenticated;

-- The earlier draft's combined early/late check.
drop function if exists public.clock_in_check(uuid, uuid, jsonb);

-- punch_late_minutes as in 20261125120000_schedule_lateness, with the rule and
-- grace read from the person's team rules over the company's.
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
  s := public.member_rules(_user, _company);
  if not coalesce((s->>'schedule_lateness')::boolean, false) then return null; end if;
  grace := greatest(0, coalesce((s->>'late_grace_minutes')::numeric::int, 5));

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
revoke all on function public.punch_late_minutes(uuid, uuid, timestamptz) from public, anon, authenticated;

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
-- 20261124120000_reconcile's version (multi-company + 7-day GPS grace) with
-- the team rules: member_rules(), require_gps, the early limit, and the late
-- notification.

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
  fence_on boolean;
  has_gps boolean := _lat is not null and _lng is not null;
  last_kind text;
  next_kind text;
  dist double precision;
  who text;
  grace_since timestamptz;
  days_left int;
  too_early text;
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
  fence_on := require_geo and c.latitude is not null and c.longitude is not null;

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
    -- A team that requires GPS gets no grace period.
    if not has_gps and coalesce((s->>'require_gps')::boolean, false) then
      raise exception 'Your team needs your GPS location to clock in. Turn on location and try again.';
    end if;
    too_early := public.early_clock_in_error(uid, cid, s);
    if too_early is not null then raise exception '%', too_early; end if;
  end if;

  -- The grace period belongs to the person, not the company: it is about
  -- whether their phone lets the app read location at all.
  if has_gps then
    -- Location works: whatever grace period was running is over.
    delete from public.gps_off_grace where user_id = uid;
  elsif fence_on and next_kind = 'in' then
    select since into grace_since from public.gps_off_grace where user_id = uid;
    if grace_since is null then
      grace_since := now();
      insert into public.gps_off_grace (user_id, company_id, since)
      values (uid, cid, grace_since)
      on conflict (user_id) do update set since = excluded.since, company_id = excluded.company_id;
    elsif now() >= grace_since + interval '7 days' then
      raise exception 'GPS_GRACE_EXPIRED: You will not be able to clock in until you authorize the proper location settings on your phone or tablet.';
    end if;
  end if;

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, accuracy_m, distance_m, within_geofence)
  values (uid, cid, next_kind, _lat, _lng, _accuracy, dist, has_gps)
  returning * into row;

  if row.kind = 'in' then
    perform public.notify_late_clock_in(uid, cid, public.punch_late_minutes(uid, cid, row.at));
  end if;

  -- No location while the company has a geofence: tell the admins.
  if not has_gps and fence_on then
    select coalesce(nullif(trim(full_name), ''), 'An employee') into who
      from public.profiles where id = uid;

    select since into grace_since from public.gps_off_grace where user_id = uid;
    days_left := case
                   when grace_since is null then null
                   else greatest(0, ceil(extract(epoch from (grace_since + interval '7 days' - now())) / 86400)::int)
                 end;

    insert into public.notifications (user_id, type, title, body, link)
    select distinct ur.user_id, 'punch_without_gps',
           case when next_kind = 'in' then 'Clock-in without GPS' else 'Clock-out without GPS' end,
           who || ' clocked ' || next_kind || ' with their GPS location turned off.'
             || case
                  when days_left is null then ''
                  else ' They have ' || days_left || ' day' || case when days_left = 1 then '' else 's' end
                       || ' left to turn it on before clock-in is blocked.'
                end,
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
-- 20261125120000_schedule_lateness's version (late_minutes in the reply) with
-- the team rules: member_rules(), allow_kiosk, the early limit, and the late
-- notification.

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
  too_early text;
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
      too_early := public.early_clock_in_error(uid, cid, s);
      if too_early is not null then
        return jsonb_build_object('ok', false, 'message', too_early);
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

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, distance_m, within_geofence, break_minutes)
  values (uid, cid, next_kind, c.latitude, c.longitude,
          case when c.latitude is not null then 0 else null end, true, bmin)
  returning * into row;

  if row.kind = 'in' then
    late := public.punch_late_minutes(uid, cid, row.at);
    perform public.notify_late_clock_in(uid, cid, late);
  end if;

  return jsonb_build_object('ok', true, 'name', r->>'name', 'kind', row.kind, 'at', row.at)
    || case when late is not null then jsonb_build_object('late_minutes', late) else '{}'::jsonb end;
end; $$;

-- The earlier draft stored lateness on the punch; it is worked out on read now.
alter table public.time_punches drop column if exists late_minutes;

commit;

notify pgrst, 'reload schema';
