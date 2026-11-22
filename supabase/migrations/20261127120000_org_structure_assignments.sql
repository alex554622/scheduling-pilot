-- Organization structure, assigned from Edit Member.
--
-- Settings → Organization keeps the company's locations, departments and
-- positions; Edit Member picks from them instead of typing a job title.
--
--   * locations, departments, positions get is_active. An inactive one can't
--     be newly given to anyone, but people who already have it keep it, and
--     old records still show it.
--   * department_positions: which positions belong to which department. A
--     department with none listed accepts every position, so nothing breaks
--     before an admin sets them up.
--   * departments.location_id: the site a department works out of.
--   * company_memberships.location_id: a person's primary work location. It is
--     also added to the places they may clock in (employee_locations).
--   * The position a person holds is company_memberships.position_id. Its
--     name is copied into the old free-text `position`, so every screen that
--     shows a job title shows the position. The scheduler's qualification
--     list (employee_positions) gets it as the primary row.
--
-- Checked in the database on every write, whichever screen or function makes
-- it: same company, active when newly picked, and the position allowed in the
-- department. Only company admins (and super admins) change these; a person
-- can no longer retype their own job title.
--
-- Existing assignments are carried over: a person with one qualified position
-- (or a primary one) gets it as their position, otherwise a job title that
-- matches a position's name does. Every department–position pair people hold
-- today is listed on the department, so nobody's current assignment becomes
-- invalid. Job titles that match no position stay as they were until an
-- admin picks a position.
--
-- Re-runnable. Applied by hand in Studio.

begin;

-- On a re-run, the checks below come back after the carry-over.
drop trigger if exists memberships_check_org on public.company_memberships;

-- ------------------------------------------------------------ columns ----

alter table public.locations   add column if not exists is_active boolean not null default true;
alter table public.departments add column if not exists is_active boolean not null default true;
alter table public.positions   add column if not exists is_active boolean not null default true;

alter table public.departments
  add column if not exists location_id uuid references public.locations(id) on delete set null;

alter table public.company_memberships
  add column if not exists location_id uuid references public.locations(id) on delete set null;

-- ------------------------------------------------ department_positions ----

create table if not exists public.department_positions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  position_id   uuid not null references public.positions(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (department_id, position_id)
);
create index if not exists department_positions_company_idx
  on public.department_positions (company_id);

alter table public.department_positions enable row level security;

drop policy if exists department_positions_view on public.department_positions;
create policy department_positions_view on public.department_positions for select to authenticated
  using (company_id = public.current_company_id()
         or public.has_role(auth.uid(), 'super_admin'::public.app_role));

drop policy if exists department_positions_admin_manage on public.department_positions;
create policy department_positions_admin_manage on public.department_positions for all to authenticated
  using (public.has_role(auth.uid(), 'super_admin'::public.app_role)
         or public.has_role(auth.uid(), 'company_admin'::public.app_role, company_id))
  with check (public.has_role(auth.uid(), 'super_admin'::public.app_role)
              or public.has_role(auth.uid(), 'company_admin'::public.app_role, company_id));

revoke all on public.department_positions from anon;
grant select, insert, delete on public.department_positions to authenticated;

-- Both ends must be in the row's company.
create or replace function public.department_positions_guard()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.departments
                  where id = new.department_id and company_id = new.company_id) then
    raise exception 'that department is not in this company';
  end if;
  if not exists (select 1 from public.positions
                  where id = new.position_id and company_id = new.company_id) then
    raise exception 'that position is not in this company';
  end if;
  return new;
end; $$;

drop trigger if exists department_positions_guard on public.department_positions;
create trigger department_positions_guard
  before insert or update on public.department_positions
  for each row execute function public.department_positions_guard();

-- A department's location must be one of the company's.
create or replace function public.departments_location_guard()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.location_id is not null
     and new.location_id is distinct from (case when tg_op = 'UPDATE' then old.location_id end)
     and not exists (select 1 from public.locations
                      where id = new.location_id and company_id = new.company_id and is_active) then
    raise exception 'pick an active location of this company';
  end if;
  return new;
end; $$;

drop trigger if exists departments_location_guard on public.departments;
create trigger departments_location_guard
  before insert or update on public.departments
  for each row execute function public.departments_location_guard();

-- ------------------------------------------------- carry over today's ----

