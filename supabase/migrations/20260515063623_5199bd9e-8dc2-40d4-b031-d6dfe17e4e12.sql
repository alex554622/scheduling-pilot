
-- ===== Enums =====
create type public.app_role as enum ('super_admin', 'company_admin', 'supervisor', 'employee');

-- ===== Tables =====
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'basic',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  company_id uuid references public.companies(id) on delete set null,
  position text,
  created_at timestamptz not null default now()
);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  role public.app_role not null,
  unique (user_id, company_id, role)
);

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references auth.users(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  position text not null default '',
  color text not null default 'primary',
  published boolean not null default false,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index shifts_company_starts_idx on public.shifts (company_id, starts_at);
create index shifts_employee_starts_idx on public.shifts (employee_id, starts_at);

create table public.time_off_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'vacation',
  start_date date not null,
  end_date date not null,
  status text not null default 'pending',
  note text,
  created_at timestamptz not null default now()
);

create table public.shift_trades (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  shift_id uuid not null references public.shifts(id) on delete cascade,
  from_employee_id uuid not null references auth.users(id) on delete cascade,
  to_employee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending_employee',
  created_at timestamptz not null default now()
);

-- ===== Security definer helpers (avoid RLS recursion) =====
create or replace function public.has_role(_user uuid, _role public.app_role, _company uuid default null)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user
      and role = _role
      and (_company is null or company_id = _company)
  );
$$;

create or replace function public.current_company_id()
returns uuid language sql stable security definer set search_path = public
as $$
  select company_id from public.profiles where id = auth.uid();
$$;

-- ===== Onboarding RPCs =====
create or replace function public.bootstrap_company(_name text)
returns uuid language plpgsql security definer set search_path = public
as $$
declare uid uuid := auth.uid(); cid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  insert into public.companies (name) values (_name) returning id into cid;
  insert into public.user_roles (user_id, company_id, role) values (uid, cid, 'company_admin');
  update public.profiles set company_id = cid where id = uid;
  return cid;
end; $$;

create or replace function public.join_company(_company uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.companies where id = _company) then
    raise exception 'company not found';
  end if;
  update public.profiles set company_id = _company where id = uid;
  insert into public.user_roles (user_id, company_id, role)
  values (uid, _company, 'employee') on conflict do nothing;
end; $$;

create or replace function public.claim_super_admin()
returns boolean language plpgsql security definer set search_path = public
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return false; end if;
  if exists (select 1 from public.user_roles where role = 'super_admin') then return false; end if;
  insert into public.user_roles (user_id, role) values (uid, 'super_admin');
  return true;
end; $$;

-- ===== Auto-create profile on signup =====
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===== RLS =====
alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.shifts enable row level security;
alter table public.time_off_requests enable row level security;
alter table public.shift_trades enable row level security;

-- companies
create policy "company_view" on public.companies for select to authenticated
  using (id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));
create policy "company_super_all" on public.companies for all to authenticated
  using (public.has_role(auth.uid(), 'super_admin'))
  with check (public.has_role(auth.uid(), 'super_admin'));
create policy "company_admin_update" on public.companies for update to authenticated
  using (public.has_role(auth.uid(), 'company_admin', id))
  with check (public.has_role(auth.uid(), 'company_admin', id));

-- profiles
create policy "profile_view" on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or company_id = public.current_company_id()
    or public.has_role(auth.uid(), 'super_admin')
  );
create policy "profile_update_self" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy "profile_admin_update" on public.profiles for update to authenticated
  using (public.has_role(auth.uid(), 'company_admin', company_id))
  with check (public.has_role(auth.uid(), 'company_admin', company_id));

-- user_roles
create policy "roles_view" on public.user_roles for select to authenticated
  using (
    user_id = auth.uid()
    or company_id = public.current_company_id()
    or public.has_role(auth.uid(), 'super_admin')
  );
create policy "roles_admin_manage" on public.user_roles for all to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
  )
  with check (
    public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
  );

-- shifts
create policy "shifts_view" on public.shifts for select to authenticated
  using (company_id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));
create policy "shifts_manage" on public.shifts for all to authenticated
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

-- time_off
create policy "timeoff_view" on public.time_off_requests for select to authenticated
  using (company_id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));
create policy "timeoff_employee_insert" on public.time_off_requests for insert to authenticated
  with check (employee_id = auth.uid() and company_id = public.current_company_id());
create policy "timeoff_admin_update" on public.time_off_requests for update to authenticated
  using (
    public.has_role(auth.uid(), 'company_admin', company_id)
    or public.has_role(auth.uid(), 'supervisor', company_id)
  ) with check (true);

-- trades
create policy "trades_view" on public.shift_trades for select to authenticated
  using (company_id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));
create policy "trades_employee_insert" on public.shift_trades for insert to authenticated
  with check (from_employee_id = auth.uid() and company_id = public.current_company_id());
create policy "trades_party_update" on public.shift_trades for update to authenticated
  using (
    from_employee_id = auth.uid()
    or to_employee_id = auth.uid()
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or public.has_role(auth.uid(), 'supervisor', company_id)
  ) with check (true);
