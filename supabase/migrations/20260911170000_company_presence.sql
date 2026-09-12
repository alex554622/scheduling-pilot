-- Who is on duty right now, for everyone in the company.
--
-- An employee may only read their own punches (punch_select_self_or_mgr), and
-- that stays true: hours are between a person and their manager. But a shift
-- worker still needs to see who is here and who is on a break, so this returns
-- states and nothing else - no punch times, no totals, no break lengths, no
-- way to reconstruct anyone's hours.
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
  order by pr.full_name;
end; $$;

revoke all on function public.company_presence() from public, anon;
grant execute on function public.company_presence() to authenticated;
