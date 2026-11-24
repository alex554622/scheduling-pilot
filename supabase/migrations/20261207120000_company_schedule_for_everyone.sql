-- The company-wide schedule, for everyone, with every active person on it.
--
-- Why people were missing: the weekly schedule grid made a row only for
-- someone who had a shift (or approved time off) that week, so anyone not yet
-- scheduled simply was not there. An employee never got a list of people at
-- all, only the published shifts. The page now draws a row for every active
-- member under their department, shift or no shift; this migration gives every
-- member what that needs:
--
--   * schedule_roster(): every active member the caller may see on the
--     schedule (ghosts and, while "Hide admins from the rosters" is on, admins
--     aside), with the department they are shown under. Someone with no
--     department of their own is placed by their position's department, or by
--     the one department they supervise, when there is exactly one — the same
--     rule the builder uses (placeInDepartments in schedule.tsx).
--   * schedule_time_off(from, to): approved days off of those same people, so
--     the schedule can show who is off. Coworkers see only "Day off"; the
--     person themselves, their supervisors and admins see the kind (sick,
--     vacation, ...).
--   * shifts_view / can_see_schedule / listed_for_staff: as in
--     20261205120000_open_schedule_team_dashboard.sql, repeated so this file is
--     enough on its own. Published shifts are readable company-wide; drafts
--     only by their owner, admins and that person's supervisors. Viewing stays
--     separate from editing: shifts_manage is untouched, so a supervisor still
--     edits only their own departments and employees edit nothing.
--   * company_presence(): "Employees can see their department on the
--     dashboard" (staff_see_coworkers) now defaults to on. An employee or
--     supervisor sees who is working in their own department; a supervisor
--     also sees the departments they run; admins see everyone. A company or
--     position that turned it off keeps it off.
--
-- Run after 20261206130000_supervisor_absences_need_admin.sql. Re-runnable;
-- applied by hand in Studio.

begin;

-- --------------------------------------------------------------- helpers ----

create or replace function public.listed_for_staff(_person uuid, _company uuid, _place text)
returns boolean language sql stable security definer set search_path = public
as $$
  select case coalesce((select mv.mode from public.member_visibility mv
                         where mv.user_id = _person and mv.company_id = _company), '')
    when 'ghost' then false
    when 'timecards_only' then _place <> 'schedule'
    when '' then not (
      coalesce((select (c.settings ->> 'hide_admins_from_staff')::boolean
                  from public.companies c where c.id = _company), true)
      and exists (select 1 from public.user_roles ur
                   where ur.user_id = _person
                     and ur.role in ('super_admin', 'company_admin')
                     and (ur.company_id = _company or ur.company_id is null)))
    else true
  end;
$$;
revoke all on function public.listed_for_staff(uuid, uuid, text) from public, anon;
grant execute on function public.listed_for_staff(uuid, uuid, text) to authenticated;

create or replace function public.can_see_schedule(_viewer uuid, _person uuid, _company uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _viewer is not null and (
       _viewer = _person
    or public.is_company_manager(_viewer, _company)
    or public.has_role(_viewer, 'super_admin'::public.app_role)
    or public.supervises(_viewer, _person)
    or (public.is_member(_viewer, _company)
        and public.is_member(_person, _company)
        and public.listed_for_staff(_person, _company, 'schedule'))
  );
$$;
revoke all on function public.can_see_schedule(uuid, uuid, uuid) from public, anon;
grant execute on function public.can_see_schedule(uuid, uuid, uuid) to authenticated;

drop policy if exists "shifts_view" on public.shifts;
create policy "shifts_view" on public.shifts for select to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin'::public.app_role)
    or (company_id = public.current_company_id()
        and case when employee_id is null
                 then public.can_see_department(auth.uid(), company_id, department_id)
                 else public.can_see_schedule(auth.uid(), employee_id, company_id)
                      and (published
                           or employee_id = auth.uid()
                           or public.is_company_manager(auth.uid(), company_id))
            end)
  );

