-- clock_punch/break_punch decide the next punch kind from "the last punch", found
-- with `order by at desc limit 1`. That has no tiebreaker, so when two punches
-- share an `at` the winner is arbitrary and the in/out state machine can flip
-- incoherently (e.g. allowing a break while clocked out).
--
-- Reachable in production: manager_insert_punch lets a manager set `at` by hand,
-- so a correction can collide exactly with an existing punch.
--
-- Fix: break ties on created_at, then id, so "last punch" is totally ordered.
-- (clock_punch is redefined again in the next migration; break_punch is final here.)
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
  allow10 boolean; allow30 boolean; allow60 boolean;
  last_kind text;
  last_break_minutes int;
  next_kind text;
  dist double precision;
  row public.time_punches;
  bmin int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if _lat is null or _lng is null then raise exception 'location required'; end if;

  select company_id into cid from public.profiles where id = uid;
  if cid is null then raise exception 'you must be a member of a company'; end if;

  select latitude, longitude, geofence_radius_m, settings into c from public.companies where id = cid;
  s := coalesce(c.settings, '{}'::jsonb);
  require_geo := coalesce((s->>'require_geofence')::boolean, true);
  allow10 := coalesce((s->>'allow_break_10')::boolean, true);
  allow30 := coalesce((s->>'allow_break_30')::boolean, true);
  allow60 := coalesce((s->>'allow_break_60')::boolean, true);

  if c.latitude is not null and c.longitude is not null then
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
  values (uid, cid, next_kind, _lat, _lng, _accuracy, dist, true, bmin)
  returning * into row;
  return row;
end;
$function$;
