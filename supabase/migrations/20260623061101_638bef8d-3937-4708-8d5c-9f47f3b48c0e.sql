CREATE OR REPLACE FUNCTION public.clock_punch(_lat double precision, _lng double precision, _accuracy double precision DEFAULT NULL::double precision)
 RETURNS time_punches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    where user_id = uid order by at desc limit 1;
  next_kind := case when last_kind = 'in' then 'out' else 'in' end;

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, accuracy_m, distance_m, within_geofence)
  values (uid, cid, next_kind, _lat, _lng, _accuracy, dist, true)
  returning * into row;

  return row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.break_punch(_lat double precision, _lng double precision, _accuracy double precision DEFAULT NULL::double precision, _minutes integer DEFAULT NULL::integer)
 RETURNS time_punches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    where user_id = uid order by at desc limit 1;

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