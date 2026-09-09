-- Weekly recurring availability. is_available=false expresses a blackout window
-- (README: "custom blackout days"); effective_from/to allow seasonal changes.
create table public.employee_availability (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references auth.users(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday
  start_time time not null,
  end_time time not null,
  is_available boolean not null default true,
  effective_from date,
  effective_to date,
  note text,
  created_at timestamptz not null default now(),
  check (end_time > start_time),
  check (effective_to is null or effective_from is null or effective_to >= effective_from)
);
create index employee_availability_employee_idx on public.employee_availability(employee_id, weekday);
create index employee_availability_company_idx on public.employee_availability(company_id);

create table public.shift_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  department_id uuid references public.departments(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  position_id uuid references public.positions(id) on delete set null,
  start_time time not null,
  end_time time not null,
  break_minutes integer not null default 0 check (break_minutes >= 0),
  required_headcount integer not null default 1 check (required_headcount > 0),
  color text not null default 'primary',
  created_at timestamptz not null default now(),
  unique (company_id, name)
);
create index shift_templates_company_idx on public.shift_templates(company_id);

-- A schedule is the publishable container for a period of shifts. Employees only
-- see published schedules; drafts stay with managers until released.
create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  department_id uuid references public.departments(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  published_at timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index schedules_company_range_idx on public.schedules(company_id, starts_on, ends_on);

-- Enrich shifts. All additive and nullable so existing frontend queries
-- (dashboard uses select("*"), reports/trades select explicit columns) keep working.
alter table public.shifts
  add column if not exists schedule_id uuid references public.schedules(id) on delete set null,
  add column if not exists department_id uuid references public.departments(id) on delete set null,
  add column if not exists location_id uuid references public.locations(id) on delete set null,
  add column if not exists position_id uuid references public.positions(id) on delete set null,
  add column if not exists template_id uuid references public.shift_templates(id) on delete set null,
  add column if not exists break_minutes integer not null default 0,
  add column if not exists notes text;

-- Open (unassigned) shifts: README dashboard shows "Open shifts" and employees
-- can pick them up. Nothing in the app writes a null employee_id today, so
-- relaxing NOT NULL is backward compatible.
alter table public.shifts alter column employee_id drop not null;
create index if not exists shifts_open_idx on public.shifts(company_id, starts_at) where employee_id is null;
create index if not exists shifts_schedule_idx on public.shifts(schedule_id);

alter table public.employee_availability enable row level security;
alter table public.shift_templates enable row level security;
alter table public.schedules enable row level security;

create policy "availability_view" on public.employee_availability for select to authenticated
  using (company_id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));
create policy "availability_self_manage" on public.employee_availability for all to authenticated
  using (employee_id = auth.uid())
  with check (employee_id = auth.uid() and company_id = public.current_company_id());
create policy "availability_manager_manage" on public.employee_availability for all to authenticated
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

create policy "templates_view" on public.shift_templates for select to authenticated
  using (company_id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));
create policy "templates_admin_manage" on public.shift_templates for all to authenticated
  using (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id))
  with check (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id));

-- Employees see published schedules only; managers see drafts too.
create policy "schedules_view_published" on public.schedules for select to authenticated
  using (company_id = public.current_company_id() and status <> 'draft');
create policy "schedules_view_manager" on public.schedules for select to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or public.has_role(auth.uid(), 'supervisor', company_id)
  );
create policy "schedules_manager_manage" on public.schedules for all to authenticated
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
