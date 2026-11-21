-- Clocking in with GPS off (20261120180000_punch_without_gps) was allowed with
-- no end date. Now it is a grace period: from the first clock-in without GPS a
-- person has 7 days to give the app location permission. After that, while the
-- company has a geofence set, Clock IN is refused until they do. Clock-out is
-- never refused, so nobody is left stuck on the clock.
--
-- The clock starts on the first clock-in without GPS and is cleared by any
-- clock-in/out that does carry a location — that proves permission is on. If
-- they turn it off again later, a new 7 days starts from that next clock-in.
--
-- Kept in its own table rather than on profiles: people can update their own
-- profile row, and they must not be able to reset their own deadline. Only
-- clock_punch (security definer) writes here; the person can read their own row
-- so the time clock can show how many days are left.

create table if not exists public.gps_off_grace (
  user_id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  since timestamptz not null default now()
);

alter table public.gps_off_grace enable row level security;

drop policy if exists "read own gps grace" on public.gps_off_grace;
create policy "read own gps grace" on public.gps_off_grace
  for select to authenticated
  using (user_id = auth.uid());

grant select on public.gps_off_grace to authenticated;

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

  select company_id into cid from public.profiles where id = uid;
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
    where user_id = uid
    order by at desc, created_at desc, id desc
    limit 1;

  -- on the clock unless there is no punch yet, or the last one was 'out'
  next_kind := case
                 when last_kind is null or last_kind = 'out' then 'in'
                 else 'out'
               end;

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
     where ur.company_id = cid
       and ur.role = 'company_admin'::public.app_role
       and ur.user_id <> uid
       and public.wants_notification(ur.user_id, 'punch_without_gps');
  end if;

  return row;
end;
$function$;
