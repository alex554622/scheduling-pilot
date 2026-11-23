-- Notifications: keep each company's notifications in that company.
--
-- HOW TO APPLY: open Studio (supabase.schedulingpilot.com) -> SQL editor,
-- paste this whole file and press Run. It is safe to run again.
-- Do not use the supabase CLI or MCP tools; they point at the old project.
--
-- The bug: a notification with no company (company_id null) counts as
-- account-wide, so it shows in every company the person belongs to, whatever
-- their role there. Admin alerts (new user waiting for approval, clock-in
-- without GPS, late clock-in) ended up with no company when:
--   * they were made before the multi-company update (all older rows), or
--   * nobody was signed in when they were made: the shared clock-in tablet,
--     server jobs. The company was taken from the signed-in person only.
--
-- The fix:
--   1. Late clock-ins name their company directly (the tablet included).
--   2. With no signed-in company, a notification goes to the recipient's only
--      company. Only real account-wide kinds stay without a company: your own
--      membership decisions, company status notices and platform notices.
--   3. Existing rows with no company are fixed: put in the person's only
--      company, or deleted when they belong to several and it can't be told
--      which one it was about. Only the alerts go; the timecards, requests
--      and schedules they point to are untouched.

-- Kinds that really are about the account, not one company.
create or replace function public.notification_is_account_wide(_type text)
returns boolean
language sql immutable parallel safe set search_path = public
as $$
  select _type like 'membership\_%'
      or _type like 'company\_status\_%'
      or _type in ('company_pending');
$$;
revoke all on function public.notification_is_account_wide(text) from public, anon;
grant execute on function public.notification_is_account_wide(text) to authenticated;

-- ------------------------------------------------------------ 1. late --

create or replace function public.notify_late_clock_in(_user uuid, _company uuid, _minutes int)
returns void language plpgsql security definer set search_path = public
as $$
declare
  who text;
begin
  if _minutes is null then return; end if;
  select coalesce(nullif(trim(full_name), ''), 'An employee') into who
    from public.profiles where id = _user;

  insert into public.notifications (user_id, type, title, body, link, company_id)
  select distinct ur.user_id, 'late_clock_in', 'Late clock-in',
         format('%s clocked in %s min after their shift started.', who, _minutes),
         '/timecards', _company
    from public.user_roles ur
    join public.company_memberships m
      on m.user_id = ur.user_id and m.company_id = ur.company_id and m.status = 'active'
   where ur.company_id = _company
     and ur.user_id <> _user
     and (ur.role = 'company_admin'::public.app_role
          or (ur.role = 'supervisor'::public.app_role and public.supervises(ur.user_id, _user)))
     and public.wants_notification(ur.user_id, 'late_clock_in');
end; $$;
revoke all on function public.notify_late_clock_in(uuid, uuid, int) from public, anon, authenticated;

-- ------------------------------------------------- 2. stamp on insert --

create or replace function public.notifications_stamp_company()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  cid uuid;
begin
  if new.company_id is not null or public.notification_is_account_wide(new.type) then
    return new;
  end if;

  -- The company the signed-in person is working in, if the recipient is in it.
  cid := public.current_company_id();
  if cid is not null and exists (select 1 from public.company_memberships m
                                  where m.user_id = new.user_id and m.company_id = cid) then
    new.company_id := cid;
    return new;
  end if;

  -- Nobody signed in (shared clock-in, server jobs): the recipient's only company.
  select min(m.company_id::text)::uuid into cid
    from public.company_memberships m
   where m.user_id = new.user_id and m.status in ('active', 'suspended')
  having count(*) = 1;
  new.company_id := cid;
  return new;
end; $$;

drop trigger if exists notifications_stamp_company on public.notifications;
create trigger notifications_stamp_company
  before insert on public.notifications
  for each row execute function public.notifications_stamp_company();

-- ------------------------------------------------- 3. fix existing rows --

-- One company: that's the one.
update public.notifications n
   set company_id = solo.company_id
  from (select m.user_id, min(m.company_id::text)::uuid as company_id
          from public.company_memberships m
         where m.status in ('active', 'suspended')
         group by m.user_id
        having count(*) = 1) solo
 where n.user_id = solo.user_id
   and n.company_id is null
   and not public.notification_is_account_wide(n.type);

-- Several companies (or none left): can't tell which, so remove the alert.
delete from public.notifications n
 where n.company_id is null
   and not public.notification_is_account_wide(n.type);

-- ------------------------------------------------------- 4. read rule --

-- A notification with no company shows everywhere only if it really is
-- account-wide; anything else must name the company you're working in.
drop policy if exists notifications_own_select on public.notifications;
create policy notifications_own_select on public.notifications for select to authenticated
  using (user_id = auth.uid()
         and (company_id = public.current_company_id()
              or (company_id is null and public.notification_is_account_wide(type))));
