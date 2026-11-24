-- ===== supabase\migrations\20261205120000_open_schedule_team_dashboard.sql =====
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
-- rule per department in Settings â†’ Team rules. On, it shows only coworkers in
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


-- ===== supabase\migrations\20261206120000_position_rules.sql =====
-- Position rules: employment rules follow a person's position, not their
-- department. And an optional automatic meal-break deduction per position.
--
-- Run AFTER 20261205120000_open_schedule_team_dashboard.sql (and so after
-- 20261128120000_team_rules.sql and 20261127120000_org_structure_assignments.sql).
--
-- 1. position_rules (one row per position) replaces department_rules. It holds
--    only the settings that position changes; anything it leaves out comes from
--    companies.settings (App rules). The effective rules for a person are
--        companies.settings || position_rules.rules
--    for the position their membership in that company holds
--    (company_memberships.position_id). member_rules() is redefined to read
--    them, so clock_punch, break_punch, the kiosk, lateness, the edit-note
--    trigger and the dashboard's company_presence() all follow the position
--    without being touched here.
--
--    Keys a position may set: every team-rule key (see clean_position_rules),
--    plus
--      cap_break_to_length      bool  as the company setting
--      break_reminder_hours     num   as the company setting (0 = off)
--      lunch_reminder_hours     num   as the company setting (0 = off)
--      auto_meal_minutes        int   0 = off (employees punch their own meal
--                                     break); otherwise minutes taken off a
--                                     shift as an automatic unpaid meal break
--      auto_meal_after_hours    num   only shifts at least this long get it
--    Paid meal breaks and the shift differential stay where they already are,
--    on the positions row (20261126130000_position_pay_rules.sql).
--
--    Only company admins (and super admins) create, change or delete position
--    rules. Supervisors can no longer edit any rules.
--
-- 2. Carry-over. Each position gets the team rules of the department most of
--    its holders are in (ties: the department's name, then id). A position
--    whose holders sat in departments with different rules is reported with a
--    NOTICE, as is anyone who had team rules but holds no position â€” they
--    follow the App rules until an admin gives them a position. A position
--    that already has a row is never overwritten, so a re-run keeps edits.
--    department_rules is kept, read-only, as the record of what was there.
--
-- 3. Automatic meal break. Worked out on the time card (src/lib/timecard-totals.ts),
--    never stored, like every other hour on the card. A finished shift at least
--    auto_meal_after_hours long, with no 30- or 60-minute break punched during
--    it, has auto_meal_minutes taken off as unpaid. meal_break_adjustments
--    holds, per shift (its clock-in punch):
--      * the employee's report that the meal break was missed, cut short or
--        interrupted (report_meal_break), and
--      * an admin's or supervisor's correction: the minutes to take off instead,
--        0 to remove it (set_meal_deduction).
--    Nobody writes the table directly. Every change is in audit_logs
--    (entity 'meal_break_adjustment'), as is every position-rule change
--    ('position_rule').
--
-- Re-runnable. Paste the whole file into the Studio SQL editor.

begin;

do $$
begin
  if to_regclass('public.department_rules') is null
     or to_regprocedure('public.member_rules(uuid, uuid)') is null
     or to_regprocedure('public.can_manage_timecard(uuid, uuid)') is null
     or to_regprocedure('public.write_audit_log()') is null then
    raise exception 'team rules, supervisor scope or audit log migrations are missing; apply those first';
  end if;
end;
$$;

-- ------------------------------------------------------------ validation ----

create or replace function public.clean_position_rules(_rules jsonb)
returns jsonb language plpgsql immutable set search_path = public
as $$
declare
  k text;
  v jsonb;
  n numeric;
  out_rules jsonb := '{}'::jsonb;
begin
  if _rules is null then return out_rules; end if;
  if jsonb_typeof(_rules) <> 'object' then raise exception 'position rules must be an object'; end if;

  for k, v in select * from jsonb_each(_rules) loop
    -- null means "use the company's setting": leave the key out.
    if v is null or jsonb_typeof(v) = 'null' then continue; end if;
    -- Retired team rule.
    if k = 'staff_see_only_self' then continue; end if;

    if k in ('require_geofence', 'require_gps', 'allow_kiosk', 'schedule_lateness',
             'allow_break_10', 'allow_break_30', 'allow_break_60', 'require_edit_note',
             'staff_see_coworkers', 'cap_break_to_length') then
      if jsonb_typeof(v) <> 'boolean' then raise exception '% must be true or false', k; end if;
    elsif k = 'early_clock_in_minutes' and v = 'false'::jsonb then
      null; -- no limit for this position, whatever the company sets
    elsif k in ('early_clock_in_minutes', 'late_grace_minutes', 'punch_round_minutes', 'auto_meal_minutes') then
      if jsonb_typeof(v) <> 'number' then raise exception '% must be a number', k; end if;
      n := (v #>> '{}')::numeric;
      if n <> trunc(n) or n < 0 then raise exception '% must be a whole number of minutes', k; end if;
      if k = 'early_clock_in_minutes' and n > 720 then raise exception 'early clock-in can be at most 720 minutes'; end if;
      if k = 'late_grace_minutes' and n > 240 then raise exception 'the grace period can be at most 240 minutes'; end if;
      if k = 'punch_round_minutes' and n > 60 then raise exception 'rounding can be at most 60 minutes'; end if;
      if k = 'auto_meal_minutes' and n > 180 then raise exception 'an automatic meal break can be at most 180 minutes'; end if;
    elsif k in ('daily_overtime_hours', 'daily_double_time_hours', 'overtime_threshold_hours') then
      if jsonb_typeof(v) <> 'number' then raise exception '% must be a number', k; end if;
      n := (v #>> '{}')::numeric;
      if n < 0 or n > 168 then raise exception '% must be between 0 and 168 hours', k; end if;
    elsif k in ('break_reminder_hours', 'lunch_reminder_hours', 'auto_meal_after_hours') then
      if jsonb_typeof(v) <> 'number' then raise exception '% must be a number', k; end if;
      n := (v #>> '{}')::numeric;
      if n < 0 or n > 24 then raise exception '% must be between 0 and 24 hours', k; end if;
    else
      raise exception 'unknown position rule: %', k;
    end if;

    out_rules := out_rules || jsonb_build_object(k, v);
  end loop;
  return out_rules;
end; $$;

-- ---------------------------------------------------------------- table ----

create table if not exists public.position_rules (
  id          uuid not null default gen_random_uuid() unique,
  position_id uuid primary key references public.positions(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  rules       jsonb not null default '{}'::jsonb,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);
create index if not exists position_rules_company_idx on public.position_rules(company_id);

create or replace function public.position_rules_guard()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  select p.company_id into new.company_id from public.positions p where p.id = new.position_id;
  if new.company_id is null then raise exception 'that position does not exist'; end if;
  new.rules := public.clean_position_rules(new.rules);
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end; $$;

drop trigger if exists position_rules_guard on public.position_rules;
create trigger position_rules_guard
  before insert or update on public.position_rules
  for each row execute function public.position_rules_guard();

drop trigger if exists trg_audit_position_rules on public.position_rules;
create trigger trg_audit_position_rules
  after insert or update or delete on public.position_rules
  for each row execute function public.write_audit_log('position_rule');

-- Company admins and super admins only. Supervisors never.
create or replace function public.can_manage_position_rules(_user uuid, _position uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _user is not null and exists (
    select 1 from public.positions p
     where p.id = _position
       and public.is_company_manager(_user, p.company_id)
  );
$$;
revoke all on function public.can_manage_position_rules(uuid, uuid) from public, anon;
grant execute on function public.can_manage_position_rules(uuid, uuid) to authenticated;

alter table public.position_rules enable row level security;
revoke all on public.position_rules from anon;
grant select, insert, update, delete on public.position_rules to authenticated;
grant all on public.position_rules to service_role;

-- Everyone in the company reads them: the time clock and the card need their own.
drop policy if exists position_rules_select on public.position_rules;
create policy position_rules_select on public.position_rules for select to authenticated
  using (public.is_member(auth.uid(), company_id)
         or public.has_role(auth.uid(), 'super_admin'::public.app_role));

drop policy if exists position_rules_insert on public.position_rules;
create policy position_rules_insert on public.position_rules for insert to authenticated
  with check (public.can_manage_position_rules(auth.uid(), position_id));

drop policy if exists position_rules_update on public.position_rules;
create policy position_rules_update on public.position_rules for update to authenticated
  using (public.can_manage_position_rules(auth.uid(), position_id))
  with check (public.can_manage_position_rules(auth.uid(), position_id));

drop policy if exists position_rules_delete on public.position_rules;
create policy position_rules_delete on public.position_rules for delete to authenticated
  using (public.can_manage_position_rules(auth.uid(), position_id));

-- ----------------------------------------------------------- carry-over ----

do $$
declare
  r record;
begin
  -- Positions whose holders' departments set different rules.
  for r in
    select p.name as position_name, c.name as company_name,
           count(distinct dr.rules) as variants
      from public.company_memberships m
      join public.department_rules dr on dr.department_id = m.department_id
      join public.positions p on p.id = m.position_id
      join public.companies c on c.id = m.company_id
     where m.status = 'active' and dr.rules <> '{}'::jsonb
       and not exists (select 1 from public.position_rules pr where pr.position_id = p.id)
     group by p.id, p.name, c.name
    having count(distinct dr.rules) > 1
  loop
    raise notice 'position "%" (%): its holders were in departments with % different team rules; the rules of the department most of them are in were kept. Check it under Settings â†’ Position rules.',
      r.position_name, r.company_name, r.variants;
  end loop;

  for r in
    select c.name as company_name, count(*) as people
      from public.company_memberships m
      join public.department_rules dr on dr.department_id = m.department_id
      join public.companies c on c.id = m.company_id
     where m.status = 'active' and m.position_id is null and dr.rules <> '{}'::jsonb
     group by c.name
  loop
    raise notice '%: % people had team rules but hold no position; they follow the App rules until they are given a position.',
      r.company_name, r.people;
  end loop;
end;
$$;

insert into public.position_rules (position_id, company_id, rules)
select distinct on (pick.position_id) pick.position_id, pick.company_id, pick.rules
  from (
    select m.position_id, m.company_id, dr.rules, d.name as dept_name, d.id as dept_id,
           count(*) as holders
      from public.company_memberships m
      join public.department_rules dr on dr.department_id = m.department_id
      join public.departments d on d.id = m.department_id
      join public.positions p on p.id = m.position_id and p.company_id = m.company_id
     where m.status = 'active' and m.position_id is not null
       and (dr.rules - 'staff_see_only_self') <> '{}'::jsonb
     group by m.position_id, m.company_id, dr.rules, d.name, d.id
  ) pick
 order by pick.position_id, pick.holders desc, pick.dept_name, pick.dept_id
on conflict (position_id) do nothing;

-- ------------------------------------------------- retire department rules ----

-- Kept as a record, no longer written or read by the rules.
drop policy if exists department_rules_insert on public.department_rules;
drop policy if exists department_rules_update on public.department_rules;
drop policy if exists department_rules_delete on public.department_rules;
revoke insert, update, delete on public.department_rules from authenticated;

-- A screen built before this asks which teams it may edit: none now.
create or replace function public.my_rule_departments()
returns setof uuid language sql stable security definer set search_path = public
as $$
  select null::uuid where false;
$$;

-- -------------------------------------------------------- effective rules ----

create or replace function public.member_rules(_user uuid, _company uuid)
returns jsonb language sql stable security definer set search_path = public
as $$
  select coalesce((select c.settings from public.companies c where c.id = _company), '{}'::jsonb)
      || coalesce((select pr.rules
                     from public.company_memberships m
                     join public.position_rules pr on pr.position_id = m.position_id
                    where m.user_id = _user and m.company_id = _company
                    limit 1), '{}'::jsonb);
$$;
revoke all on function public.member_rules(uuid, uuid) from public, anon, authenticated;

-- The edit-note trigger's wording said "this team".
create or replace function public.require_edit_note()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.actor_id is null or new.actor_id = new.user_id then return new; end if;
  if coalesce(trim(new.reason), '') <> '' then return new; end if;
  if coalesce((public.member_rules(new.user_id, new.company_id)->>'require_edit_note')::boolean, false) then
    raise exception 'A note is required when changing time for this position. Say why in the note box.';
  end if;
  return new;
end; $$;

-- ------------------------------------------------- automatic meal break ----

create table if not exists public.meal_break_adjustments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  -- The shift, by its clock-in punch.
  in_punch_id     uuid not null unique references public.time_punches(id) on delete cascade,
  -- The employee's report.
  report_kind     text check (report_kind in ('missed', 'short', 'interrupted')),
  report_minutes  integer check (report_minutes between 0 and 180),
  report_note     text,
  reported_at     timestamptz,
  -- An admin's or supervisor's correction: minutes to take off instead of the
  -- rule's. 0 removes the deduction. null = the position's rule.
  deduct_minutes  integer check (deduct_minutes between 0 and 180),
  decision_note   text,
  decided_by      uuid references auth.users(id) on delete set null,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists meal_break_adjustments_user_idx
  on public.meal_break_adjustments (company_id, user_id);

drop trigger if exists trg_audit_meal_break_adjustments on public.meal_break_adjustments;
create trigger trg_audit_meal_break_adjustments
  after insert or update or delete on public.meal_break_adjustments
  for each row execute function public.write_audit_log('meal_break_adjustment');

alter table public.meal_break_adjustments enable row level security;
revoke all on public.meal_break_adjustments from anon;
-- Read only: every change goes through the functions below.
revoke insert, update, delete on public.meal_break_adjustments from authenticated;
grant select on public.meal_break_adjustments to authenticated;
grant all on public.meal_break_adjustments to service_role;

-- The person themselves, an admin, or a supervisor of theirs.
drop policy if exists meal_break_adjustments_select on public.meal_break_adjustments;
create policy meal_break_adjustments_select on public.meal_break_adjustments for select to authenticated
  using (user_id = auth.uid()
         or public.can_manage_employee(auth.uid(), user_id)
         or public.has_role(auth.uid(), 'super_admin'::public.app_role));

-- The employee: "my meal break on this shift was missed / cut short /
-- interrupted". _kind null withdraws the report. Changes no hours by itself;
-- the admins and the person's supervisors are told so they can correct it.
create or replace function public.report_meal_break(
  _in_punch uuid, _kind text, _minutes integer default null, _note text default null
)
returns public.meal_break_adjustments
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  p public.time_punches;
  row public.meal_break_adjustments;
  who text;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into p from public.time_punches where id = _in_punch;
  if p.id is null or p.kind <> 'in' then raise exception 'that shift was not found'; end if;
  if p.user_id <> uid then raise exception 'you can only report your own meal breaks'; end if;
  if _kind is not null and _kind not in ('missed', 'short', 'interrupted') then
    raise exception 'say whether the meal break was missed, cut short or interrupted';
  end if;
  if _kind = 'missed' then _minutes := 0; end if;
  if _kind is not null and _kind <> 'missed' and (_minutes is null or _minutes < 0 or _minutes > 180) then
    raise exception 'say how many minutes of meal break you got';
  end if;

  insert into public.meal_break_adjustments
    (company_id, user_id, in_punch_id, report_kind, report_minutes, report_note, reported_at)
  values (p.company_id, uid, p.id, _kind, case when _kind is null then null else _minutes end,
          nullif(trim(coalesce(_note, '')), ''), case when _kind is null then null else now() end)
  on conflict (in_punch_id) do update
     set report_kind = excluded.report_kind,
         report_minutes = excluded.report_minutes,
         report_note = excluded.report_note,
         reported_at = excluded.reported_at,
         updated_at = now()
  returning * into row;

  if _kind is not null then
    select coalesce(nullif(trim(full_name), ''), 'An employee') into who
      from public.profiles where id = uid;
    insert into public.notifications (user_id, type, title, body, link)
    select distinct ur.user_id, 'meal_break_report', 'Meal break reported',
           format('%s reported a %s meal break on %s.', who,
                  case _kind when 'missed' then 'missed' when 'short' then 'shortened' else 'interrupted' end,
                  to_char(p.at at time zone coalesce((select nullif(c.timezone, '') from public.companies c where c.id = p.company_id), 'UTC'),
                          'Mon FMDD')),
           '/timecards'
      from public.user_roles ur
      join public.company_memberships m
        on m.user_id = ur.user_id and m.company_id = ur.company_id and m.status = 'active'
     where ur.company_id = p.company_id
       and ur.user_id <> uid
       and (ur.role = 'company_admin'::public.app_role
            or (ur.role = 'supervisor'::public.app_role and public.supervises(ur.user_id, uid)))
       and public.wants_notification(ur.user_id, 'meal_break_report');
  end if;
  return row;
end; $$;
revoke all on function public.report_meal_break(uuid, text, integer, text) from public, anon;
grant execute on function public.report_meal_break(uuid, text, integer, text) to authenticated;

-- An admin, or a supervisor allowed to edit this person's timecard: take
-- _minutes off this shift instead of the rule's (0 removes the deduction), or
-- _minutes null to go back to the rule. A supervisor never corrects their own.
create or replace function public.set_meal_deduction(
  _in_punch uuid, _minutes integer, _note text default null
)
returns public.meal_break_adjustments
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  p public.time_punches;
  row public.meal_break_adjustments;
  note text := nullif(trim(coalesce(_note, '')), '');
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into p from public.time_punches where id = _in_punch;
  if p.id is null or p.kind <> 'in' then raise exception 'that shift was not found'; end if;
  if not (public.is_company_manager(uid, p.company_id)
          or (p.user_id <> uid and public.can_manage_timecard(uid, p.user_id))) then
    raise exception 'not authorized to change this time card';
  end if;
  if _minutes is not null and (_minutes < 0 or _minutes > 180) then
    raise exception 'a meal break deduction is between 0 and 180 minutes';
  end if;
  if note is null and p.user_id <> uid
     and coalesce((public.member_rules(p.user_id, p.company_id)->>'require_edit_note')::boolean, false) then
    raise exception 'A note is required when changing time for this position. Say why in the note box.';
  end if;

  insert into public.meal_break_adjustments
    (company_id, user_id, in_punch_id, deduct_minutes, decision_note, decided_by, decided_at)
  values (p.company_id, p.user_id, p.id, _minutes, note, uid, now())
  on conflict (in_punch_id) do update
     set deduct_minutes = excluded.deduct_minutes,
         decision_note = excluded.decision_note,
         decided_by = excluded.decided_by,
         decided_at = excluded.decided_at,
         updated_at = now()
  returning * into row;

  -- Tell the employee when it answers their report.
  if row.report_kind is not null and p.user_id <> uid
     and public.wants_notification(p.user_id, 'meal_break_report') then
    insert into public.notifications (user_id, type, title, body, link)
    values (p.user_id, 'meal_break_report', 'Meal break reviewed',
            case when _minutes is null then 'Your meal break report was reviewed: the usual deduction stands.'
                 when _minutes = 0 then 'Your meal break report was reviewed: no meal break was deducted from that shift.'
                 else format('Your meal break report was reviewed: %s min was deducted from that shift.', _minutes)
            end,
            '/timecards');
  end if;
  return row;
end; $$;
revoke all on function public.set_meal_deduction(uuid, integer, text) from public, anon;
grant execute on function public.set_meal_deduction(uuid, integer, text) to authenticated;

commit;

notify pgrst, 'reload schema';


-- ===== supabase\migrations\20261206130000_supervisor_absences_need_admin.sql =====
-- A supervisor's absence goes to an admin for the final answer.
--
-- Until now "Mark an absence" on a time card wrote time off as already
-- approved, and cleared the person's shifts, whoever pressed it. For a
-- supervisor that skipped the admin's final approval that every other time-off
-- request needs (20261128120000_request_approval_chain.sql).
--
-- Now:
--   * An admin's absence is unchanged: approved at once, shifts opened.
--   * A supervisor's absence is a pending time-off request that counts as their
--     own approval. Any other supervisor of the person still has to approve it,
--     as with a request the employee made; then it waits on an admin, who is
--     told. Shifts are opened only when the admin approves (decide_time_off),
--     and the employee hears the final answer from record_admin_decision.
--   * A supervisor can withdraw an absence they recorded while it is still
--     pending. Time off an admin has approved, and requests other people made,
--     are no longer theirs to remove (they answer those with Approve/Deny).
--     An admin can still remove any.
--
-- time_off_requests.recorded_by says who marked an absence from a time card
-- (null: the employee asked for it on the Time off page).
--
-- Run after 20261128120000_request_approval_chain.sql. Re-runnable; applied by
-- hand in Studio.

begin;

do $$
begin
  if to_regprocedure('public.supervisor_decide(text, uuid, boolean, text)') is null
     or to_regprocedure('public.route_request(text, uuid)') is null then
    raise exception 'the request approval chain migration is missing; apply it first';
  end if;
end;
$$;

alter table public.time_off_requests
  add column if not exists recorded_by uuid references auth.users(id) on delete set null;

-- The app can't set it directly: only the function below writes it.
create or replace function public.time_off_requests_guard()
returns trigger language plpgsql set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.approval_stage := null;
    new.recorded_by := null;
    return new;
  end if;
  if new.status is distinct from old.status
     or new.approval_stage is distinct from old.approval_stage
     or new.employee_id is distinct from old.employee_id
     or new.company_id is distinct from old.company_id
     or new.start_date is distinct from old.start_date
     or new.end_date is distinct from old.end_date
     or new.recorded_by is distinct from old.recorded_by then
    raise exception 'time-off requests are answered with the Approve and Deny buttons';
  end if;
  return new;
end; $$;

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
  admin boolean;
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
  admin := public.is_company_manager(caller, cid);
  if not (admin or public.can_approve_time_off(caller, _employee)) then
    raise exception 'not authorized';
  end if;

  if admin then
    insert into public.time_off_requests
      (company_id, employee_id, kind, start_date, end_date, status, note, recorded_by)
    values (cid, _employee, _kind, _start, _end, 'approved',
            nullif(trim(coalesce(_note, '')), ''), caller)
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
  end if;

  -- A supervisor: a pending request, routed like any other (the insert
  -- trigger calls route_request), with their own approval already given.
  if cid is distinct from public.current_company_id() then
    raise exception 'switch to that company first';
  end if;
  insert into public.time_off_requests
    (company_id, employee_id, kind, start_date, end_date, status, note, recorded_by)
  values (cid, _employee, _kind, _start, _end, 'pending',
          nullif(trim(coalesce(_note, '')), ''), caller)
  returning id into new_id;

  -- route_request asked the caller to approve what they just recorded.
  delete from public.notifications
   where user_id = caller and type = 'approval_needed' and created_at = now();

  -- Their approval; it moves to the admins once no other supervisor is left.
  -- (Without a row of their own â€” route_request found none â€” it is already
  -- with the admins or the other supervisors.)
  if exists (select 1 from public.request_approvals a
              where a.request_type = 'time_off' and a.request_id = new_id
                and a.approver_id = caller and a.stage = 'supervisor') then
    perform public.supervisor_decide('time_off', new_id, true, 'Recorded as an absence from the time card');
  end if;

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
  if r.status not in ('approved', 'pending') then raise exception 'this absence is already withdrawn'; end if;

  if public.is_company_manager(caller, r.company_id) then
    update public.time_off_requests set status = 'cancelled', approval_stage = null where id = _request;
    insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, before)
    values (r.company_id, caller, 'time_off.removed', 'time_off', r.id, to_jsonb(r));
    return;
  end if;

  if not (r.company_id = public.current_company_id()
          and public.can_approve_time_off(caller, r.employee_id)) then
    raise exception 'not authorized';
  end if;
  if r.status = 'approved' then
    raise exception 'Only an admin can remove time off that has been approved.';
  end if;
  if r.recorded_by is distinct from caller then
    raise exception 'Answer this request with Approve or Deny on the Time off page.';
  end if;

  update public.time_off_requests set status = 'cancelled', approval_stage = null where id = _request;
  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, before)
  values (r.company_id, caller, 'time_off.withdrawn', 'time_off', r.id, to_jsonb(r));
end;
$$;

revoke all on function public.manager_record_absence(uuid, text, date, date, text) from public, anon;
revoke all on function public.manager_remove_absence(uuid) from public, anon;
grant execute on function public.manager_record_absence(uuid, text, date, date, text) to authenticated;
grant execute on function public.manager_remove_absence(uuid) to authenticated;

commit;

notify pgrst, 'reload schema';

