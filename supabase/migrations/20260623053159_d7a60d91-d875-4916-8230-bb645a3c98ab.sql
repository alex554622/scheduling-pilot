
-- Audit log table
create table public.time_punch_audit (
  id uuid primary key default gen_random_uuid(),
  punch_id uuid,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null, -- employee whose punch was affected
  actor_id uuid not null, -- manager who performed the action
  action text not null check (action in ('create','update','delete')),
  reason text not null,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create index time_punch_audit_company_idx on public.time_punch_audit(company_id, created_at desc);
create index time_punch_audit_user_idx on public.time_punch_audit(user_id, created_at desc);
create index time_punch_audit_punch_idx on public.time_punch_audit(punch_id);

grant select, insert on public.time_punch_audit to authenticated;
grant all on public.time_punch_audit to service_role;

alter table public.time_punch_audit enable row level security;

create policy "members can read company audit"
  on public.time_punch_audit for select
  to authenticated
  using (
    company_id = public.current_company_id()
    or public.has_role(auth.uid(), 'super_admin'::app_role)
  );

create policy "no direct inserts"
  on public.time_punch_audit for insert
  to authenticated
  with check (false);

-- Helper: is the caller a manager in the given company?
create or replace function public.is_company_manager(_user uuid, _company uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.has_role(_user, 'company_admin'::app_role, _company)
      or public.has_role(_user, 'supervisor'::app_role, _company)
      or public.has_role(_user, 'super_admin'::app_role);
$$;

-- Manager: update an existing punch
create or replace function public.manager_update_punch(
  _id uuid,
  _at timestamptz,
  _kind text,
  _reason text
) returns public.time_punches
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  old_row public.time_punches;
  new_row public.time_punches;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _reason is null or length(trim(_reason)) < 3 then
    raise exception 'a reason (min 3 chars) is required';
  end if;
  if _kind not in ('in','out','break_start','break_end') then
    raise exception 'invalid kind';
  end if;

  select * into old_row from public.time_punches where id = _id for update;
  if not found then raise exception 'punch not found'; end if;
  if not public.is_company_manager(caller, old_row.company_id) then
    raise exception 'not authorized';
  end if;

  update public.time_punches
    set at = coalesce(_at, at),
        kind = _kind
    where id = _id
    returning * into new_row;

  insert into public.time_punch_audit (punch_id, company_id, user_id, actor_id, action, reason, before, after)
  values (_id, old_row.company_id, old_row.user_id, caller, 'update', trim(_reason),
          to_jsonb(old_row), to_jsonb(new_row));

  return new_row;
end;
$$;

-- Manager: insert a punch for an employee (override)
create or replace function public.manager_insert_punch(
  _user_id uuid,
  _at timestamptz,
  _kind text,
  _reason text
) returns public.time_punches
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid;
  new_row public.time_punches;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _reason is null or length(trim(_reason)) < 3 then
    raise exception 'a reason (min 3 chars) is required';
  end if;
  if _kind not in ('in','out','break_start','break_end') then
    raise exception 'invalid kind';
  end if;
  if _at is null then raise exception 'time required'; end if;

  select company_id into cid from public.profiles where id = _user_id;
  if cid is null then raise exception 'employee has no company'; end if;
  if not public.is_company_manager(caller, cid) then
    raise exception 'not authorized';
  end if;

  insert into public.time_punches (user_id, company_id, kind, at, within_geofence)
  values (_user_id, cid, _kind, _at, true)
  returning * into new_row;

  insert into public.time_punch_audit (punch_id, company_id, user_id, actor_id, action, reason, before, after)
  values (new_row.id, cid, _user_id, caller, 'create', trim(_reason), null, to_jsonb(new_row));

  return new_row;
end;
$$;

-- Manager: delete a punch
create or replace function public.manager_delete_punch(
  _id uuid,
  _reason text
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  old_row public.time_punches;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _reason is null or length(trim(_reason)) < 3 then
    raise exception 'a reason (min 3 chars) is required';
  end if;

  select * into old_row from public.time_punches where id = _id for update;
  if not found then raise exception 'punch not found'; end if;
  if not public.is_company_manager(caller, old_row.company_id) then
    raise exception 'not authorized';
  end if;

  delete from public.time_punches where id = _id;

  insert into public.time_punch_audit (punch_id, company_id, user_id, actor_id, action, reason, before, after)
  values (_id, old_row.company_id, old_row.user_id, caller, 'delete', trim(_reason), to_jsonb(old_row), null);
end;
$$;
