-- Who sees whom, on the schedule and on the dashboard.
--
-- Schedule: everyone in the company sees everyone's shifts and names, except
-- a person marked as a ghost (or "timecards only") in their Edit member
-- dialog, and an admin with no setting of their own while "Hide admins from
-- the rosters" is on. "Keep departments separate" no longer narrows the
-- schedule (open shifts still follow it). The hidden person still sees their
-- own shifts, admins see everything, and a supervisor still sees everyone they
-- supervise. Someone else's shift that is still a draft is seen only by the
-- admins and that person's supervisors (through shifts_manage), never by
-- coworkers. A supervisor can look at the other departments' schedule
-- read-only; only their own departments can be edited (shifts_manage, as
-- before).
--
-- Dashboard (who is in): an employee sees only themselves, unless an admin or
-- their supervisor lets their department see each other. That permission is
-- the rule `staff_see_coworkers`: a company default in App rules, and a team
-- rule per department in Settings → Team rules. On, it shows only coworkers in
-- the same department (never the whole company), ghosts left out. A
-- supervisor always sees every employee in the departments they supervise,
-- ghosts included. Admins see everyone.
--
-- Replaces the team rule "Employees see only themselves"
-- (`staff_see_only_self`, 20261201120000_department_see_only_self.sql): seeing
-- only yourself is now the default. Every company's App rule
-- `staff_see_coworkers` is reset to off, because it used to mean "the whole
-- company" and was on by default; turn it back on (company-wide or per team)
-- where employees should see their department.
--
-- Run after 20261201120000_department_see_only_self.sql. Re-runnable; applied
-- by hand in Studio.

begin;

-- ------------------------------------------------------------ team rule ----

create or replace function public.clean_team_rules(_rules jsonb)
returns jsonb language plpgsql immutable set search_path = public
as $$
declare
  k text;
  v jsonb;
  n numeric;
  out_rules jsonb := '{}'::jsonb;
begin
  if _rules is null then return out_rules; end if;
  if jsonb_typeof(_rules) <> 'object' then raise exception 'team rules must be an object'; end if;

  for k, v in select * from jsonb_each(_rules) loop
    -- null means "use the company's setting": leave the key out.
    if v is null or jsonb_typeof(v) = 'null' then continue; end if;
    -- Retired: seeing only yourself is the default now.
    if k = 'staff_see_only_self' then continue; end if;

    if k in ('require_geofence', 'require_gps', 'allow_kiosk', 'schedule_lateness',
             'allow_break_10', 'allow_break_30', 'allow_break_60', 'require_edit_note',
             'staff_see_coworkers') then
      if jsonb_typeof(v) <> 'boolean' then raise exception '% must be true or false', k; end if;
    elsif k = 'early_clock_in_minutes' and v = 'false'::jsonb then
      null; -- no limit for this team, whatever the company sets
    elsif k in ('early_clock_in_minutes', 'late_grace_minutes', 'punch_round_minutes') then
      if jsonb_typeof(v) <> 'number' then raise exception '% must be a number', k; end if;
      n := (v #>> '{}')::numeric;
      if n <> trunc(n) or n < 0 then raise exception '% must be a whole number of minutes', k; end if;
      if k = 'early_clock_in_minutes' and n > 720 then raise exception 'early clock-in can be at most 720 minutes'; end if;
      if k = 'late_grace_minutes' and n > 240 then raise exception 'the grace period can be at most 240 minutes'; end if;
      if k = 'punch_round_minutes' and n > 60 then raise exception 'rounding can be at most 60 minutes'; end if;
    elsif k in ('daily_overtime_hours', 'daily_double_time_hours', 'overtime_threshold_hours') then
      if jsonb_typeof(v) <> 'number' then raise exception '% must be a number', k; end if;
      n := (v #>> '{}')::numeric;
      if n < 0 or n > 168 then raise exception '% must be between 0 and 168 hours', k; end if;
    else
      raise exception 'unknown team rule: %', k;
    end if;

    out_rules := out_rules || jsonb_build_object(k, v);
  end loop;
  return out_rules;
end; $$;

update public.department_rules
   set rules = rules - 'staff_see_only_self'
 where rules ? 'staff_see_only_self';

-- Off everywhere until an admin or supervisor turns it on (see the header).
update public.companies
   set settings = settings - 'staff_see_coworkers'
 where settings ? 'staff_see_coworkers';

-- --------------------------------------------------------------- helpers ----

-- Is _person listed on _place ('schedule' or 'roster') for the company's staff?
-- The database copy of `hiddenFrom()` in src/lib/staff-visibility.ts.
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

-- May _viewer see _person's shifts? Everyone in the company, ghosts aside.
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

drop function if exists public.sees_only_self(uuid, uuid);

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

-- The people on the schedule: names for the posted schedule, and the rows of
-- a supervisor's read-only view of every department. `company_members` still follows "Keep
-- departments separate", so the schedule asks here instead.
drop function if exists public.schedule_roster();
create function public.schedule_roster()
returns table (id uuid, full_name text, "position" text, department_id uuid)
language sql stable security definer set search_path = public
as $$
  select pr.id, pr.full_name, m.position, m.department_id
    from public.company_memberships m
    join public.profiles pr on pr.id = m.user_id
   where m.company_id = public.current_company_id()
     and m.status = 'active'
     and public.can_see_schedule(auth.uid(), m.user_id, m.company_id)
   order by pr.full_name;
$$;
revoke all on function public.schedule_roster() from public, anon;
grant execute on function public.schedule_roster() to authenticated;

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
  -- The company's App rule with the caller's team rule laid over it.
  see_team := coalesce((public.member_rules(auth.uid(), cid) ->> 'staff_see_coworkers')::boolean, false);
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
      -- an employee whose team may see each other: their own department only
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
