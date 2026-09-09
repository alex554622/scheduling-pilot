-- clock_punch decided the next kind with:
--     case when last_kind = 'in' then 'out' else 'in' end
-- so after a break_end it emitted ANOTHER 'in' instead of 'out'.
--
-- The UI (src/routes/_authenticated/timeclock.tsx) derives status as
--     off     <=> no punches or last kind = 'out'
--     working <=> last kind in ('in','break_end')
-- and shows "Clock out" after a break. The employee therefore pressed Clock out,
-- got "Clocked out successfully", and the row written was 'in': the shift never
-- closed, hours over-counted, and Who's-In kept showing them on site.
--
-- Align the backend with that same state machine: on the clock unless the last
-- punch is 'out' (or there is none). break_start is included defensively -- the
-- UI blocks clocking out mid-break, but if it is reached, 'out' is correct.
-- Also carries the deterministic last-punch ordering from the previous migration.
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
  last_kind text;
  next_kind text;
  dist double precision;
  row public.time_punches;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if _lat is null or _lng is null then raise exception 'location required'; end if;

  select company_id into cid from public.profiles where id = uid;
  if cid is null then raise exception 'you must be a member of a company'; end if;

  select latitude, longitude, geofence_radius_m, settings
    into c
  from public.companies where id = cid;
  s := coalesce(c.settings, '{}'::jsonb);
  require_geo := coalesce((s->>'require_geofence')::boolean, true);

  if c.latitude is not null and c.longitude is not null then
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
  values (uid, cid, next_kind, _lat, _lng, _accuracy, dist, true)
  returning * into row;

  return row;
end;
$function$;
