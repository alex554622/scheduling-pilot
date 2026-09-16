-- Keep admins off the employee dashboard when the company asks for it.
--
-- `company_presence()` is how a shift worker sees who is on the floor, and it
-- listed everyone in the company - the office included. The App rules page now
-- carries a "Hide admins from employees" switch (companies.settings ->>
-- 'hide_admins_from_staff'), and this is the half of it that an employee cannot
-- talk their browser out of.
--
-- A manager calling this still sees the whole company, and nobody is ever
-- hidden from themselves. Absent setting = on, matching DEFAULT_APP_RULES.
--
-- Everything else about the function is unchanged: states only, no punch times,
-- no totals, no way to reconstruct anyone's hours.
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

  -- Only employees have anyone hidden from them; a manager needs the full floor.
  select coalesce((c.settings ->> 'hide_admins_from_staff')::boolean, true)
    into hide_admins
    from public.companies c where c.id = cid;
  hide_admins := coalesce(hide_admins, true) and not public.is_company_manager(auth.uid(), cid);

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
  where pr.company_id = cid
    and (
      not hide_admins
      or pr.id = auth.uid()
      -- "supervisor" is retired, but rows written before the merge into
      -- company_admin still carry it, and that person is still management.
      or not exists (
        select 1 from public.user_roles ur
         where ur.user_id = pr.id
           and ur.role in ('super_admin', 'company_admin', 'supervisor')
           and (ur.company_id = cid or ur.company_id is null)
      )
    )
  order by pr.full_name;
end; $$;

revoke all on function public.company_presence() from public, anon;
grant execute on function public.company_presence() to authenticated;
