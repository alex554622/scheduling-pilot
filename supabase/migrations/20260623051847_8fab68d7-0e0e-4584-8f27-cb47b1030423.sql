
-- 1) Company location & geofence
alter table public.companies
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists geofence_radius_m integer not null default 200;

-- 2) time_punches table
create table if not exists public.time_punches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('in','out')),
  at timestamptz not null default now(),
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  distance_m double precision,
  within_geofence boolean not null default true,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists time_punches_user_at_idx on public.time_punches(user_id, at desc);
create index if not exists time_punches_company_at_idx on public.time_punches(company_id, at desc);

grant select, insert on public.time_punches to authenticated;
grant all on public.time_punches to service_role;

alter table public.time_punches enable row level security;

create policy "punch_select_self_or_mgr" on public.time_punches
  for select to authenticated
  using (
    user_id = auth.uid()
    or (company_id = public.current_company_id()
        and (public.has_role(auth.uid(), 'company_admin'::app_role, company_id)
             or public.has_role(auth.uid(), 'supervisor'::app_role, company_id)))
    or public.has_role(auth.uid(), 'super_admin'::app_role)
  );

create policy "punch_insert_self" on public.time_punches
  for insert to authenticated
  with check (user_id = auth.uid() and company_id = public.current_company_id());

-- 3) Haversine distance helper (meters)
create or replace function public.haversine_m(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision)
returns double precision
language sql immutable
as $$
  select 2 * 6371000 * asin(sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2
    + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2) ^ 2
  ))
$$;

-- 4) clock_punch RPC: validates geofence, alternates in/out, inserts row
create or replace function public.clock_punch(_lat double precision, _lng double precision, _accuracy double precision default null)
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
  within bool := true;
  row public.time_punches;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if _lat is null or _lng is null then raise exception 'location required'; end if;

  select company_id into cid from public.profiles where id = uid;
  if cid is null then raise exception 'you must be a member of a company'; end if;

  select latitude, longitude, geofence_radius_m into c
  from public.companies where id = cid;

  if c.latitude is not null and c.longitude is not null then
    dist := public.haversine_m(c.latitude, c.longitude, _lat, _lng);
    if dist > coalesce(c.geofence_radius_m, 200) then
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
  values (uid, cid, next_kind, _lat, _lng, _accuracy, dist, within)
  returning * into row;

  return row;
end;
$$;

revoke all on function public.clock_punch(double precision, double precision, double precision) from public;
grant execute on function public.clock_punch(double precision, double precision, double precision) to authenticated;

-- 5) set_company_location RPC (admins only)
create or replace function public.set_company_location(_lat double precision, _lng double precision, _radius integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select company_id into cid from public.profiles where id = uid;
  if cid is null then raise exception 'no company'; end if;
  if not (public.has_role(uid, 'company_admin'::app_role, cid)
          or public.has_role(uid, 'super_admin'::app_role)) then
    raise exception 'not authorized';
  end if;
  if _radius is null or _radius < 25 or _radius > 5000 then
    raise exception 'radius must be between 25 and 5000 meters';
  end if;
  update public.companies
    set latitude = _lat, longitude = _lng, geofence_radius_m = _radius
    where id = cid;
end;
$$;

revoke all on function public.set_company_location(double precision, double precision, integer) from public;
grant execute on function public.set_company_location(double precision, double precision, integer) to authenticated;
