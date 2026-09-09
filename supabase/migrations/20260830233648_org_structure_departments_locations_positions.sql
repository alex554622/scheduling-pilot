-- README gap: departments / locations / positions and employee qualifications.
--
-- NOTE ON POLICY HELPERS: RLS expressions are evaluated as the querying role, so
-- every function named in a policy must be EXECUTE-able by that role. has_role()
-- is granted to authenticated; is_company_manager() is NOT (it was revoked as
-- internal). Policies below therefore use has_role() only. Using
-- is_company_manager() here would 401 the whole query, exactly like the
-- pricing_plans/anon bug fixed earlier.
--
-- company_id is NOT NULL on every table here, so the has_role(_company => NULL)
-- "any company" degeneracy that caused the privilege-escalation bug cannot apply.

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);
create index departments_company_idx on public.departments(company_id);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  address text,
  latitude double precision,
  longitude double precision,
  geofence_radius_m integer not null default 200,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);
create index locations_company_idx on public.locations(company_id);

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  description text,
  color text not null default 'primary',
  created_at timestamptz not null default now(),
  unique (company_id, name)
);
create index positions_company_idx on public.positions(company_id);

-- Which positions an employee is qualified to work. Drives the README's
-- "Employee has the required position" scheduling check.
create table public.employee_positions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references auth.users(id) on delete cascade,
  position_id uuid not null references public.positions(id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (employee_id, position_id)
);
create index employee_positions_company_idx on public.employee_positions(company_id);
create index employee_positions_employee_idx on public.employee_positions(employee_id);

-- Employee attributes the scheduling engine needs.
alter table public.profiles
  add column if not exists department_id uuid references public.departments(id) on delete set null,
  add column if not exists position_id uuid references public.positions(id) on delete set null,
  add column if not exists max_weekly_hours numeric(5,2) not null default 40,
  add column if not exists is_active boolean not null default true,
  add column if not exists employee_code text,
  add column if not exists phone text;

alter table public.departments enable row level security;
alter table public.locations enable row level security;
alter table public.positions enable row level security;
alter table public.employee_positions enable row level security;

create policy "departments_view" on public.departments for select to authenticated
  using (company_id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));
create policy "departments_admin_manage" on public.departments for all to authenticated
  using (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id))
  with check (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id));

create policy "locations_view" on public.locations for select to authenticated
  using (company_id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));
create policy "locations_admin_manage" on public.locations for all to authenticated
  using (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id))
  with check (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id));

create policy "positions_view" on public.positions for select to authenticated
  using (company_id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));
create policy "positions_admin_manage" on public.positions for all to authenticated
  using (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id))
  with check (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id));

create policy "employee_positions_view" on public.employee_positions for select to authenticated
  using (company_id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));
create policy "employee_positions_manage" on public.employee_positions for all to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or public.has_role(auth.uid(), 'supervisor', company_id)
  )
  with check (
    public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or public.has_role(auth.uid(), 'supervisor', company_id)
  );
