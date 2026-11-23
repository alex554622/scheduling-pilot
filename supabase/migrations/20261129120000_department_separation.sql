-- Departments as separate groups: their own message board, and (when a
-- company turns it on) their own people, schedules and requests.
--
-- Messages (always):
--   * company_messages.department_ids: null = the whole company, otherwise
--     only the people in those departments (and the supervisors of them, and
--     the company's admins) can read the post. Enforced by the read policy, so
--     realtime and every client get the same answer.
--   * An admin posts to the whole company or to any departments they pick. A
--     supervisor posts to their own department or the ones they supervise, and
--     may mark that post as an announcement. Everyone else posts to their own
--     department; while departments are kept separate they cannot post to the
--     whole company.
--   * Announcement notifications and message pushes go only to the people the
--     post reaches.
--
-- "Keep departments separate" (companies.settings ->> 'departments_separate',
-- absent = off, so nothing changes for a company until an admin turns it on):
-- an employee then sees only people in their own department, plus people with
-- no department (admins and the office), their own supervisors, and the people
-- they supervise. That holds for:
--
--   shifts (open shifts: their department's, or ones with no department),
--   time off, shift trades, availability, the company_members list, profiles
--   (names and phone numbers), and the dashboard's who-is-in.
--
-- Admins see everything, as before. Someone with no department sees only
-- people with no department until an admin assigns them one.
--
-- Run after 20261128120000_request_approval_chain.sql. Re-runnable; applied by
-- hand in Studio.

begin;

-- --------------------------------------------------------------- helpers ----

create or replace function public.departments_separate(_company uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce((select (c.settings ->> 'departments_separate')::boolean
                     from public.companies c where c.id = _company), false);
$$;

-- _user's department in _company (null = none, or not a member).
create or replace function public.member_department(_user uuid, _company uuid)
returns uuid language sql stable security definer set search_path = public
as $$
  select m.department_id from public.company_memberships m
   where m.user_id = _user and m.company_id = _company and m.status = 'active'
   limit 1;
$$;

-- May _viewer see _person's schedule, requests and details in _company?
create or replace function public.can_see_member(_viewer uuid, _person uuid, _company uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _viewer is not null and (
       _viewer = _person
    or not public.departments_separate(_company)
    or public.is_company_manager(_viewer, _company)
    or public.has_role(_viewer, 'super_admin'::public.app_role)
    -- people with no department (admins, the office) are company-wide
    or (public.is_member(_person, _company) and public.member_department(_person, _company) is null)
    or public.member_department(_viewer, _company) = public.member_department(_person, _company)
    or public.supervises(_viewer, _person)
    or public.supervises(_person, _viewer)
  );
$$;

-- May _viewer see things filed under _department (open shifts) in _company?
create or replace function public.can_see_department(_viewer uuid, _company uuid, _department uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _viewer is not null and (
       _department is null
    or not public.departments_separate(_company)
    or public.is_company_manager(_viewer, _company)
    or public.has_role(_viewer, 'super_admin'::public.app_role)
    or public.member_department(_viewer, _company) = _department
    or public.can_manage_department(_viewer, _company, _department)
  );
$$;

-- Does a post addressed to _departments (null = everyone) reach _user?
create or replace function public.message_reaches(_departments uuid[], _company uuid, _user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _user is not null and (
       _departments is null
    or public.is_company_manager(_user, _company)
    or public.member_department(_user, _company) = any(_departments)
    or exists (select 1 from unnest(_departments) d
                where public.can_manage_department(_user, _company, d))
  );
$$;

-- May _user post to _departments (null = everyone) in _company?
create or replace function public.can_post_to(_user uuid, _company uuid, _departments uuid[], _announcement boolean)
returns boolean language sql stable security definer set search_path = public
as $$
  select case
    when public.is_company_manager(_user, _company) then
      _departments is null
      or (cardinality(_departments) > 0
          and not exists (select 1 from unnest(_departments) d
                           where not exists (select 1 from public.departments x
                                              where x.id = d and x.company_id = _company)))
    when _departments is null then
      not _announcement and not public.departments_separate(_company)
    else
      cardinality(_departments) > 0
      and (not _announcement or public.is_supervisor(_user, _company))
      and not exists (
        select 1 from unnest(_departments) d
         where d is distinct from public.member_department(_user, _company)
           and not (public.is_supervisor(_user, _company)
                    and public.can_manage_department(_user, _company, d)))
  end;
$$;

revoke all on function public.departments_separate(uuid) from public, anon;
revoke all on function public.member_department(uuid, uuid) from public, anon;
revoke all on function public.can_see_member(uuid, uuid, uuid) from public, anon;
revoke all on function public.can_see_department(uuid, uuid, uuid) from public, anon;
revoke all on function public.message_reaches(uuid[], uuid, uuid) from public, anon;
revoke all on function public.can_post_to(uuid, uuid, uuid[], boolean) from public, anon;
grant execute on function public.departments_separate(uuid) to authenticated;
grant execute on function public.member_department(uuid, uuid) to authenticated;
grant execute on function public.can_see_member(uuid, uuid, uuid) to authenticated;
grant execute on function public.can_see_department(uuid, uuid, uuid) to authenticated;
grant execute on function public.message_reaches(uuid[], uuid, uuid) to authenticated;
grant execute on function public.can_post_to(uuid, uuid, uuid[], boolean) to authenticated;

-- -------------------------------------------------------------- messages ----

alter table public.company_messages add column if not exists department_ids uuid[];

-- An empty list would reach nobody; say null for everyone instead.
alter table public.company_messages drop constraint if exists company_messages_department_ids_not_empty;
alter table public.company_messages add constraint company_messages_department_ids_not_empty
  check (department_ids is null or cardinality(department_ids) > 0);

drop policy if exists company_messages_read on public.company_messages;
create policy company_messages_read on public.company_messages
  for select to authenticated
  using (
    company_id = public.current_company_id()
    and created_at > now() - interval '24 hours'
    and (author_id = auth.uid() or public.message_reaches(department_ids, company_id, auth.uid()))
  );

drop policy if exists company_messages_post on public.company_messages;
create policy company_messages_post on public.company_messages
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and company_id = public.current_company_id()
    and public.can_post_to(auth.uid(), company_id, department_ids, is_announcement)
  );

-- Your own, anyone's if you run the company, or anything in a department you
-- supervise.
drop policy if exists company_messages_remove on public.company_messages;
create policy company_messages_remove on public.company_messages
  for delete to authenticated
  using (
    author_id = auth.uid()
    or public.has_role(auth.uid(), 'company_admin'::app_role, company_id)
    or (department_ids is not null
        and public.is_supervisor(auth.uid(), company_id)
        and not exists (select 1 from unnest(department_ids) d
                         where not public.can_manage_department(auth.uid(), company_id, d)))
  );

create or replace function public.company_messages_after_post()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  who text;
begin
  -- Housekeeping on the way past: nobody can read these any more anyway.
  delete from public.company_messages
   where company_id = new.company_id
     and created_at < now() - interval '24 hours';

  if new.is_announcement then
    select nullif(p.full_name, '') into who from public.profiles p where p.id = new.author_id;

    insert into public.notifications (user_id, type, title, body, link, company_id)
    select p.id,
           'announcement',
           'Announcement from ' || coalesce(who, 'your admin'),
           left(new.body, 140) || case when char_length(new.body) > 140 then '…' else '' end,
           '/messages',
           new.company_id
      from public.profiles p
      join public.company_memberships cm
        on cm.user_id = p.id and cm.company_id = new.company_id and cm.status = 'active'
     where p.id <> new.author_id
       and public.message_reaches(new.department_ids, new.company_id, p.id)
       and public.wants_notification(p.id, 'announcement');
  end if;

  return null;
end;
$$;
revoke all on function public.company_messages_after_post() from public, anon, authenticated;

create or replace function public.push_for_message()
returns trigger language plpgsql security definer set search_path = public
as $fn$
declare
  who text;
  preview text;
  member record;
begin
  if new.is_announcement then
    return null;
  end if;

  select nullif(full_name, '') into who from public.profiles where id = new.author_id;
  preview := left(new.body, 140) || case when char_length(new.body) > 140 then '…' else '' end;

  for member in
    select cm.user_id as id from public.company_memberships cm
     where cm.company_id = new.company_id and cm.status = 'active'
       and cm.user_id <> new.author_id
       and public.message_reaches(new.department_ids, new.company_id, cm.user_id)
  loop
    perform public.enqueue_push(
      member.id, 'board_message',
      coalesce(who, 'Someone') || ' posted a message',
      preview, '/messages', 'msg-' || new.id::text, now()
    );
  end loop;

  return null;
end;
$fn$;
revoke all on function public.push_for_message() from public, anon, authenticated;

-- ---------------------------------------------------- separated reading ----

drop policy if exists "shifts_view" on public.shifts;
create policy "shifts_view" on public.shifts for select to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin'::public.app_role)
    or (company_id = public.current_company_id()
        and case when employee_id is null
                 then public.can_see_department(auth.uid(), company_id, department_id)
                 else public.can_see_member(auth.uid(), employee_id, company_id)
            end)
  );

drop policy if exists "timeoff_view" on public.time_off_requests;
create policy "timeoff_view" on public.time_off_requests for select to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin'::public.app_role)
    or (company_id = public.current_company_id()
        and (public.can_see_member(auth.uid(), employee_id, company_id)
             or public.can_see_request('time_off', id, auth.uid())))
  );

drop policy if exists "trades_view" on public.shift_trades;
create policy "trades_view" on public.shift_trades for select to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin'::public.app_role)
    or (company_id = public.current_company_id()
        and ((public.can_see_member(auth.uid(), from_employee_id, company_id)
              and public.can_see_member(auth.uid(), to_employee_id, company_id))
             or public.can_see_request('shift_trade', id, auth.uid())))
  );

drop policy if exists "availability_view" on public.employee_availability;
create policy "availability_view" on public.employee_availability for select to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin'::public.app_role)
    or (company_id = public.current_company_id()
        and public.can_see_member(auth.uid(), employee_id, company_id))
  );

drop policy if exists "profile_view" on public.profiles;
create policy "profile_view" on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or exists (select 1 from public.company_memberships m
                where m.user_id = profiles.id
                  and m.company_id = public.current_company_id()
                  and ((m.status = 'active'
                        and public.can_see_member(auth.uid(), m.user_id, m.company_id))
                       or public.has_role(auth.uid(), 'company_admin'::public.app_role, m.company_id)))
    or exists (select 1 from public.company_join_requests r
                where r.user_id = profiles.id
                  and r.status = 'pending'
                  and public.has_role(auth.uid(), 'company_admin'::public.app_role, r.company_id))
    or public.has_role(auth.uid(), 'super_admin'::public.app_role)
  );

-- Same view as 20261127120000_org_structure_assignments.sql, narrowed the same
-- way. Its instead-of-update trigger is kept.
create or replace view public.company_members as
select m.user_id        as id,
       m.company_id,
       p.full_name,
       p.phone,
       m.position,
       m.position_id,
       m.department_id,
       m.employee_code,
       m.max_weekly_hours,
       m.is_active,
       m.status,
       m.joined_at,
       p.created_at,
       m.location_id
  from public.company_memberships m
  join public.profiles p on p.id = m.user_id
 where m.status = 'active'
   and ((m.company_id = public.current_company_id()
         and public.can_see_member(auth.uid(), m.user_id, m.company_id))
        or public.has_role(auth.uid(), 'super_admin'::public.app_role));

revoke all on public.company_members from anon;
grant select, update on public.company_members to authenticated;

-- Who is in: as 20261122130000_multi_company_supervisor_scope.sql, plus the
-- department line.
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
        and public.can_see_member(auth.uid(), pr.id, cid)
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
