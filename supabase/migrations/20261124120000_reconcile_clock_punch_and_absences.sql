-- Reconcile two sets of migrations written side by side.
--
-- 20261122120000_multi_company_memberships and
-- 20261122130000_multi_company_supervisor_scope made clock-in and absences
-- multi-company aware. In parallel, 20261120140000_manager_absences and
-- 20261121120000_gps_grace_period redefined the same functions from the
-- single-company versions. Whichever was applied last is live, so production
-- may have lost the multi-company rules or the 7-day GPS grace period.
--
-- This redefines all three functions with both sets of changes:
--
--   clock_punch            multi-company version (punch into the active
--                          company, last punch looked up within it, alerts only
--                          to that company's active admins) + the 7-day GPS
--                          grace period.
--   manager_record_absence multi-company / supervisor version, unchanged.
--   manager_remove_absence multi-company / supervisor version, unchanged.
--
-- Safe to run whatever state the database is in, and re-runnable. Applied by
-- hand in Studio (the CLI is not linked to the self-hosted instance).

begin;

-- Stop here, changing nothing, if the multi-company migrations are not live:
-- the functions below call these helpers.
do $$
begin
  if to_regprocedure('public.current_company_id()') is null
     or to_regprocedure('public.member_company(uuid)') is null
     or to_regprocedure('public.can_approve_time_off(uuid, uuid)') is null
     or to_regclass('public.company_memberships') is null
     or to_regclass('public.gps_off_grace') is null then
    raise exception 'multi-company or GPS grace migrations are missing; apply those first';
  end if;
end;
$$;

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
  row public.time_punches;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  cid := public.current_company_id();
  if cid is null then raise exception 'you must be a member of a company'; end if;

  select latitude, longitude, geofence_radius_m, settings
    into c
  from public.companies where id = cid;
  s := coalesce(c.settings, '{}'::jsonb);
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

create or replace function public.manager_record_absence(
  _employee uuid,
  _kind text,
  _start date,
  _end date,
  _note text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid;
  tz text;
  new_id uuid;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _kind not in ('vacation', 'sick', 'family_leave', 'personal', 'other') then
    raise exception 'unknown absence type: %', _kind;
  end if;
  if _start is null or _end is null or _end < _start then
    raise exception 'the last day cannot be before the first';
  end if;
  if _end - _start > 366 then raise exception 'an absence can run at most a year'; end if;

  cid := public.member_company(_employee);
  if cid is null then raise exception 'that person is not in a company'; end if;
  if not (public.is_company_manager(caller, cid)
          or public.can_approve_time_off(caller, _employee)) then
    raise exception 'not authorized';
  end if;

  insert into public.time_off_requests (company_id, employee_id, kind, start_date, end_date, status, note)
  values (cid, _employee, _kind, _start, _end, 'approved', nullif(trim(coalesce(_note, '')), ''))
  returning id into new_id;

  select coalesce(c.timezone, 'UTC') into tz from public.companies c where c.id = cid;
  update public.shifts sh
     set employee_id = null
   where sh.employee_id = _employee
     and sh.company_id = cid
     and sh.ends_at > now()
     and (sh.starts_at at time zone tz)::date <= _end
     and (sh.ends_at   at time zone tz)::date >= _start;

  return new_id;
end;
$$;

create or replace function public.manager_remove_absence(_request uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  r public.time_off_requests;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  select * into r from public.time_off_requests where id = _request for update;
  if not found then raise exception 'absence not found'; end if;
  if not (public.is_company_manager(caller, r.company_id)
          or (r.company_id = public.current_company_id()
              and public.can_approve_time_off(caller, r.employee_id))) then
    raise exception 'not authorized';
  end if;
  if r.status not in ('approved', 'pending') then raise exception 'this absence is already withdrawn'; end if;
  update public.time_off_requests set status = 'cancelled' where id = _request;
end;
$$;

-- create or replace keeps existing grants; these just restate the absence ones.
revoke all on function public.manager_record_absence(uuid, text, date, date, text) from public, anon;
revoke all on function public.manager_remove_absence(uuid) from public, anon;
grant execute on function public.manager_record_absence(uuid, text, date, date, text) to authenticated;
grant execute on function public.manager_remove_absence(uuid) to authenticated;

commit;

notify pgrst, 'reload schema';

-- Check afterwards (both should return true):
--   select prosrc like '%current_company_id()%' and prosrc like '%gps_off_grace%'
--     from pg_proc where oid = 'public.clock_punch(double precision, double precision, double precision)'::regprocedure;
--   select prosrc like '%can_approve_time_off%'
--     from pg_proc where oid = 'public.manager_record_absence(uuid, text, date, date, text)'::regprocedure;
