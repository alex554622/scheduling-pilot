-- Availability is expressed in wall-clock time, so comparing it against
-- timestamptz shifts needs the company's local zone. Default UTC preserves
-- current behaviour until a company sets its own.
alter table public.companies add column if not exists timezone text not null default 'UTC';

-- README "IMPORTANT LOGIC": the checks to run before committing a shift.
-- Advisory by design -- it returns findings rather than blocking, because the
-- README requires "supervisor override with warning". Callers decide what to do
-- with severity='error' vs 'warning'.
--
-- NOTE: message building uses round() + concatenation, NOT format('%.1f', ...):
-- PostgreSQL's format() supports only %s / %I / %L / %%, and a C-style specifier
-- raises "22023 unrecognized format() type specifier" at runtime.
create or replace function public.check_shift_conflicts(
  _employee_id uuid,
  _starts_at   timestamptz,
  _ends_at     timestamptz,
  _position_id uuid default null,
  _shift_id    uuid default null   -- exclude this shift when editing
)
returns table (code text, severity text, message text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  caller       uuid := auth.uid();
  emp          record;
  co           record;
  tz           text;
  s            jsonb;
  local_start  timestamp;
  local_end    timestamp;
  dow          int;
  week_start_day int;
  wk_start     date;
  wk_end       date;
  existing_h   numeric := 0;
  new_h        numeric;
  total_h      numeric;
  ot_threshold numeric;
  has_avail    boolean;
begin
  if caller is null then raise exception 'not authenticated'; end if;

  -- Open (unassigned) shift: nothing employee-specific to validate.
  if _employee_id is null then return; end if;

  if _ends_at <= _starts_at then
    return query select 'invalid_range'::text, 'error'::text,
                        'Shift end must be after its start.'::text;
    return;
  end if;

  select p.id, p.company_id, p.is_active, p.max_weekly_hours, p.full_name
    into emp
  from public.profiles p where p.id = _employee_id;

  if not found then
    return query select 'employee_not_found'::text, 'error'::text, 'Employee not found.'::text;
    return;
  end if;

  -- Caller must be inside the employee's company (or platform admin).
  if not (public.has_role(caller, 'super_admin')
          or emp.company_id = public.current_company_id()) then
    raise exception 'not authorized';
  end if;

  if emp.company_id is null then
    return query select 'employee_no_company'::text, 'error'::text,
                        'Employee does not belong to a company.'::text;
    return;
  end if;

  if not emp.is_active then
    return query select 'employee_inactive'::text, 'error'::text,
                        emp.full_name || ' is not an active employee.'::text;
  end if;

  select c.timezone, c.settings into co from public.companies c where c.id = emp.company_id;
  tz := coalesce(co.timezone, 'UTC');
  s  := coalesce(co.settings, '{}'::jsonb);
  ot_threshold   := coalesce((s->>'overtime_threshold_hours')::numeric, 40);
  week_start_day := coalesce((s->>'week_start_day')::int, 0);

  local_start := _starts_at at time zone tz;
  local_end   := _ends_at   at time zone tz;
  dow         := extract(dow from local_start)::int;
  new_h       := extract(epoch from (_ends_at - _starts_at)) / 3600.0;

  -- 1. Double booking.
  if exists (
    select 1 from public.shifts sh
    where sh.employee_id = _employee_id
      and (_shift_id is null or sh.id <> _shift_id)
      and sh.starts_at < _ends_at
      and sh.ends_at   > _starts_at
  ) then
    return query select 'double_booked'::text, 'error'::text,
                        emp.full_name || ' already has a shift overlapping this time.'::text;
  end if;

  -- 2. Approved time off covering any part of the shift.
  if exists (
    select 1 from public.time_off_requests t
    where t.employee_id = _employee_id
      and t.status = 'approved'
      and t.start_date <= local_end::date
      and t.end_date   >= local_start::date
  ) then
    return query select 'on_approved_time_off'::text, 'error'::text,
                        emp.full_name || ' has approved time off covering this shift.'::text;
  end if;

  -- 3. Availability. Only meaningful once the employee has declared some.
  select exists (select 1 from public.employee_availability a where a.employee_id = _employee_id)
    into has_avail;

  if has_avail then
    if local_end::date > local_start::date then
      return query select 'crosses_midnight'::text, 'warning'::text,
                          'Shift crosses midnight; availability could not be verified automatically.'::text;
    else
      if exists (
        select 1 from public.employee_availability a
        where a.employee_id = _employee_id
          and a.is_available = false
          and a.weekday = dow
          and a.start_time < local_end::time
          and a.end_time   > local_start::time
          and (a.effective_from is null or a.effective_from <= local_start::date)
          and (a.effective_to   is null or a.effective_to   >= local_start::date)
      ) then
        return query select 'blackout'::text, 'warning'::text,
                            emp.full_name || ' marked this time as unavailable.'::text;
      elsif not exists (
        select 1 from public.employee_availability a
        where a.employee_id = _employee_id
          and a.is_available = true
          and a.weekday = dow
          and a.start_time <= local_start::time
          and a.end_time   >= local_end::time
          and (a.effective_from is null or a.effective_from <= local_start::date)
          and (a.effective_to   is null or a.effective_to   >= local_start::date)
      ) then
        return query select 'outside_availability'::text, 'warning'::text,
                            'Shift falls outside ' || emp.full_name || '''s stated availability.';
      end if;
    end if;
  end if;

  -- 4. Position qualification.
  if _position_id is not null and not exists (
    select 1 from public.employee_positions ep
    where ep.employee_id = _employee_id and ep.position_id = _position_id
  ) then
    return query select 'not_qualified'::text, 'warning'::text,
                        emp.full_name || ' is not marked qualified for this position.'::text;
  end if;

  -- 5. Weekly hours / overtime, using the company's configured week start.
  wk_start := (local_start::date - (((dow - week_start_day) + 7) % 7));
  wk_end   := wk_start + 7;

  select coalesce(sum(extract(epoch from (sh.ends_at - sh.starts_at)) / 3600.0), 0)
    into existing_h
  from public.shifts sh
  where sh.employee_id = _employee_id
    and (_shift_id is null or sh.id <> _shift_id)
    and (sh.starts_at at time zone tz)::date >= wk_start
    and (sh.starts_at at time zone tz)::date <  wk_end;

  total_h := existing_h + new_h;

  if total_h > emp.max_weekly_hours then
    return query select 'exceeds_max_weekly_hours'::text, 'warning'::text,
                        'This puts ' || emp.full_name || ' at ' || round(total_h, 1)
                        || 'h against a ' || round(emp.max_weekly_hours, 1) || 'h weekly max.';
  elsif total_h > ot_threshold then
    return query select 'overtime_risk'::text, 'warning'::text,
                        'This puts ' || emp.full_name || ' at ' || round(total_h, 1)
                        || 'h, over the ' || round(ot_threshold, 1) || 'h overtime threshold.';
  end if;

  return;
end;
$$;

revoke all on function public.check_shift_conflicts(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.check_shift_conflicts(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;

-- Hard integrity: a shift must never reference another tenant's rows. RLS only
-- checked shifts.company_id, so a supervisor could previously assign an employee
-- (or position/location) belonging to a different company.
create or replace function public.validate_shift_tenancy()
returns trigger language plpgsql
security definer
set search_path = public
as $$
begin
  if new.employee_id is not null
     and not exists (select 1 from public.profiles p
                      where p.id = new.employee_id and p.company_id = new.company_id) then
    raise exception 'employee does not belong to this company';
  end if;
  if new.department_id is not null
     and not exists (select 1 from public.departments d
                      where d.id = new.department_id and d.company_id = new.company_id) then
    raise exception 'department belongs to a different company';
  end if;
  if new.location_id is not null
     and not exists (select 1 from public.locations l
                      where l.id = new.location_id and l.company_id = new.company_id) then
    raise exception 'location belongs to a different company';
  end if;
  if new.position_id is not null
     and not exists (select 1 from public.positions po
                      where po.id = new.position_id and po.company_id = new.company_id) then
    raise exception 'position belongs to a different company';
  end if;
  if new.schedule_id is not null
     and not exists (select 1 from public.schedules sc
                      where sc.id = new.schedule_id and sc.company_id = new.company_id) then
    raise exception 'schedule belongs to a different company';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_shift_tenancy() from public, anon, authenticated;

create trigger trg_validate_shift_tenancy
before insert or update on public.shifts
for each row execute function public.validate_shift_tenancy();
