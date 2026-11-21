-- Multi-company memberships, part 2: the supervisor scope.
--
-- Run AFTER both 20261121120000_supervisor_departments.sql and
-- 20261122120000_multi_company_memberships.sql.
--
-- The supervisor migration's helpers and policies looked people up through
-- profiles.company_id / profiles.department_id. A person can now be in several
-- companies with a different department in each, so these read
-- company_memberships instead, and "your own punches / notes" means the ones
-- in the selected company. Bodies are otherwise the supervisor migration's.
--
-- Re-runnable.

-- can_approve_time_off
begin;

create or replace function public.can_approve_time_off(_user uuid, _employee uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.company_memberships p
                  where p.user_id = _employee and p.status = 'active'
                    and (public.is_company_manager(_user, p.company_id)
                         or (public.supervises(_user, _employee)
                             and public.supervisor_setting(p.company_id, 'supervisors_approve_time_off'))));
$$;

-- can_manage_timecard
create or replace function public.can_manage_timecard(_user uuid, _employee uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.company_memberships p
                  where p.user_id = _employee and p.status = 'active'
                    and (public.is_company_manager(_user, p.company_id)
                         or (public.supervises(_user, _employee)
                             and public.supervisor_setting(p.company_id, 'supervisors_edit_timecards'))));
$$;

-- can_manage_employee
create or replace function public.can_manage_employee(_user uuid, _employee uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.company_memberships p
                  where p.user_id = _employee and p.status = 'active'
                    and public.is_company_manager(_user, p.company_id))
      or public.supervises(_user, _employee);
$$;

-- supervises
create or replace function public.supervises(_user uuid, _employee uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _user is not null and _employee is not null and _user <> _employee
     and exists (
       select 1
         from public.company_memberships p
         join public.supervisor_assignments a
           on a.company_id = p.company_id
          and a.department_id = p.department_id
          and a.supervisor_id = _user
          and (a.employee_id is null or a.employee_id = p.user_id)
        where p.user_id = _employee and p.status = 'active'
          and public.is_supervisor(_user, p.company_id)
     );
$$;

-- supervisor_assignments_guard
create or replace function public.supervisor_assignments_guard()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.departments d
                  where d.id = new.department_id and d.company_id = new.company_id) then
    raise exception 'that department is not in this company';
  end if;
  if not public.is_member(new.supervisor_id, new.company_id) then
    raise exception 'that supervisor is not in this company';
  end if;
  if new.employee_id is not null and not public.is_member(new.employee_id, new.company_id) then
    raise exception 'that person is not in this company';
  end if;
  return new;
end; $$;

-- is_supervisor
create or replace function public.is_supervisor(_user uuid, _company uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.has_role(_user, 'supervisor'::public.app_role, _company);
$$;

-- managed_employee_ids
create or replace function public.managed_employee_ids()
returns setof uuid language sql stable security definer set search_path = public
as $$
  select p.id
    from (select cm.user_id as id, cm.company_id
            from public.company_memberships cm
           where cm.status = 'active') p
   where p.company_id = public.current_company_id()
     and (public.is_company_manager(auth.uid(), p.company_id)
          or public.supervises(auth.uid(), p.id));
$$;

-- company_presence
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

  cid := public.current_company_id();
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
    pm.position,
    case
      when lp.kind is null or lp.kind = 'out' then 'off'
      when lp.kind = 'break_start' then 'on_break'
      else 'working'
    end
  from public.company_memberships pm
  join public.profiles pr on pr.id = pm.user_id
  left join last_punch lp on lp.user_id = pr.id
  left join public.member_visibility mv on mv.user_id = pr.id and mv.company_id = cid
  where pm.company_id = cid and pm.status = 'active'
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

-- manager_insert_punch
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

  cid := public.member_company(_user_id);
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

-- manager_record_absence
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

  cid := public.member_company(_employee);
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

-- manager_update_punch
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
          or (old_row.company_id = public.current_company_id()
              and public.can_manage_timecard(caller, old_row.user_id))) then
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

-- manager_delete_punch
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
          or (old_row.company_id = public.current_company_id()
              and public.can_manage_timecard(caller, old_row.user_id))) then
    raise exception 'not authorized';
  end if;

  delete from public.time_punches where id = _id;

  insert into public.time_punch_audit (punch_id, company_id, user_id, actor_id, action, reason, before, after)
  values (_id, old_row.company_id, old_row.user_id, caller, 'delete', coalesce(trim(_reason), ''),
          to_jsonb(old_row), null);
