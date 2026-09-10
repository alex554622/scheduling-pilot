-- Removing an employee threw their membership away: roles deleted, company_id
-- nulled, and nothing left to say they had ever worked there. This records the
-- separation instead, so a former employee can be brought back with their old
-- department, position and roles intact.
--
-- The account itself was never the thing being deleted — auth.users and the
-- profile row already survive removal, which is why a separated employee can
-- immediately join a different company with that company's join code
-- (join_company_by_code only refuses while profiles.company_id is set).

-- Guarded so the whole file stays re-runnable; it is applied by hand in Studio,
-- not by a migration runner that tracks what has already gone in.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'separation_reason') then
    create type public.separation_reason as enum ('rehire', 'laid_off', 'other');
  end if;
end $$;

create table if not exists public.employment_separations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  reason public.separation_reason not null,
  note text,
  separated_at timestamptz not null default now(),
  separated_by uuid references auth.users(id) on delete set null,

  -- Snapshot of the company-scoped attributes, so a rehire restores the person
  -- to where they were rather than to a blank employee record.
  --
  -- full_name and position are snapshotted rather than joined: profile_view is
  -- scoped to company_id, so the moment the removal nulls it the admin can no
  -- longer read that profile row at all. Copying the two display fields here
  -- keeps the former-employee list readable without widening profile access.
  prior_full_name text not null default '',
  prior_position text,
  prior_roles public.app_role[] not null default '{}',
  prior_department_id uuid,
  prior_position_id uuid,
  prior_employee_code text,
  prior_max_weekly_hours numeric(5,2),

  rehired_at timestamptz,
  rehired_by uuid references auth.users(id) on delete set null
);

create index if not exists employment_separations_company_idx
  on public.employment_separations(company_id, separated_at desc);
create index if not exists employment_separations_user_idx
  on public.employment_separations(user_id);

-- At most one open (not yet rehired) separation per person per company, so
-- "the record to rehire against" is never ambiguous.
create unique index if not exists employment_separations_open_idx
  on public.employment_separations(user_id, company_id)
  where rehired_at is null;

alter table public.employment_separations enable row level security;

-- Read-only from the client; every write goes through the definer RPCs below.
drop policy if exists "separations_admin_view" on public.employment_separations;
create policy "separations_admin_view" on public.employment_separations
  for select to authenticated
  using (
    public.has_role(auth.uid(), 'company_admin'::app_role, company_id)
    or public.has_role(auth.uid(), 'super_admin'::app_role)
  );

drop policy if exists "separations_view_self" on public.employment_separations;
create policy "separations_view_self" on public.employment_separations
  for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Removal, now recording why.
-- ---------------------------------------------------------------------------
-- Replaces the single-argument version outright rather than overloading it:
-- two candidates reachable by name would leave PostgREST unable to choose.
drop function if exists public.remove_company_member(uuid);

create or replace function public.remove_company_member(
  _user uuid,
  _reason public.separation_reason default 'other',
  _note text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  cid uuid;
  caller uuid := auth.uid();
  prof public.profiles%rowtype;
  roles public.app_role[];
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _user = caller then
    raise exception 'You cannot remove yourself from the company.';
  end if;

  select * into prof from public.profiles where id = _user;
  if not found then raise exception 'That user does not exist.'; end if;
  cid := prof.company_id;
  if cid is null then raise exception 'That user is not a member of a company.'; end if;

  if not (public.has_role(caller, 'company_admin'::app_role, cid)
          or public.has_role(caller, 'super_admin'::app_role)) then
    raise exception 'not authorized';
  end if;

  select coalesce(array_agg(role), '{}'::public.app_role[]) into roles
  from public.user_roles where user_id = _user and company_id = cid;

  -- Close any earlier open separation for this pair so the partial unique index
  -- holds. This fires when someone rejoined the same company by join code rather
  -- than through rehire_company_member: they did come back, so the old record is
  -- no longer open, but no admin rehired them — hence a null rehired_by.
  update public.employment_separations
    set rehired_at = now(), rehired_by = null
  where user_id = _user and company_id = cid and rehired_at is null;

  insert into public.employment_separations (
    user_id, company_id, reason, note, separated_by,
    prior_full_name, prior_position, prior_roles,
    prior_department_id, prior_position_id,
    prior_employee_code, prior_max_weekly_hours
  ) values (
    _user, cid, _reason, nullif(btrim(coalesce(_note, '')), ''), caller,
    prof.full_name, prof.position, roles,
    prof.department_id, prof.position_id,
    prof.employee_code, prof.max_weekly_hours
  );

  delete from public.user_roles where user_id = _user and company_id = cid;

  -- Clear the company-scoped fields as well as the membership. A badge number
  -- or job title from the old employer must not follow the person into the next
  -- company they join by code; the snapshot above is what a rehire reads back.
  update public.profiles
    set company_id = null, department_id = null, position_id = null,
        employee_code = null, position = null
    where id = _user;
end;
$$;

revoke all on function public.remove_company_member(uuid, public.separation_reason, text) from public, anon;
grant execute on function public.remove_company_member(uuid, public.separation_reason, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Rehire: reverse of the above, against the open separation record.
-- ---------------------------------------------------------------------------
create or replace function public.rehire_company_member(_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  sep public.employment_separations%rowtype;
  caller uuid := auth.uid();
  current_company uuid;
  cap int;
  used int;
  r public.app_role;
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select * into sep
  from public.employment_separations
  where user_id = _user and rehired_at is null
  order by separated_at desc
  limit 1;
  if not found then raise exception 'No open separation record for that user.'; end if;

  if not (public.has_role(caller, 'company_admin'::app_role, sep.company_id)
          or public.has_role(caller, 'super_admin'::app_role)) then
    raise exception 'not authorized';
  end if;

  select company_id into current_company from public.profiles where id = _user;
  if current_company is not null then
    raise exception 'That person has already joined another company.';
  end if;

  -- Same seat check approve_membership applies, so a rehire cannot slip past
  -- the plan limit that a normal join would have been held to.
  cap := public.company_seat_limit(sep.company_id);
  if cap is not null then
    select count(*) into used from public.profiles where company_id = sep.company_id;
    if used >= cap then
      raise exception 'Your plan covers % employees and all seats are in use. Upgrade the plan to add more.', cap;
    end if;
  end if;

  update public.profiles set
    company_id = sep.company_id,
    pending_company_id = null,
    department_id = sep.prior_department_id,
    position_id = sep.prior_position_id,
    position = coalesce(position, sep.prior_position),
    employee_code = coalesce(employee_code, sep.prior_employee_code),
    max_weekly_hours = coalesce(sep.prior_max_weekly_hours, max_weekly_hours),
    is_active = true
  where id = _user;

  -- Restore the roles they held, defaulting to plain employee for a record
  -- written before prior_roles existed.
  if array_length(sep.prior_roles, 1) is null then
    insert into public.user_roles (user_id, company_id, role)
    values (_user, sep.company_id, 'employee') on conflict do nothing;
  else
    foreach r in array sep.prior_roles loop
      insert into public.user_roles (user_id, company_id, role)
      values (_user, sep.company_id, r) on conflict do nothing;
    end loop;
  end if;

  update public.employment_separations
    set rehired_at = now(), rehired_by = caller
  where id = sep.id;
end;
$$;

revoke all on function public.rehire_company_member(uuid) from public, anon;
grant execute on function public.rehire_company_member(uuid) to authenticated;

-- PostgREST caches the schema; without this the new table and RPCs 404 until it
-- happens to reload on its own.
notify pgrst, 'reload schema';
