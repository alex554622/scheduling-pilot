-- Merge the supervisor role into company_admin.
--
-- The two roles differed only in reach: supervisors could be narrowed to named
-- departments, company admins always ran the whole company. One role is simpler
-- to explain and to gate, so supervisor disappears and everyone who had it gets
-- full company_admin powers.
--
-- The 'supervisor' enum label stays in app_role. Removing a value means
-- recreating the type, which means dropping has_role(uuid, app_role, uuid) and
-- every policy that calls it — most of the schema. A CHECK constraint retires
-- the value just as effectively.

-- ---- promote existing supervisors ----

insert into public.user_roles (user_id, company_id, role)
select user_id, company_id, 'company_admin'::public.app_role
from public.user_roles
where role = 'supervisor'::public.app_role
on conflict (user_id, company_id, role) do nothing;

delete from public.user_roles where role = 'supervisor'::public.app_role;

alter table public.user_roles
  add constraint user_roles_supervisor_retired
  check (role <> 'supervisor'::public.app_role);

-- ---- the manager test is now just "company admin" ----

create or replace function public.is_company_manager(_user uuid, _company uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.has_role(_user, 'company_admin'::app_role, _company)
      or public.has_role(_user, 'super_admin'::app_role);
$$;
-- RLS policies below call this, and a policy can only call functions the
-- querying role may execute — it was previously reachable only from
-- generate_schedule (security definer), so authenticated was never granted it.
revoke all on function public.is_company_manager(uuid, uuid) from public, anon;
grant execute on function public.is_company_manager(uuid, uuid) to authenticated;

-- ---- drop the supervisor clause from every policy that carried one ----

drop policy "audit_logs_manager_read" on public.audit_logs;
create policy "audit_logs_manager_read" on public.audit_logs for select to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    or (company_id is not null and public.has_role(auth.uid(), 'company_admin'::app_role, company_id))
  );

drop policy "availability_manager_manage" on public.employee_availability;
create policy "availability_manager_manage" on public.employee_availability for all to authenticated
  using (public.is_company_manager(auth.uid(), company_id))
  with check (public.is_company_manager(auth.uid(), company_id));

drop policy "employee_positions_manage" on public.employee_positions;
create policy "employee_positions_manage" on public.employee_positions for all to authenticated
  using (public.is_company_manager(auth.uid(), company_id))
  with check (public.is_company_manager(auth.uid(), company_id));

drop policy "trades_party_update" on public.shift_trades;
create policy "trades_party_update" on public.shift_trades for update to authenticated
  using (
    from_employee_id = auth.uid()
    or to_employee_id = auth.uid()
    or public.has_role(auth.uid(), 'company_admin'::app_role, company_id)
  )
  with check (
    from_employee_id = auth.uid()
    or to_employee_id = auth.uid()
    or public.has_role(auth.uid(), 'company_admin'::app_role, company_id)
  );

drop policy "punch_select_self_or_mgr" on public.time_punches;
create policy "punch_select_self_or_mgr" on public.time_punches for select to authenticated
  using (
    user_id = auth.uid()
    or (company_id = public.current_company_id()
        and public.has_role(auth.uid(), 'company_admin'::app_role, company_id))
    or public.has_role(auth.uid(), 'super_admin'::app_role)
  );

-- ---- department scoping is gone: back to a plain company check ----

drop policy "shifts_manage" on public.shifts;
create policy "shifts_manage" on public.shifts for all to authenticated
  using (public.is_company_manager(auth.uid(), company_id))
  with check (public.is_company_manager(auth.uid(), company_id));

drop policy "schedules_manager_manage" on public.schedules;
create policy "schedules_manager_manage" on public.schedules for all to authenticated
  using (public.is_company_manager(auth.uid(), company_id))
  with check (public.is_company_manager(auth.uid(), company_id));

drop policy "schedules_view_manager" on public.schedules;
create policy "schedules_view_manager" on public.schedules for select to authenticated
  using (public.is_company_manager(auth.uid(), company_id));

drop policy "timeoff_admin_update" on public.time_off_requests;
create policy "timeoff_admin_update" on public.time_off_requests for update to authenticated
  using (public.is_company_manager(auth.uid(), company_id))
  with check (public.is_company_manager(auth.uid(), company_id));

