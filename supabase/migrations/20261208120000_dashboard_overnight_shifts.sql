-- Dashboard: someone on a shift that crosses midnight stays "working" until
-- they clock out.
--
-- company_presence() read only today's punches, so at 12:00 a person still on
-- an overnight shift had no punch "today" and showed as off. It now reads the
-- last punch from a day back: still clocked in (or on a break) reads as
-- working; once they clock out they are off, and the dashboard lists them
-- again only if they are scheduled or clock in again that day.
--
-- Same function as in 20261207120000_company_schedule_for_everyone.sql apart
-- from the lookback. Re-runnable; applied by hand in Studio.

begin;

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
     where p.company_id = cid and p.at >= day_start - interval '24 hours'
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
