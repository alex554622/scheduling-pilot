-- Supervisors currently manage their whole company. This narrows them to named
-- departments and/or locations.
--
-- Opt-in by design: a supervisor with NO scope rows keeps company-wide reach, so
-- every existing supervisor behaves exactly as before. Adding even one row
-- switches them to scoped, and from then on anything outside those departments
-- (including rows with no department set) is out of reach.
--
-- A scope row leaves department_id or location_id null to mean "any", so you can
-- scope by department, by site, or by a specific department at a specific site.
create table public.supervisor_scopes (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  supervisor_id uuid not null references auth.users(id) on delete cascade,
  department_id uuid references public.departments(id) on delete cascade,
  location_id   uuid references public.locations(id) on delete cascade,
  created_at    timestamptz not null default now(),
  check (department_id is not null or location_id is not null)
);

create unique index supervisor_scopes_unique
  on public.supervisor_scopes (supervisor_id, department_id, location_id) nulls not distinct;
create index supervisor_scopes_company_idx on public.supervisor_scopes (company_id);

alter table public.supervisor_scopes enable row level security;

create policy "scopes_view" on public.supervisor_scopes for select to authenticated
  using (company_id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));
create policy "scopes_admin_manage" on public.supervisor_scopes for all to authenticated
  using (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id))
  with check (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id));

-- Central scope test. Granted to authenticated because RLS policies below name
-- it, and a policy can only call functions the querying role may execute --
-- the same trap that produced the anon/pricing_plans 401 earlier.
create or replace function public.can_manage_scope(
  _user uuid, _company uuid, _department uuid, _location uuid
)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    public.has_role(_user, 'super_admin')
    or public.has_role(_user, 'company_admin', _company)
    or (
      public.has_role(_user, 'supervisor', _company)
      and (
        -- unscoped supervisor: whole company, as before
        not exists (
          select 1 from public.supervisor_scopes s
          where s.supervisor_id = _user and s.company_id = _company
        )
        or exists (
          select 1 from public.supervisor_scopes s
          where s.supervisor_id = _user
            and s.company_id = _company
            and (s.department_id is null or s.department_id = _department)
            and (s.location_id   is null or s.location_id   = _location)
        )
      )
    );
$$;
revoke all on function public.can_manage_scope(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.can_manage_scope(uuid, uuid, uuid, uuid) to authenticated;

-- Convenience for the UI and for time-off scoping: can _user manage _employee?
create or replace function public.can_manage_employee(_user uuid, _employee uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.can_manage_scope(_user, p.company_id, p.department_id, null)
  from public.profiles p
  where p.id = _employee;
$$;
revoke all on function public.can_manage_employee(uuid, uuid) from public, anon;
grant execute on function public.can_manage_employee(uuid, uuid) to authenticated;

-- ---- apply the scope to the tables supervisors actually write ----

drop policy "shifts_manage" on public.shifts;
create policy "shifts_manage" on public.shifts for all to authenticated
  using (public.can_manage_scope(auth.uid(), company_id, department_id, location_id))
  with check (public.can_manage_scope(auth.uid(), company_id, department_id, location_id));

drop policy "schedules_manager_manage" on public.schedules;
create policy "schedules_manager_manage" on public.schedules for all to authenticated
  using (public.can_manage_scope(auth.uid(), company_id, department_id, location_id))
  with check (public.can_manage_scope(auth.uid(), company_id, department_id, location_id));

-- Managers still SELECT every draft in their company so a scoped supervisor can
-- see the wider plan; only writing is narrowed.
drop policy "schedules_view_manager" on public.schedules;
create policy "schedules_view_manager" on public.schedules for select to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or public.has_role(auth.uid(), 'supervisor', company_id)
  );

-- Approving time off follows the requester's department.
drop policy "timeoff_admin_update" on public.time_off_requests;
create policy "timeoff_admin_update" on public.time_off_requests for update to authenticated
  using (public.can_manage_employee(auth.uid(), employee_id))
  with check (public.can_manage_employee(auth.uid(), employee_id));