-- One qualified position, or a primary one, becomes the position.
update public.company_memberships m
   set position_id = pick.position_id
  from (
    select ep.employee_id, ep.company_id,
           coalesce(
             (array_agg(ep.position_id) filter (where ep.is_primary))[1],
             case when count(*) = 1 then (array_agg(ep.position_id))[1] end
           ) as position_id
      from public.employee_positions ep
      join public.positions p on p.id = ep.position_id and p.company_id = ep.company_id
     group by ep.employee_id, ep.company_id
  ) pick
 where m.position_id is null
   and pick.position_id is not null
   and m.user_id = pick.employee_id
   and m.company_id = pick.company_id;

-- Otherwise a job title that matches a position's name.
update public.company_memberships m
   set position_id = p.id
  from public.positions p
 where m.position_id is null
   and m.position is not null
   and p.company_id = m.company_id
   and lower(btrim(p.name)) = lower(btrim(m.position));

-- Shown job title follows the position.
update public.company_memberships m
   set position = p.name
  from public.positions p
 where p.id = m.position_id
   and m.position is distinct from p.name;

-- Every department–position pair held today stays valid.
insert into public.department_positions (company_id, department_id, position_id)
select distinct m.company_id, m.department_id, m.position_id
  from public.company_memberships m
  join public.departments d on d.id = m.department_id and d.company_id = m.company_id
  join public.positions p on p.id = m.position_id and p.company_id = m.company_id
 where m.department_id is not null and m.position_id is not null
on conflict (department_id, position_id) do nothing;

-- The scheduler's qualification list knows each person's position.
insert into public.employee_positions (company_id, employee_id, position_id, is_primary)
select m.company_id, m.user_id, m.position_id, true
  from public.company_memberships m
 where m.position_id is not null
on conflict (employee_id, position_id) do update set is_primary = true;

update public.employee_positions ep
   set is_primary = false
  from public.company_memberships m
 where m.user_id = ep.employee_id and m.company_id = ep.company_id
   and ep.is_primary and ep.position_id is distinct from m.position_id;

-- ------------------------------------------- checks on every membership ----

create or replace function public.memberships_check_org()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  is_new boolean := tg_op = 'INSERT';
  pname text;
begin
  -- Department.
  if new.department_id is not null
     and (is_new or new.department_id is distinct from old.department_id) then
    if not exists (select 1 from public.departments
                    where id = new.department_id and company_id = new.company_id and is_active) then
      raise exception 'pick an active department of this company';
    end if;
  end if;

  -- Position, and its name as the shown job title.
  if new.position_id is not null then
    select name into pname from public.positions
     where id = new.position_id and company_id = new.company_id
       and (is_active or (not is_new and new.position_id = old.position_id));
    if pname is null then
      raise exception 'pick an active position of this company';
    end if;
    new.position := pname;
  elsif not is_new and old.position_id is not null then
    -- Position cleared: the copied name goes with it.
    new.position := null;
  end if;

  -- The position must belong to the department, when the department lists any.
  if new.position_id is not null and new.department_id is not null
     and (is_new
          or new.department_id is distinct from old.department_id
          or new.position_id is distinct from old.position_id)
     and exists (select 1 from public.department_positions dp
                  where dp.department_id = new.department_id)
     and not exists (select 1 from public.department_positions dp
                      where dp.department_id = new.department_id
                        and dp.position_id = new.position_id) then
    raise exception 'that position is not part of this department — pick a position from the department';
  end if;

  -- Work location.
  if new.location_id is not null
     and (is_new or new.location_id is distinct from old.location_id) then
    if not exists (select 1 from public.locations
                    where id = new.location_id and company_id = new.company_id and is_active) then
      raise exception 'pick an active location of this company';
    end if;
  end if;

  return new;
end; $$;

drop trigger if exists memberships_check_org on public.company_memberships;
create trigger memberships_check_org
  before insert or update of department_id, position_id, position, location_id
  on public.company_memberships
  for each row execute function public.memberships_check_org();

-- After a change: the position becomes the primary qualification, and the
-- work location one of the places they clock in.
create or replace function public.memberships_sync_org()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.position_id is not null
     and (tg_op = 'INSERT' or new.position_id is distinct from old.position_id) then
    update public.employee_positions
       set is_primary = false
     where employee_id = new.user_id and company_id = new.company_id
       and position_id <> new.position_id and is_primary;
    insert into public.employee_positions (company_id, employee_id, position_id, is_primary)
    values (new.company_id, new.user_id, new.position_id, true)
    on conflict (employee_id, position_id) do update set is_primary = true;
  end if;

  if new.location_id is not null
     and (tg_op = 'INSERT' or new.location_id is distinct from old.location_id)
     and not exists (select 1 from public.employee_locations
                      where employee_id = new.user_id and company_id = new.company_id
                        and location_id = new.location_id) then
    insert into public.employee_locations (company_id, employee_id, location_id)
    values (new.company_id, new.user_id, new.location_id);
  end if;
  return null;
