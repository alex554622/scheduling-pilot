-- Schedule: a supervisor can schedule everyone their schedule shows them.
--
-- A supervisor's schedule lists the people in the departments they run. Two
-- kinds of people were left off it, because shifts_manage only let a
-- supervisor write shifts for someone `supervises()` covers:
--
--   * the supervisor themself (`supervises()` is never true of yourself);
--   * someone shown under one of their departments by `schedule_department()`
--     without having that department set as their own: a supervisor or admin
--     whose department is blank but whose position, or the one department they
--     run, places them there.
--
-- `can_schedule()` covers both, and shifts_manage now uses it for a named
-- person's shift. Open shifts are unchanged (can_manage_department). Admins
-- are unchanged: they manage everyone. A supervisor still cannot touch a
-- shift outside their own departments.
--
-- Run after 20261208120000_dashboard_overnight_shifts.sql. Re-runnable;
-- applied by hand in Studio.

begin;

create or replace function public.can_schedule(_viewer uuid, _person uuid, _company uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _viewer is not null and _person is not null and (
       public.is_company_manager(_viewer, _company)
    or (public.is_supervisor(_viewer, _company)
        and public.is_member(_person, _company)
        and (_viewer = _person
             or public.supervises(_viewer, _person)
             or public.can_manage_department(
                  _viewer, _company, public.schedule_department(_person, _company))))
  );
$$;
revoke all on function public.can_schedule(uuid, uuid, uuid) from public, anon;
grant execute on function public.can_schedule(uuid, uuid, uuid) to authenticated;

drop policy if exists "shifts_manage" on public.shifts;
create policy "shifts_manage" on public.shifts for all to authenticated
  using (
    public.is_company_manager(auth.uid(), company_id)
    or (employee_id is not null and company_id = public.current_company_id()
        and public.can_schedule(auth.uid(), employee_id, company_id))
    or (employee_id is null and public.can_manage_department(auth.uid(), company_id, department_id))
  )
  with check (
    public.is_company_manager(auth.uid(), company_id)
    or (employee_id is not null and company_id = public.current_company_id()
        and public.can_schedule(auth.uid(), employee_id, company_id))
    or (employee_id is null and public.can_manage_department(auth.uid(), company_id, department_id))
  );

commit;

notify pgrst, 'reload schema';