-- The department a member is shown under on the schedule: their own; else the
-- one department their position belongs to; else the one department they
-- supervise. Null when none of those names exactly one department.
create or replace function public.schedule_department(_user uuid, _company uuid)
returns uuid language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select d.id
       from public.company_memberships m
       join public.departments d on d.id = m.department_id and d.company_id = m.company_id
      where m.user_id = _user and m.company_id = _company and m.status = 'active'
      limit 1),
    (select (array_agg(distinct dp.department_id))[1]
       from public.company_memberships m
       join public.department_positions dp
         on dp.position_id = m.position_id and dp.company_id = m.company_id
       join public.departments d on d.id = dp.department_id
      where m.user_id = _user and m.company_id = _company and m.status = 'active'
     having count(distinct dp.department_id) = 1),
    (select (array_agg(distinct sa.department_id))[1]
       from public.supervisor_assignments sa
       join public.departments d on d.id = sa.department_id
      where sa.supervisor_id = _user and sa.company_id = _company and sa.employee_id is null
     having count(distinct sa.department_id) = 1)
  );
$$;
revoke all on function public.schedule_department(uuid, uuid) from public, anon;
grant execute on function public.schedule_department(uuid, uuid) to authenticated;

-- ------------------------------------------------------------- roster ----

-- Everyone on the schedule, for every viewer. `company_members` follows "Keep
-- departments separate"; the schedule does not, so it asks here.
drop function if exists public.schedule_roster();
create function public.schedule_roster()
returns table (id uuid, full_name text, "position" text, position_id uuid, department_id uuid)
language sql stable security definer set search_path = public
as $$
  select pr.id, pr.full_name, m.position, m.position_id,
         public.schedule_department(m.user_id, m.company_id)
    from public.company_memberships m
    join public.profiles pr on pr.id = m.user_id
   where m.company_id = public.current_company_id()
     and m.status = 'active'
     and public.can_see_schedule(auth.uid(), m.user_id, m.company_id)
   order by pr.full_name;
$$;
revoke all on function public.schedule_roster() from public, anon;
grant execute on function public.schedule_roster() to authenticated;

-- Approved days off touching [_from, _to] (inclusive), of the people on the
-- caller's schedule. Only the kind is told, and to coworkers only "other".
create or replace function public.schedule_time_off(_from date, _to date)
returns table (employee_id uuid, start_date date, end_date date, kind text)
language sql stable security definer set search_path = public
as $$
  select t.employee_id, t.start_date, t.end_date,
         case when t.employee_id = auth.uid()
                or public.is_company_manager(auth.uid(), t.company_id)
                or public.supervises(auth.uid(), t.employee_id)
              then t.kind else 'other' end
    from public.time_off_requests t
   where t.company_id = public.current_company_id()
     and t.status = 'approved'
     and t.start_date <= _to
     and t.end_date >= _from
     and public.can_see_schedule(auth.uid(), t.employee_id, t.company_id);
$$;
revoke all on function public.schedule_time_off(date, date) from public, anon;
grant execute on function public.schedule_time_off(date, date) to authenticated;

-- ------------------------------------------------------------ who is in ----

create or replace function public.company_presence()
returns table (user_id uuid, full_name text, job_title text, status text)
language plpgsql stable security definer set search_path = public
as $$
declare
  cid uuid;
  tz text;
  day_start timestamptz;
  manager boolean;
  see_team boolean;
  my_dept uuid;
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

  manager := public.is_company_manager(auth.uid(), cid)
             or public.has_role(auth.uid(), 'super_admin'::public.app_role);
  -- The company's App rule with the caller's position rule laid over it. On
  -- unless one of them turned it off.
  see_team := coalesce((public.member_rules(auth.uid(), cid) ->> 'staff_see_coworkers')::boolean, true);
  my_dept := public.member_department(auth.uid(), cid);

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
  where pm.company_id = cid and pm.status = 'active'
    and (
      manager
      or pr.id = auth.uid()
      -- a supervisor: everyone in the departments they run
      or public.supervises(auth.uid(), pr.id)
      -- anyone whose department may see each other: their own department only
      or (see_team
          and my_dept is not null
          and pm.department_id = my_dept
          and public.listed_for_staff(pr.id, cid, 'roster'))
    )
  order by pr.full_name;
end; $$;
revoke all on function public.company_presence() from public, anon;
grant execute on function public.company_presence() to authenticated;

commit;

notify pgrst, 'reload schema';
