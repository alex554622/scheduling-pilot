-- Supervisors, scoped to departments.
--
-- 20260831022151 folded the old supervisor role into company_admin. This brings
-- it back as a role of its own: a supervisor manages only the people an admin
-- puts in their care, and none of the company-wide settings.
--
-- What a supervisor is given:
--
--   supervisor_assignments  one row per department they run. A row with no
--                           employee_id covers the whole department; rows with
--                           an employee_id narrow that department to just those
--                           people. Several supervisors can share a department.
--
-- Who they reach is decided here, in the database, by supervises(). Every
-- policy and RPC that lets a supervisor touch someone asks it:
--
--   shifts            build and edit shifts for their people (and open shifts
--                     in their departments)
--   time_punches      read their people's punches; fix them through the
--                     manager_* punch RPCs while "Supervisors can edit
--                     timecards" is on
--   timecard_notes    read and write notes on their people's cards (same rule)
--   time off          approve or deny, and record absences, while "Supervisors
--                     can approve time off" is on
--   availability      edit their people's availability
--   company_presence  who is in, for their people
--
-- What stays admin-only: departments, employees and their roles, company
-- settings and app rules, billing, invitations, the kiosk, the audit log,
-- shift trades and the automatic schedule generator. is_company_manager()
-- keeps meaning "company admin or super admin", so all of that is unchanged.
-- A supervisor never manages themselves: their own card is read-only to them,
-- exactly as it is for any employee.
--
-- Super admins are not touched: every check below lets is_company_manager()
-- through first, and supervisor checks read user_roles directly, so a super
-- admin ghosting a company is still treated as its admin and nothing else.
--
-- No existing row changes. There are no supervisors until an admin makes one.
--
-- Run after 20261120120000_timecard_notes.sql. It also replaces
-- manager_record_absence / manager_remove_absence from
-- 20261120140000_manager_absences.sql with the same bodies, so the order
-- between those two does not matter.
--
-- Re-runnable; applied by hand in Studio.

-- ------------------------------------------------------------------ role ----

alter table public.user_roles drop constraint if exists user_roles_supervisor_retired;

-- ---------------------------------------------------------- assignments ----

