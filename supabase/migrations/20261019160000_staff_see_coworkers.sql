-- "Employees can see coworkers on the dashboard" (App rules).
--
-- companies.settings ->> 'staff_see_coworkers', absent = on. Off, an employee
-- calling company_presence() gets back only their own row, so the dashboard
-- cannot show them anyone else however the page is loaded. Admins always see
-- the whole company.
--
-- Otherwise the same as 20261019150000_member_visibility.sql, which this
-- replaces; run that one first if it has not been.
--
-- Re-runnable; applied by hand in Studio.

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

  select p.company_id into cid from public.profiles p where p.id = auth.uid();
  if cid is null then return; end if;

  select coalesce(nullif(c.timezone, ''), 'UTC') into tz from public.companies c where c.id = cid;
  begin
    day_start := date_trunc('day', now() at time zone tz) at time zone tz;
  exception when others then
    -- A timezone name Postgres doesn't know must not take the dashboard down.
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
    pr.position,
    case
      when lp.kind is null or lp.kind = 'out' then 'off'
      when lp.kind = 'break_start' then 'on_break'
      else 'working'
    end
  from public.profiles pr
  left join last_punch lp on lp.user_id = pr.id
  left join public.member_visibility mv on mv.user_id = pr.id
  where pr.company_id = cid
    and (
      manager
      or pr.id = auth.uid()
      or (
        see_coworkers
        and coalesce(mv.mode, '') <> 'ghost'
        and (
          mv.mode is not null
          or not hide_admins
          -- "supervisor" is retired, but rows written before the merge into
          -- company_admin still carry it, and that person is still management.
          or not exists (
            select 1 from public.user_roles ur
             where ur.user_id = pr.id
               and ur.role in ('super_admin', 'company_admin', 'supervisor')
               and (ur.company_id = cid or ur.company_id is null)
          )
        )
      )
    )
  order by pr.full_name;
end; $$;

revoke all on function public.company_presence() from public, anon;
grant execute on function public.company_presence() to authenticated;

notify pgrst, 'reload schema';
