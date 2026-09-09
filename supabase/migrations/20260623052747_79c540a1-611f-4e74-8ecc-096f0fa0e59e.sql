
-- Relax kind check to support breaks
alter table public.time_punches drop constraint if exists time_punches_kind_check;
alter table public.time_punches add constraint time_punches_kind_check
  check (kind in ('in','out','break_start','break_end'));

-- break_punch RPC: toggles between break_start and break_end; requires the
-- user to currently be clocked in.
create or replace function public.break_punch(_lat double precision, _lng double precision, _accuracy double precision default null)
returns public.time_punches
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  c record;
  last_kind text;
  next_kind text;
  dist double precision;
  row public.time_punches;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if _lat is null or _lng is null then raise exception 'location required'; end if;

  select company_id into cid from public.profiles where id = uid;
  if cid is null then raise exception 'you must be a member of a company'; end if;

  select latitude, longitude, geofence_radius_m into c from public.companies where id = cid;
  if c.latitude is not null and c.longitude is not null then
    dist := public.haversine_m(c.latitude, c.longitude, _lat, _lng);
    if dist > coalesce(c.geofence_radius_m, 200) then
      raise exception 'You are % meters from the worksite (allowed: %m).',
        round(dist)::int, c.geofence_radius_m;
    end if;
  end if;

  select kind into last_kind from public.time_punches
    where user_id = uid order by at desc limit 1;

  if last_kind is null or last_kind = 'out' then
    raise exception 'You need to clock in before starting a break.';
  end if;

  next_kind := case when last_kind = 'break_start' then 'break_end' else 'break_start' end;

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, accuracy_m, distance_m, within_geofence)
  values (uid, cid, next_kind, _lat, _lng, _accuracy, dist, true)
  returning * into row;
  return row;
end;
$$;

revoke all on function public.break_punch(double precision, double precision, double precision) from public;
grant execute on function public.break_punch(double precision, double precision, double precision) to authenticated;

-- Realtime for the live board
alter publication supabase_realtime add table public.time_punches;
