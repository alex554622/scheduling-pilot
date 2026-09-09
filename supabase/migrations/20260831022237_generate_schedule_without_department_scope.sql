-- Second half of the supervisor/company_admin merge: the schedule generator no
-- longer filters templates by department, and the scoping machinery goes away.
--
-- Same generator as before, minus the scope pass that dropped out-of-scope
-- templates. `skipped_templates` stays in the response (always empty now) so
-- the client contract is unchanged.

create or replace function public.generate_schedule(
  _name text,
  _starts_on date,
  _ends_on date,
  _rules jsonb,
  _employee_ids uuid[] default null::uuid[],
  _respect_availability boolean default true,
  _allow_overtime boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  caller     uuid := auth.uid();
  cid        uuid;
  tz         text;
  s          jsonb;
  week_start_day int;
  sched_id   uuid;
  sched_dept uuid;
  sched_loc  uuid;
  d          date;
  rule       jsonb;
  tpl        record;
  headcount  int;
  i          int;
  slot_start timestamptz;
  slot_end   timestamptz;
  slot_hours numeric;
  local_end_time time;
  wk         date;
  chosen     uuid;
  created    int := 0;
  assigned   int := 0;
  open_cnt   int := 0;
  dow        int;
  skipped    text[] := '{}';
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select company_id into cid from public.profiles where id = caller;
  if cid is null then raise exception 'you must belong to a company'; end if;

  if not public.is_company_manager(caller, cid) then
    raise exception 'only company admins can generate schedules';
  end if;

  if _starts_on is null or _ends_on is null then raise exception 'pick a date range'; end if;
  if _ends_on < _starts_on then raise exception 'the end date must be on or after the start date'; end if;
  if _ends_on - _starts_on > 366 then raise exception 'a schedule cannot span more than 366 days'; end if;
  if _rules is null or jsonb_array_length(_rules) = 0 then
    raise exception 'pick at least one shift template';
  end if;

  select c.timezone, c.settings into tz, s from public.companies c where c.id = cid;
  tz := coalesce(tz, 'UTC');
  week_start_day := coalesce((s->>'week_start_day')::int, 0);

  create temp table _rules_ok on commit drop as
  select r.value as rule, t.id as template_id, t.department_id, t.location_id
  from jsonb_array_elements(_rules) r
  join public.shift_templates t
    on t.id = (r.value->>'template_id')::uuid and t.company_id = cid;

  if not exists (select 1 from _rules_ok) then
    raise exception 'none of the selected templates belong to your company';
  end if;

  select case when count(distinct department_id) = 1 then (array_agg(distinct department_id))[1] end,
         case when count(distinct location_id)   = 1 then (array_agg(distinct location_id))[1]   end
    into sched_dept, sched_loc
  from _rules_ok;

  insert into public.schedules (company_id, name, starts_on, ends_on, created_by, status, department_id, location_id)
  values (cid, coalesce(nullif(trim(_name), ''), 'Generated schedule'),
          _starts_on, _ends_on, caller, 'draft', sched_dept, sched_loc)
  returning id into sched_id;

  create temp table _pool on commit drop as
    select p.id, p.full_name, p.max_weekly_hours
    from public.profiles p
    where p.company_id = cid
      and p.is_active
      and (_employee_ids is null or p.id = any(_employee_ids));

  create temp table _load (
    employee_id uuid,
    week_start  date,
    hours       numeric,
    primary key (employee_id, week_start)
  ) on commit drop;

  insert into _load (employee_id, week_start, hours)
  select sh.employee_id,
         (sh.starts_at at time zone tz)::date
           - (((extract(dow from (sh.starts_at at time zone tz))::int - week_start_day) + 7) % 7),
         sum(extract(epoch from (sh.ends_at - sh.starts_at)) / 3600.0)
  from public.shifts sh
  where sh.company_id = cid
    and sh.employee_id is not null
    and sh.starts_at >= (_starts_on - 7)::timestamptz
  group by 1, 2;

  d := _starts_on;
  while d <= _ends_on loop
    dow := extract(dow from d)::int;

    for rule in select x.rule from _rules_ok x loop
      continue when not (coalesce(rule->'weekdays', '[]'::jsonb) @> to_jsonb(dow));

      select t.id, t.name, t.start_time, t.end_time, t.break_minutes, t.required_headcount,
             t.color, t.position_id, t.department_id, t.location_id
        into tpl
      from public.shift_templates t
      where t.id = (rule->>'template_id')::uuid and t.company_id = cid;
      continue when not found;

      headcount := greatest(1, coalesce((rule->>'headcount')::int, tpl.required_headcount, 1));

      slot_start := (d + tpl.start_time) at time zone tz;
      if tpl.end_time > tpl.start_time then
        slot_end       := (d + tpl.end_time) at time zone tz;
        local_end_time := tpl.end_time;
      else
        slot_end       := ((d + 1) + tpl.end_time) at time zone tz;
        local_end_time := time '23:59:59';
      end if;
      slot_hours := extract(epoch from (slot_end - slot_start)) / 3600.0;
      wk := d - (((dow - week_start_day) + 7) % 7);

      for i in 1..headcount loop
        chosen := null;

        select cand.id into chosen
        from _pool cand
        where
          not exists (
            select 1 from public.shifts x
            where x.employee_id = cand.id
              and x.starts_at < slot_end
              and x.ends_at   > slot_start
          )
          and not exists (
            select 1 from public.time_off_requests t
            where t.employee_id = cand.id
              and t.status = 'approved'
              and t.start_date <= d
              and t.end_date   >= d
          )
          and (
            not _respect_availability
            or not exists (select 1 from public.employee_availability a where a.employee_id = cand.id)
            or (
              exists (
                select 1 from public.employee_availability a
                where a.employee_id = cand.id
                  and a.is_available
                  and a.weekday = dow
                  and a.start_time <= tpl.start_time
                  and a.end_time   >= local_end_time
                  and (a.effective_from is null or a.effective_from <= d)
                  and (a.effective_to   is null or a.effective_to   >= d)
              )
              and not exists (
                select 1 from public.employee_availability a
                where a.employee_id = cand.id
                  and a.is_available = false
                  and a.weekday = dow
                  and a.start_time < local_end_time
                  and a.end_time   > tpl.start_time
                  and (a.effective_from is null or a.effective_from <= d)
                  and (a.effective_to   is null or a.effective_to   >= d)
              )
            )
          )
          and (
            _allow_overtime
            or coalesce((select l.hours from _load l
                          where l.employee_id = cand.id and l.week_start = wk), 0) + slot_hours
               <= cand.max_weekly_hours
          )
        order by
          case
            when tpl.position_id is null then 0
            when exists (select 1 from public.employee_positions ep
                          where ep.employee_id = cand.id and ep.position_id = tpl.position_id) then 0
            else 1
          end,
          coalesce((select l.hours from _load l
                     where l.employee_id = cand.id and l.week_start = wk), 0),
          cand.full_name
        limit 1;

        insert into public.shifts (
          company_id, employee_id, schedule_id, template_id,
          department_id, location_id, position_id,
          starts_at, ends_at, break_minutes, position, color, published
        ) values (
          cid, chosen, sched_id, tpl.id,
          tpl.department_id, tpl.location_id, tpl.position_id,
          slot_start, slot_end, tpl.break_minutes,
          coalesce((select po.name from public.positions po where po.id = tpl.position_id), tpl.name),
          tpl.color, false
        );

        created := created + 1;

        if chosen is null then
          open_cnt := open_cnt + 1;
        else
          assigned := assigned + 1;
          insert into _load (employee_id, week_start, hours)
          values (chosen, wk, slot_hours)
          on conflict (employee_id, week_start)
          do update set hours = _load.hours + excluded.hours;
        end if;
      end loop;
    end loop;

    d := d + 1;
  end loop;

  return jsonb_build_object(
    'schedule_id',       sched_id,
    'shifts_created',    created,
    'assigned',          assigned,
    'open',              open_cnt,
    'skipped_templates', to_jsonb(skipped)
  );
end;
$fn$;

-- ---- retire the scoping machinery ----

drop function if exists public.can_manage_employee(uuid, uuid);
drop function if exists public.can_manage_scope(uuid, uuid, uuid, uuid);
drop table if exists public.supervisor_scopes;
