-- Departments that keep to themselves: "Employees see only themselves".
--
-- A team rule (department_rules.rules ->> 'staff_see_only_self') that a
-- company admin, or a supervisor of the whole department, turns on from
-- Settings → Team rules. While it is on, an employee in that department sees
-- only their own shifts on the schedule and only themselves on the
-- dashboard's who-is-in. Open shifts (no one on them) stay visible so they can
-- still pick one up, and names stay readable so messages, requests and trades
-- still say who is who.
--
-- Admins and supervisors are never narrowed by it. It works whether or not
-- the company keeps departments separate; with "Keep departments separate" off,
-- everyone else in the company still sees the whole company.
--
-- Run after 20261130120000_department_only_messages.sql. Re-runnable; applied
-- by hand in Studio.

begin;

-- The team rule is a true/false like the other team switches.
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

    if k in ('require_geofence', 'require_gps', 'allow_kiosk', 'schedule_lateness',
             'allow_break_10', 'allow_break_30', 'allow_break_60', 'require_edit_note',
             'staff_see_only_self') then
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

-- Is _user an employee whose department shows them only themselves?
create or replace function public.sees_only_self(_user uuid, _company uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce((select (dr.rules ->> 'staff_see_only_self')::boolean
                     from public.company_memberships m
                     join public.department_rules dr on dr.department_id = m.department_id
                    where m.user_id = _user and m.company_id = _company and m.status = 'active'
                    limit 1), false)
     and not public.is_company_manager(_user, _company)
     and not public.is_supervisor(_user, _company)
     and not public.has_role(_user, 'super_admin'::public.app_role);
$$;
revoke all on function public.sees_only_self(uuid, uuid) from public, anon;
grant execute on function public.sees_only_self(uuid, uuid) to authenticated;

-- May _viewer see _person's shifts and whether they are in? As can_see_member,
-- and only their own when their department keeps to itself.
create or replace function public.can_see_schedule(_viewer uuid, _person uuid, _company uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.can_see_member(_viewer, _person, _company)
     and (_viewer = _person or not public.sees_only_self(_viewer, _company));
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
            end)
  );

-- Who is in: as 20261129120000_department_separation.sql, with the line above.
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
        and public.can_see_schedule(auth.uid(), pr.id, cid)
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

commit;

notify pgrst, 'reload schema';
