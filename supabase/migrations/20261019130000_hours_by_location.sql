-- Hours by location.
--
-- A company already keeps a list of locations (Organization → Locations), and
-- shifts already carry one. Two things were missing for hours to be split by
-- place: which locations each person works at, and which location each stretch
-- on the clock belongs to.
--
--   * `employee_locations` — the locations a person works at, ticked on their
--     Edit member dialog, the same way qualified positions are.
--   * `time_punches.location_id` — filled in by a trigger as each punch lands,
--     so the phone time clock, the shared clock-in screen and a manager's
--     correction all get one without each of them having to ask.
--
-- A clock-in takes its location from, in order:
--   1. the shift they are scheduled on (one starting within two hours, or
--      already under way) when that shift names a location;
--   2. the location whose map pin they are standing at — among the ones they
--      are assigned to, or every company location when they have none;
--   3. their only location, when they have exactly one (or the company has
--      exactly one).
-- Otherwise it is left empty and counted as "No location". Breaks and the
-- clock-out belong to the clock-in before them, so they copy its location: a
-- stretch is never split between two places.
--
-- `set_punch_location` changes a stretch's location afterwards: a manager for
-- anyone, an employee only for the stretch they are on now.
--
-- Re-runnable; applied by hand in Studio.

-- ---- who works where ----

create table if not exists public.employee_locations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references auth.users(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (employee_id, location_id)
);
create index if not exists employee_locations_company_idx on public.employee_locations(company_id);
create index if not exists employee_locations_employee_idx on public.employee_locations(employee_id);
alter table public.employee_locations enable row level security;

drop policy if exists employee_locations_view on public.employee_locations;
create policy employee_locations_view on public.employee_locations for select to authenticated
  using (company_id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));

drop policy if exists employee_locations_manage on public.employee_locations;
create policy employee_locations_manage on public.employee_locations for all to authenticated
  using (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id))
  with check (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id));

grant select, insert, update, delete on public.employee_locations to authenticated;
grant all on public.employee_locations to service_role;

-- ---- where each punch was worked ----

alter table public.time_punches
  add column if not exists location_id uuid references public.locations(id) on delete set null;
create index if not exists time_punches_location_idx on public.time_punches(location_id);

-- The location a clock-in at this time and place belongs to — see the rules at
-- the top. Null when none of them settles it.
create or replace function public.resolve_punch_location(
  _user uuid, _company uuid, _at timestamptz, _lat double precision, _lng double precision
)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  loc uuid;
  assigned int;
begin
  -- 1. The shift they are working.
  select s.location_id into loc
    from public.shifts s
    join public.locations l on l.id = s.location_id and l.company_id = _company
   where s.employee_id = _user
     and s.company_id = _company
     and _at >= s.starts_at - interval '2 hours'
     and _at < s.ends_at
   order by s.published desc, abs(extract(epoch from s.starts_at - _at))
   limit 1;
  if loc is not null then return loc; end if;

  select count(*) into assigned
    from public.employee_locations el
    join public.locations l on l.id = el.location_id and l.company_id = _company
   where el.employee_id = _user;

  -- 2. The pin they are standing at.
  if _lat is not null and _lng is not null then
    select l.id into loc
      from public.locations l
     where l.company_id = _company
       and l.latitude is not null and l.longitude is not null
       and (assigned = 0 or exists (select 1 from public.employee_locations el
                                     where el.employee_id = _user and el.location_id = l.id))
       and public.haversine_m(l.latitude, l.longitude, _lat, _lng) <= coalesce(l.geofence_radius_m, 200)
     order by public.haversine_m(l.latitude, l.longitude, _lat, _lng)
     limit 1;
    if loc is not null then return loc; end if;
  end if;

  -- 3. The only place it could be.
  if assigned = 1 then
    select el.location_id into loc
      from public.employee_locations el
      join public.locations l on l.id = el.location_id and l.company_id = _company
     where el.employee_id = _user;
    return loc;
  end if;
  if assigned = 0 and (select count(*) from public.locations where company_id = _company) = 1 then
    select id into loc from public.locations where company_id = _company;
    return loc;
  end if;

  return null;
end; $$;

revoke all on function public.resolve_punch_location(uuid, uuid, timestamptz, double precision, double precision)
  from public, anon, authenticated;