create table if not exists public.supervisor_assignments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  supervisor_id uuid not null references auth.users(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  -- null = the whole department; set = only this person in it
  employee_id   uuid references auth.users(id) on delete cascade,
  created_by    uuid default auth.uid() references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- One row per (supervisor, department, person), with "whole department"
-- (employee_id null) counted once too. Written with coalesce rather than
-- NULLS NOT DISTINCT, which needs Postgres 15.
create unique index if not exists supervisor_assignments_unique
  on public.supervisor_assignments (
    supervisor_id,
    department_id,
    coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
create index if not exists supervisor_assignments_company_idx
  on public.supervisor_assignments (company_id);
create index if not exists supervisor_assignments_dept_idx
  on public.supervisor_assignments (department_id);

-- Every id on the row must belong to the row's company, so an admin of one
-- company can never point a row at another company's department or people.
create or replace function public.supervisor_assignments_guard()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.departments d
                  where d.id = new.department_id and d.company_id = new.company_id) then
    raise exception 'that department is not in this company';
  end if;
  if not exists (select 1 from public.profiles p
                  where p.id = new.supervisor_id and p.company_id = new.company_id) then
    raise exception 'that supervisor is not in this company';
  end if;
  if new.employee_id is not null and not exists (
    select 1 from public.profiles p
     where p.id = new.employee_id and p.company_id = new.company_id
  ) then
    raise exception 'that person is not in this company';
  end if;
  return new;
end; $$;

drop trigger if exists supervisor_assignments_guard on public.supervisor_assignments;
create trigger supervisor_assignments_guard
  before insert or update on public.supervisor_assignments
  for each row execute function public.supervisor_assignments_guard();

alter table public.supervisor_assignments enable row level security;

grant select, insert, update, delete on public.supervisor_assignments to authenticated;
grant all on public.supervisor_assignments to service_role;

-- ------------------------------------------------------------- helpers ----
--
-- All security definer and granted to authenticated: RLS policies call them,
-- and a policy can only call functions the querying role may execute.

-- A real supervisor row. Deliberately not has_role(): that answers yes to
-- 'supervisor' for a super admin who is ghosting the company.
create or replace function public.is_supervisor(_user uuid, _company uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.user_roles r
     where r.user_id = _user and r.company_id = _company
       and r.role = 'supervisor'::public.app_role
  );
$$;

-- Is _employee in _user's care as a supervisor? Never true of themselves.
create or replace function public.supervises(_user uuid, _employee uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _user is not null and _employee is not null and _user <> _employee
     and exists (
       select 1
         from public.profiles p
         join public.supervisor_assignments a
           on a.company_id = p.company_id
          and a.department_id = p.department_id
          and a.supervisor_id = _user
          and (a.employee_id is null or a.employee_id = p.id)
        where p.id = _employee
          and public.is_supervisor(_user, p.company_id)
     );
$$;

-- Can _user plan for _department (open shifts, department schedules)?
create or replace function public.can_manage_department(_user uuid, _company uuid, _department uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_company_manager(_user, _company)
      or (_department is not null
          and public.is_supervisor(_user, _company)
          and exists (select 1 from public.supervisor_assignments a
                       where a.supervisor_id = _user
                         and a.company_id = _company
                         and a.department_id = _department));
$$;

-- A company's own switch for what supervisors may do. Absent = on.
create or replace function public.supervisor_setting(_company uuid, _key text)
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce((select (c.settings ->> _key)::boolean
                     from public.companies c where c.id = _company), true);
$$;

-- Manage _employee at all: admin of their company, or their supervisor.
create or replace function public.can_manage_employee(_user uuid, _employee uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles p
                  where p.id = _employee
                    and public.is_company_manager(_user, p.company_id))
      or public.supervises(_user, _employee);
$$;

-- Fix _employee's punches and timecard notes.
create or replace function public.can_manage_timecard(_user uuid, _employee uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles p
                  where p.id = _employee
                    and (public.is_company_manager(_user, p.company_id)
                         or (public.supervises(_user, _employee)
                             and public.supervisor_setting(p.company_id, 'supervisors_edit_timecards'))));
$$;

-- Approve _employee's time off, or record an absence for them.
create or replace function public.can_approve_time_off(_user uuid, _employee uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles p
                  where p.id = _employee
                    and (public.is_company_manager(_user, p.company_id)
                         or (public.supervises(_user, _employee)
                             and public.supervisor_setting(p.company_id, 'supervisors_approve_time_off'))));
$$;

-- The people the caller manages in their current company: everyone for an
-- admin (or a ghosting super admin), their own people for a supervisor,
-- nobody for anyone else. Drives the supervisor's lists in the app; the
-- policies above are what actually keep everyone else out.
create or replace function public.managed_employee_ids()
returns setof uuid language sql stable security definer set search_path = public
as $$
  select p.id
    from public.profiles p
   where p.company_id = public.current_company_id()
     and (public.is_company_manager(auth.uid(), p.company_id)
          or public.supervises(auth.uid(), p.id));
$$;

revoke all on function public.is_supervisor(uuid, uuid) from public, anon;
revoke all on function public.supervises(uuid, uuid) from public, anon;
revoke all on function public.can_manage_department(uuid, uuid, uuid) from public, anon;
revoke all on function public.supervisor_setting(uuid, text) from public, anon;
revoke all on function public.can_manage_employee(uuid, uuid) from public, anon;
revoke all on function public.can_manage_timecard(uuid, uuid) from public, anon;
revoke all on function public.can_approve_time_off(uuid, uuid) from public, anon;
revoke all on function public.managed_employee_ids() from public, anon;
grant execute on function public.is_supervisor(uuid, uuid) to authenticated;
grant execute on function public.supervises(uuid, uuid) to authenticated;
grant execute on function public.can_manage_department(uuid, uuid, uuid) to authenticated;
grant execute on function public.supervisor_setting(uuid, text) to authenticated;
grant execute on function public.can_manage_employee(uuid, uuid) to authenticated;
grant execute on function public.can_manage_timecard(uuid, uuid) to authenticated;
grant execute on function public.can_approve_time_off(uuid, uuid) to authenticated;
grant execute on function public.managed_employee_ids() to authenticated;

-- ------------------------------------------- assignment visibility ----
--
-- Admins see and edit every assignment in their company. A supervisor reads
-- their own rows (that is how the app knows their departments) and can never
-- write one, so they cannot widen their own reach.

drop policy if exists supervisor_assignments_view on public.supervisor_assignments;
create policy supervisor_assignments_view on public.supervisor_assignments for select to authenticated
  using (supervisor_id = auth.uid() or public.is_company_manager(auth.uid(), company_id));

drop policy if exists supervisor_assignments_manage on public.supervisor_assignments;
create policy supervisor_assignments_manage on public.supervisor_assignments for all to authenticated
  using (public.is_company_manager(auth.uid(), company_id))
  with check (public.is_company_manager(auth.uid(), company_id));

-- -------------------------------------------------------------- shifts ----

drop policy if exists "shifts_manage" on public.shifts;
create policy "shifts_manage" on public.shifts for all to authenticated
  using (
    public.is_company_manager(auth.uid(), company_id)
    or (employee_id is not null and public.supervises(auth.uid(), employee_id))
    or (employee_id is null and public.can_manage_department(auth.uid(), company_id, department_id))
  )
  with check (
    public.is_company_manager(auth.uid(), company_id)
    or (employee_id is not null and public.supervises(auth.uid(), employee_id)
        and company_id = (select p.company_id from public.profiles p where p.id = employee_id))
    or (employee_id is null and public.can_manage_department(auth.uid(), company_id, department_id))
  );

drop policy if exists "schedules_manager_manage" on public.schedules;
create policy "schedules_manager_manage" on public.schedules for all to authenticated
  using (public.can_manage_department(auth.uid(), company_id, department_id))
  with check (public.can_manage_department(auth.uid(), company_id, department_id));

drop policy if exists "schedules_view_manager" on public.schedules;
create policy "schedules_view_manager" on public.schedules for select to authenticated
  using (public.is_company_manager(auth.uid(), company_id)
         or public.is_supervisor(auth.uid(), company_id));

-- ------------------------------------------------------------- punches ----

drop policy if exists "punch_select_self_or_mgr" on public.time_punches;
create policy "punch_select_self_or_mgr" on public.time_punches for select to authenticated
  using (
    user_id = auth.uid()
    or (company_id = public.current_company_id()
        and public.has_role(auth.uid(), 'company_admin'::app_role, company_id))
    or public.has_role(auth.uid(), 'super_admin'::app_role)
    or public.supervises(auth.uid(), user_id)
  );

-- ------------------------------------------------------ timecard notes ----

drop policy if exists timecard_notes_view on public.timecard_notes;
create policy timecard_notes_view on public.timecard_notes for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or public.supervises(auth.uid(), user_id)
  );

drop policy if exists timecard_notes_manage on public.timecard_notes;
create policy timecard_notes_manage on public.timecard_notes for all to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or public.can_manage_timecard(auth.uid(), user_id)
  )
  with check (
    public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or (public.can_manage_timecard(auth.uid(), user_id)
        and company_id = (select p.company_id from public.profiles p where p.id = user_id))
  );

-- ------------------------------------------------------------ time off ----

drop policy if exists "timeoff_admin_update" on public.time_off_requests;
create policy "timeoff_admin_update" on public.time_off_requests for update to authenticated
  using (public.is_company_manager(auth.uid(), company_id)
         or public.can_approve_time_off(auth.uid(), employee_id))
  with check (public.is_company_manager(auth.uid(), company_id)
              or public.can_approve_time_off(auth.uid(), employee_id));

-- -------------------------------------------------------- availability ----

drop policy if exists "availability_manager_manage" on public.employee_availability;
create policy "availability_manager_manage" on public.employee_availability for all to authenticated
  using (public.is_company_manager(auth.uid(), company_id)
         or public.supervises(auth.uid(), employee_id))
  with check (public.is_company_manager(auth.uid(), company_id)
              or (public.supervises(auth.uid(), employee_id)
                  and company_id = (select p.company_id from public.profiles p where p.id = employee_id)));

-- ------------------------------------------------- punch corrections ----
-- Same bodies as 20260912120000_optional_correction_reason.sql; only the
-- "who may" line changes, from is_company_manager to can_manage_timecard.

create or replace function public.manager_update_punch(
  _id uuid,
  _at timestamptz,
  _kind text,
  _reason text default null,
  _minutes int default null
) returns public.time_punches
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  old_row public.time_punches;
  new_row public.time_punches;
  next_minutes int;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _kind not in ('in','out','break_start','break_end') then
    raise exception 'invalid kind';
  end if;
  if _minutes is not null and _minutes not in (10, 30, 60) then
    raise exception 'break length must be 10, 30 or 60 minutes';
  end if;

  select * into old_row from public.time_punches where id = _id for update;
  if not found then raise exception 'punch not found'; end if;
  if not (public.is_company_manager(caller, old_row.company_id)
          or public.can_manage_timecard(caller, old_row.user_id)) then
    raise exception 'not authorized';
  end if;

  if _kind in ('break_start','break_end') then
    next_minutes := coalesce(_minutes, old_row.break_minutes);
  else
    next_minutes := null;
  end if;

  update public.time_punches
    set at = coalesce(_at, at),
        kind = _kind,
        break_minutes = next_minutes
    where id = _id
    returning * into new_row;

  insert into public.time_punch_audit (punch_id, company_id, user_id, actor_id, action, reason, before, after)
  values (_id, old_row.company_id, old_row.user_id, caller, 'update', coalesce(trim(_reason), ''),
          to_jsonb(old_row), to_jsonb(new_row));

  return new_row;
end;
$$;

create or replace function public.manager_insert_punch(
  _user_id uuid,
  _at timestamptz,
  _kind text,
  _reason text default null,
  _minutes int default null
) returns public.time_punches
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid;
  new_row public.time_punches;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _kind not in ('in','out','break_start','break_end') then
    raise exception 'invalid kind';
  end if;
  if _at is null then raise exception 'time required'; end if;
  if _minutes is not null and _minutes not in (10, 30, 60) then
    raise exception 'break length must be 10, 30 or 60 minutes';
  end if;

  select company_id into cid from public.profiles where id = _user_id;
  if cid is null then raise exception 'employee has no company'; end if;
  if not (public.is_company_manager(caller, cid)
          or public.can_manage_timecard(caller, _user_id)) then
    raise exception 'not authorized';
  end if;

  insert into public.time_punches (user_id, company_id, kind, at, within_geofence, break_minutes)
  values (
    _user_id, cid, _kind, _at, true,
    case when _kind in ('break_start','break_end') then _minutes else null end
  )
  returning * into new_row;

  insert into public.time_punch_audit (punch_id, company_id, user_id, actor_id, action, reason, before, after)
  values (new_row.id, cid, _user_id, caller, 'create', coalesce(trim(_reason), ''), null, to_jsonb(new_row));

  return new_row;
end;
$$;

create or replace function public.manager_delete_punch(
  _id uuid,
  _reason text default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  old_row public.time_punches;
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select * into old_row from public.time_punches where id = _id for update;
  if not found then raise exception 'punch not found'; end if;
  if not (public.is_company_manager(caller, old_row.company_id)
          or public.can_manage_timecard(caller, old_row.user_id)) then
    raise exception 'not authorized';
  end if;

  delete from public.time_punches where id = _id;

  insert into public.time_punch_audit (punch_id, company_id, user_id, actor_id, action, reason, before, after)
  values (_id, old_row.company_id, old_row.user_id, caller, 'delete', coalesce(trim(_reason), ''),
          to_jsonb(old_row), null);
end;
$$;

-- A supervisor clearing "everyone" clears only their own people.
create or replace function public.manager_delete_punch_range(
  _company uuid,
  _user uuid,
  _from timestamptz,
  _to timestamptz,
  _reason text default null
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  manager boolean;
  deleted integer := 0;
  r public.time_punches;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _to <= _from then
    raise exception 'the end of the range must come after its start';
  end if;
  manager := public.is_company_manager(caller, _company)
             or public.has_role(caller, 'super_admin'::public.app_role);
  if not manager then
    if not public.is_supervisor(caller, _company) then
      raise exception 'not authorized';
    end if;
    if _user is not null and not public.can_manage_timecard(caller, _user) then
      raise exception 'not authorized';
    end if;
  end if;
  if _user is not null and not exists (
    select 1 from public.profiles where id = _user and company_id = _company
  ) then
    raise exception 'that person is not in that company';
  end if;

  for r in
    select * from public.time_punches tp
     where tp.company_id = _company
       and tp.at >= _from
       and tp.at < _to
       and (_user is null or tp.user_id = _user)
       and (manager or public.can_manage_timecard(caller, tp.user_id))
     for update
  loop
    delete from public.time_punches where id = r.id;
    insert into public.time_punch_audit (
      punch_id, company_id, user_id, actor_id, action, reason, before, after
    ) values (
      r.id, r.company_id, r.user_id, caller, 'delete', coalesce(trim(_reason), ''), to_jsonb(r), null
    );
    deleted := deleted + 1;
  end loop;

  return deleted;
end; $$;

-- ------------------------------------------------------ time off RPCs ----
-- Same bodies as 20260930140000 and 20261120140000; only the gate changes.

create or replace function public.decide_time_off(_request uuid, _approve boolean)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  r public.time_off_requests;
  tz text;
  opened int := 0;
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select * into r from public.time_off_requests where id = _request for update;
  if not found then raise exception 'request not found'; end if;
  if not (public.is_company_manager(caller, r.company_id)
          or public.can_approve_time_off(caller, r.employee_id)) then
    raise exception 'not authorized';
  end if;
  if r.status <> 'pending' then raise exception 'this request has already been answered'; end if;

  update public.time_off_requests
     set status = case when _approve then 'approved' else 'denied' end
   where id = _request;

  if _approve then
    select coalesce(c.timezone, 'UTC') into tz from public.companies c where c.id = r.company_id;

    update public.shifts sh
       set employee_id = null
     where sh.employee_id = r.employee_id
       and sh.company_id = r.company_id
       and sh.ends_at > now()
       and (sh.starts_at at time zone tz)::date <= r.end_date
       and (sh.ends_at   at time zone tz)::date >= r.start_date;
    get diagnostics opened = row_count;
  end if;

  insert into public.notifications (user_id, type, title, body, link)
  values (
    r.employee_id,
    'time_off_' || case when _approve then 'approved' else 'denied' end,
    'Time off ' || case when _approve then 'approved' else 'denied' end,
    'Your ' || r.kind || ' request for '
      || to_char(r.start_date, 'Mon FMDD')
      || case when r.end_date <> r.start_date then ' – ' || to_char(r.end_date, 'Mon FMDD') else '' end
      || ' was ' || case when _approve then 'approved.' else 'denied.' end,
    '/time-off'
  );

  return opened;
end;
$$;

create or replace function public.manager_record_absence(
  _employee uuid,
  _kind text,
  _start date,
  _end date,
  _note text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid;
  tz text;
  new_id uuid;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _kind not in ('vacation', 'sick', 'family_leave', 'personal', 'other') then
    raise exception 'unknown absence type: %', _kind;
  end if;
  if _start is null or _end is null or _end < _start then
    raise exception 'the last day cannot be before the first';
  end if;
  if _end - _start > 366 then raise exception 'an absence can run at most a year'; end if;

  select p.company_id into cid from public.profiles p where p.id = _employee;
  if cid is null then raise exception 'that person is not in a company'; end if;
  if not (public.is_company_manager(caller, cid)
          or public.can_approve_time_off(caller, _employee)) then
    raise exception 'not authorized';
  end if;

  insert into public.time_off_requests (company_id, employee_id, kind, start_date, end_date, status, note)
  values (cid, _employee, _kind, _start, _end, 'approved', nullif(trim(coalesce(_note, '')), ''))
  returning id into new_id;

  select coalesce(c.timezone, 'UTC') into tz from public.companies c where c.id = cid;
  update public.shifts sh
     set employee_id = null
   where sh.employee_id = _employee
     and sh.company_id = cid
     and sh.ends_at > now()
     and (sh.starts_at at time zone tz)::date <= _end
     and (sh.ends_at   at time zone tz)::date >= _start;

  return new_id;
end;
$$;

create or replace function public.manager_remove_absence(_request uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  r public.time_off_requests;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  select * into r from public.time_off_requests where id = _request for update;
  if not found then raise exception 'absence not found'; end if;
  if not (public.is_company_manager(caller, r.company_id)
          or public.can_approve_time_off(caller, r.employee_id)) then
    raise exception 'not authorized';
  end if;
  if r.status not in ('approved', 'pending') then raise exception 'this absence is already withdrawn'; end if;
  update public.time_off_requests set status = 'cancelled' where id = _request;
end;
$$;

revoke all on function public.manager_record_absence(uuid, text, date, date, text) from public, anon;
revoke all on function public.manager_remove_absence(uuid) from public, anon;
grant execute on function public.manager_record_absence(uuid, text, date, date, text) to authenticated;
grant execute on function public.manager_remove_absence(uuid) to authenticated;

-- ---------------------------------------------------- company_presence ----
-- Same as 20261019160000_staff_see_coworkers.sql, with two changes:
--  * a supervisor always sees their own people, like an admin sees everyone;
--  * "Hide admins from the rosters" no longer hides supervisors. They are
--    scheduled and paid like the people they run, so they stay on the floor.

create or replace function public.company_presence()
returns table (user_id uuid, full_name text, job_title text, status text)
language plpgsql stable security definer set search_path = public
as $$
declare
  cid uuid;
  tz text;
  day_start timestamptz;
  hide_admins boolean;
  see_coworkers boolean;
  manager boolean;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  select p.company_id into cid from public.profiles p where p.id = auth.uid();
  if cid is null then return; end if;

  select coalesce(nullif(c.timezone, ''), 'UTC') into tz from public.companies c where c.id = cid;
  begin
    day_start := date_trunc('day', now() at time zone tz) at time zone tz;
  exception when others then
    day_start := date_trunc('day', now());
  end;

  select coalesce((c.settings ->> 'hide_admins_from_staff')::boolean, true),
         coalesce((c.settings ->> 'staff_see_coworkers')::boolean, true)
    into hide_admins, see_coworkers
    from public.companies c where c.id = cid;
  hide_admins := coalesce(hide_admins, true);
  see_coworkers := coalesce(see_coworkers, true);
  manager := public.is_company_manager(auth.uid(), cid);

  return query
  with last_punch as (
    select distinct on (p.user_id) p.user_id, p.kind
      from public.time_punches p
     where p.company_id = cid and p.at >= day_start
     order by p.user_id, p.at desc, p.created_at desc, p.id desc
  )
  select
    pr.id,
    pr.full_name,
    pr.position,
    case
      when lp.kind is null or lp.kind = 'out' then 'off'
      when lp.kind = 'break_start' then 'on_break'
      else 'working'
    end
  from public.profiles pr
  left join last_punch lp on lp.user_id = pr.id
  left join public.member_visibility mv on mv.user_id = pr.id
  where pr.company_id = cid
    and (
      manager
      or pr.id = auth.uid()
      or public.supervises(auth.uid(), pr.id)
      or (
        see_coworkers
        and coalesce(mv.mode, '') <> 'ghost'
        and (
          mv.mode is not null
          or not hide_admins
          or not exists (
            select 1 from public.user_roles ur
             where ur.user_id = pr.id
               and ur.role in ('super_admin', 'company_admin')
               and (ur.company_id = cid or ur.company_id is null)
          )
        )
      )
    )
  order by pr.full_name;
end; $$;

revoke all on function public.company_presence() from public, anon;
grant execute on function public.company_presence() to authenticated;

notify pgrst, 'reload schema';