end; $$;

drop trigger if exists memberships_sync_org on public.company_memberships;
create trigger memberships_sync_org
  after insert or update of position_id, location_id on public.company_memberships
  for each row execute function public.memberships_sync_org();

-- Renaming a position renames the job title of everyone who holds it.
create or replace function public.positions_rename_members()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.name is distinct from old.name then
    update public.company_memberships
       set position = new.name
     where position_id = new.id and company_id = new.company_id;
  end if;
  return null;
end; $$;

drop trigger if exists positions_rename_members on public.positions;
create trigger positions_rename_members
  after update of name on public.positions
  for each row execute function public.positions_rename_members();

-- --------------------------------------------- members view and edits ----

-- Same view, with the work location added at the end.
create or replace view public.company_members as
select m.user_id        as id,
       m.company_id,
       p.full_name,
       p.phone,
       m.position,
       m.position_id,
       m.department_id,
       m.employee_code,
       m.max_weekly_hours,
       m.is_active,
       m.status,
       m.joined_at,
       p.created_at,
       m.location_id
  from public.company_memberships m
  join public.profiles p on p.id = m.user_id
 where m.status = 'active'
   and (m.company_id = public.current_company_id()
        or public.has_role(auth.uid(), 'super_admin'::public.app_role));

revoke all on public.company_members from anon;
grant select, update on public.company_members to authenticated;

-- Edits through the view: name and phone go to the profile, the rest to the
-- membership. Department, position and work location are admins' only; the
-- checks above run on the membership write.
create or replace function public.company_members_update()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  admin boolean := public.has_role(auth.uid(), 'company_admin'::public.app_role, old.company_id)
                   or public.has_role(auth.uid(), 'super_admin'::public.app_role);
  self boolean := old.id = auth.uid();
begin
  if not (admin or self) then raise exception 'not authorized'; end if;
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id then
    raise exception 'a membership cannot be moved';
  end if;

  if new.full_name is distinct from old.full_name or new.phone is distinct from old.phone then
    update public.profiles
       set full_name = coalesce(new.full_name, full_name),
           phone = case when admin then new.phone else phone end
     where id = old.id;
  end if;

  if admin then
    update public.company_memberships
       set position = case when new.position_id is null then new.position else position end,
           position_id = new.position_id,
           department_id = new.department_id,
           location_id = new.location_id,
           employee_code = new.employee_code,
           max_weekly_hours = coalesce(new.max_weekly_hours, max_weekly_hours),
           is_active = coalesce(new.is_active, is_active)
     where user_id = old.id and company_id = old.company_id;
  elsif new.position is distinct from old.position
     or new.position_id is distinct from old.position_id
     or new.department_id is distinct from old.department_id
     or new.location_id is distinct from old.location_id then
    raise exception 'only an admin can change a position, department or work location';
  end if;
  return new;
end; $$;

drop trigger if exists company_members_update on public.company_members;
create trigger company_members_update
  instead of update on public.company_members
  for each row execute function public.company_members_update();

-- A person used to retype their own job title from My account (profiles →
-- membership mirror). That now belongs to admins: the mirror keeps an
-- admin's change and drops anyone else's.
create or replace function public.profiles_block_self_position()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if (new.position is distinct from old.position or new.position_id is distinct from old.position_id
      or new.department_id is distinct from old.department_id)
     -- No signed-in user (Studio, server jobs) counts as an admin, as in the mirror.
     and not (auth.uid() is null
              or public.has_role(auth.uid(), 'company_admin'::public.app_role, old.company_id)
              or public.has_role(auth.uid(), 'super_admin'::public.app_role)) then
    new.position := old.position;
    new.position_id := old.position_id;
    new.department_id := old.department_id;
  end if;
  return new;
end; $$;

drop trigger if exists profiles_block_self_position on public.profiles;
-- Runs before profiles_membership_mirror (triggers fire in name order).
create trigger profiles_block_self_position
  before update on public.profiles
  for each row execute function public.profiles_block_self_position();

commit;

notify pgrst, 'reload schema';
