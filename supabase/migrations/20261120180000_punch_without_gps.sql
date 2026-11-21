-- Someone whose phone has location turned off (or denied to the app) could not
-- clock in at all while a geofence was set: the page waited forever for a GPS
-- fix and clock_punch raised 'location required'. People were left standing at
-- the door unable to start their shift.
--
-- Now a punch without GPS goes through. It is stored with no coordinates and
-- within_geofence = false, so the timecard flags it the same way it flags an
-- off-site punch, and every admin of the company gets a notification (which
-- the push trigger on notifications carries to their phone) saying that this
-- person clocked in/out with their GPS off.
--
-- A punch WITH a GPS fix is checked against the geofence exactly as before:
-- being able to read the location and being outside the fence still blocks.
-- Breaks take the same rule so a person who clocked in without GPS can still
-- take and end a break; those don't notify, the clock-in already did.

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
  row public.time_punches;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select company_id into cid from public.profiles where id = uid;
  if cid is null then raise exception 'you must be a member of a company'; end if;

  select latitude, longitude, geofence_radius_m, settings
    into c
  from public.companies where id = cid;
  s := coalesce(c.settings, '{}'::jsonb);
  require_geo := coalesce((s->>'require_geofence')::boolean, true);

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
    where user_id = uid
    order by at desc, created_at desc, id desc
    limit 1;

  -- on the clock unless there is no punch yet, or the last one was 'out'
  next_kind := case
                 when last_kind is null or last_kind = 'out' then 'in'
                 else 'out'
               end;

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, accuracy_m, distance_m, within_geofence)
  values (uid, cid, next_kind, _lat, _lng, _accuracy, dist, has_gps)
  returning * into row;

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
     where ur.company_id = cid
       and ur.role = 'company_admin'::public.app_role
       and ur.user_id <> uid
       and public.wants_notification(ur.user_id, 'punch_without_gps');
  end if;

  return row;
end;
$function$;

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

  select company_id into cid from public.profiles where id = uid;
  if cid is null then raise exception 'you must be a member of a company'; end if;

  select latitude, longitude, geofence_radius_m, settings into c from public.companies where id = cid;
  s := coalesce(c.settings, '{}'::jsonb);
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
    where user_id = uid
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