-- The location of the clock-in a break or clock-out belongs to. Same 24-hour
-- reach as the timecard's MAX_SHIFT_MS.
create or replace function public.stretch_location(_user uuid, _at timestamptz)
returns uuid
language sql stable security definer set search_path = public
as $$
  select p.location_id
    from public.time_punches p
   where p.user_id = _user
     and p.kind = 'in'
     and p.at <= _at
     and p.at > _at - interval '24 hours'
   order by p.at desc, p.created_at desc, p.id desc
   limit 1;
$$;

revoke all on function public.stretch_location(uuid, timestamptz) from public, anon, authenticated;

create or replace function public.set_punch_location_on_insert()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.location_id is not null then return new; end if;
  if new.kind = 'in' then
    new.location_id := public.resolve_punch_location(
      new.user_id, new.company_id, new.at, new.latitude, new.longitude);
  else
    new.location_id := public.stretch_location(new.user_id, new.at);
  end if;
  return new;
end; $$;

revoke all on function public.set_punch_location_on_insert() from public, anon, authenticated;

-- The break reminder (20260922120000) re-files itself on every UPDATE of a
-- punch. Filling in or moving a location is not a change to the break, and on
-- an old break_start it would queue a "two minutes left" for a break that ended
-- long ago — so it now listens only to the columns a break is made of. This
-- has to run before the backfill below.
drop trigger if exists trg_push_for_break on public.time_punches;
create trigger trg_push_for_break
after insert or update of user_id, kind, at, break_minutes or delete on public.time_punches
for each row execute function public.push_for_break();

drop trigger if exists trg_set_punch_location on public.time_punches;
create trigger trg_set_punch_location
before insert on public.time_punches
for each row execute function public.set_punch_location_on_insert();

-- Punches from before this existed: clock-ins first, then everything that
-- follows them. Only rows still empty are touched, so running this again
-- changes nothing a manager has set.
update public.time_punches p
   set location_id = public.resolve_punch_location(p.user_id, p.company_id, p.at, p.latitude, p.longitude)
 where p.kind = 'in' and p.location_id is null;

update public.time_punches p
   set location_id = public.stretch_location(p.user_id, p.at)
 where p.kind <> 'in' and p.location_id is null;

-- ---- changing it afterwards ----

-- Moves one stretch (a clock-in and the breaks and clock-out after it) to
-- another location, or to none. A manager can do this for anyone in their
-- company. An employee can only move the stretch they are on right now, and
-- only to a location they work at.
create or replace function public.set_punch_location(_punch uuid, _location uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  p public.time_punches;
  manager boolean;
  next_in timestamptz;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into p from public.time_punches where id = _punch;
  if p.id is null then raise exception 'punch not found'; end if;
  if p.kind <> 'in' then raise exception 'pick the clock-in of the stretch to move'; end if;

  manager := public.has_role(uid, 'super_admin')
             or public.has_role(uid, 'company_admin', p.company_id);

  if _location is not null and not exists (
    select 1 from public.locations where id = _location and company_id = p.company_id
  ) then
    raise exception 'that location is not in this company';
  end if;

  if not manager then
    if p.user_id <> uid then raise exception 'you can only change your own time'; end if;
    if _location is null then raise exception 'pick a location'; end if;
    -- Only the stretch they are on now: their latest clock-in, not yet closed.
    if exists (
      select 1 from public.time_punches q
       where q.user_id = uid
         and (q.at, q.created_at, q.id) > (p.at, p.created_at, p.id)
         and q.kind in ('in', 'out')
    ) then
      raise exception 'only a manager can change a finished shift';
    end if;
    if exists (select 1 from public.employee_locations where employee_id = uid)
       and not exists (select 1 from public.employee_locations
                        where employee_id = uid and location_id = _location) then
      raise exception 'you are not set up to work at that location';
    end if;
  end if;

  select q.at into next_in
    from public.time_punches q
   where q.user_id = p.user_id and q.kind = 'in' and q.at > p.at
   order by q.at
   limit 1;

  update public.time_punches q
     set location_id = _location
   where q.user_id = p.user_id
     and (q.id = p.id
          or (q.kind <> 'in' and q.at >= p.at
              and q.at < coalesce(next_in, p.at + interval '24 hours')));
end; $$;

revoke all on function public.set_punch_location(uuid, uuid) from public, anon;
grant execute on function public.set_punch_location(uuid, uuid) to authenticated;
