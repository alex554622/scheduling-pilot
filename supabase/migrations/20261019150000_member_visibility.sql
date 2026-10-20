-- Where each person shows up, set one person at a time.
--
-- Until now the only control was the App rule "Hide admins from the rosters":
-- every admin hidden, or none. An admin now picks, per person, from the Edit
-- member dialog:
--
--   everywhere      on the schedule, the timecards and the dashboard roster
--   schedule_only   on the schedule, kept off the timecard roster
--   timecards_only  on the timecard roster, kept off the schedule
--   ghost           nowhere — schedule, timecards, dashboard, Who's in, trades
--
-- No row means the company default: an employee shows everywhere; an admin is
-- a ghost while "Hide admins from the rosters" is on, and everywhere while it
-- is off. Everyone can still open their own timecard.
--
-- The rows are readable by the whole company, because every screen filters by
-- them; only admins can write them, so nobody can hide themselves.
--
-- Re-runnable; applied by hand in Studio.

create table if not exists public.member_visibility (
  user_id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  mode text not null check (mode in ('everywhere', 'schedule_only', 'timecards_only', 'ghost')),
  updated_at timestamptz not null default now()
);
create index if not exists member_visibility_company_idx on public.member_visibility(company_id);
alter table public.member_visibility enable row level security;

drop policy if exists member_visibility_view on public.member_visibility;
create policy member_visibility_view on public.member_visibility for select to authenticated
  using (company_id = public.current_company_id() or public.has_role(auth.uid(), 'super_admin'));

drop policy if exists member_visibility_manage on public.member_visibility;
create policy member_visibility_manage on public.member_visibility for all to authenticated
  using (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id))
  with check (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id));

grant select, insert, update, delete on public.member_visibility to authenticated;
grant all on public.member_visibility to service_role;

-- The employee dashboard's "who is on the floor". Same as 20260914120000,
-- except who is left out: a ghost, and an admin with no setting of their own
-- while the company hides admins. Nobody is hidden from themselves, and a
-- manager calling this still sees the whole company (their screens filter it).
create or replace function public.company_presence()
returns table (user_id uuid, full_name text, job_title text, status text)
language plpgsql stable security definer set search_path = public
as $$
declare
  cid uuid;
  tz text;
  day_start timestamptz;
  hide_admins boolean;
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

  select coalesce((c.settings ->> 'hide_admins_from_staff')::boolean, true)
    into hide_admins
    from public.companies c where c.id = cid;
  hide_admins := coalesce(hide_admins, true);
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
        coalesce(mv.mode, '') <> 'ghost'
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