end;
$$;

-- decide_time_off
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
          or (r.company_id = public.current_company_id()
              and public.can_approve_time_off(caller, r.employee_id))) then
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

-- manager_remove_absence
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
          or (r.company_id = public.current_company_id()
              and public.can_approve_time_off(caller, r.employee_id))) then
    raise exception 'not authorized';
  end if;
  if r.status not in ('approved', 'pending') then raise exception 'this absence is already withdrawn'; end if;
  update public.time_off_requests set status = 'cancelled' where id = _request;
end;
$$;

-- manager_delete_punch_range
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
    if _user is not null and not (_company = public.current_company_id() and public.can_manage_timecard(caller, _user)) then
      raise exception 'not authorized';
    end if;
  end if;
  if _user is not null and not exists (
    select 1 from public.company_memberships where user_id = _user and company_id = _company
  ) then
    raise exception 'that person is not in that company';
  end if;

  for r in
    select * from public.time_punches tp
     where tp.company_id = _company
       and tp.at >= _from
       and tp.at < _to
       and (_user is null or tp.user_id = _user)
       and (manager or (tp.company_id = public.current_company_id() and public.can_manage_timecard(caller, tp.user_id)))
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


-- ------------------------------------------------------------ policies ----

drop policy if exists "punch_select_self_or_mgr" on public.time_punches;
create policy "punch_select_self_or_mgr" on public.time_punches for select to authenticated
  using (
    (user_id = auth.uid() and company_id = public.current_company_id())
    or (company_id = public.current_company_id()
        and public.has_role(auth.uid(), 'company_admin'::app_role, company_id))
    or public.has_role(auth.uid(), 'super_admin'::app_role)
    or (company_id = public.current_company_id() and public.supervises(auth.uid(), user_id))
  );

drop policy if exists timecard_notes_view on public.timecard_notes;
create policy timecard_notes_view on public.timecard_notes for select to authenticated
  using (
    (user_id = auth.uid() and company_id = public.current_company_id())
    or public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or (company_id = public.current_company_id() and public.supervises(auth.uid(), user_id))
  );

drop policy if exists "shifts_manage" on public.shifts;
create policy "shifts_manage" on public.shifts for all to authenticated
  using (
    public.is_company_manager(auth.uid(), company_id)
    or (employee_id is not null and company_id = public.current_company_id()
        and public.supervises(auth.uid(), employee_id))
    or (employee_id is null and public.can_manage_department(auth.uid(), company_id, department_id))
  )
  with check (
    public.is_company_manager(auth.uid(), company_id)
    or (employee_id is not null and public.supervises(auth.uid(), employee_id)
        and company_id = public.current_company_id()
        and public.is_member(employee_id, company_id))
    or (employee_id is null and public.can_manage_department(auth.uid(), company_id, department_id))
  );

drop policy if exists timecard_notes_manage on public.timecard_notes;
create policy timecard_notes_manage on public.timecard_notes for all to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or (company_id = public.current_company_id() and public.can_manage_timecard(auth.uid(), user_id))
  )
  with check (
    public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or (public.can_manage_timecard(auth.uid(), user_id)
        and company_id = public.current_company_id()
        and public.is_member(user_id, company_id))
  );

drop policy if exists "availability_manager_manage" on public.employee_availability;
create policy "availability_manager_manage" on public.employee_availability for all to authenticated
  using (public.is_company_manager(auth.uid(), company_id)
         or (company_id = public.current_company_id() and public.supervises(auth.uid(), employee_id)))
  with check (public.is_company_manager(auth.uid(), company_id)
              or (public.supervises(auth.uid(), employee_id)
                  and company_id = public.current_company_id()
                  and public.is_member(employee_id, company_id)));

drop policy if exists "timeoff_admin_update" on public.time_off_requests;
create policy "timeoff_admin_update" on public.time_off_requests for update to authenticated
  using (public.is_company_manager(auth.uid(), company_id)
         or (company_id = public.current_company_id() and public.can_approve_time_off(auth.uid(), employee_id)))
  with check (public.is_company_manager(auth.uid(), company_id)
              or (company_id = public.current_company_id() and public.can_approve_time_off(auth.uid(), employee_id)));

commit;

notify pgrst, 'reload schema';
