-- Announcements are for everyone; messages are for one department.
--
-- Replaces the posting and reading rules from
-- 20261129120000_department_separation.sql:
--
--   * An announcement always goes to the whole company (department_ids null),
--     and only a company admin can post one.
--   * Every other message goes to departments (department_ids set) and can be
--     read only by the people in those departments and the supervisors
--     assigned to them — not by admins outside the department. The author
--     always sees their own post.
--   * Who may post a message where: an employee to their own department, a
--     supervisor to their own or the ones they supervise, an admin to any of
--     the company's departments. Someone with no department (and not an
--     admin) cannot post a message until they are given one.
--
-- This no longer depends on "Keep departments separate": messages are
-- department-only for every company.
--
-- Existing posts are left alone (they expire within a day); the new check is
-- added NOT VALID so it applies to new posts only. An old company-wide
-- message stays readable by everyone until it expires.
--
-- Run after 20261129120000_department_separation.sql. Re-runnable; applied
-- by hand in Studio.

begin;

alter table public.company_messages drop constraint if exists company_messages_announcements_are_company_wide;
alter table public.company_messages add constraint company_messages_announcements_are_company_wide
  check (is_announcement = (department_ids is null)) not valid;

-- Does a post addressed to _departments (null = everyone) reach _user?
create or replace function public.message_reaches(_departments uuid[], _company uuid, _user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _user is not null and public.is_member(_user, _company) and (
       _departments is null
    or public.member_department(_user, _company) = any(_departments)
    or exists (select 1 from unnest(_departments) d
                 join public.supervisor_assignments a
                   on a.department_id = d and a.company_id = _company and a.supervisor_id = _user
                where public.is_supervisor(_user, _company))
  );
$$;

-- May _user post to _departments (null = everyone) in _company?
create or replace function public.can_post_to(_user uuid, _company uuid, _departments uuid[], _announcement boolean)
returns boolean language sql stable security definer set search_path = public
as $$
  select case
    when _announcement then
      _departments is null and public.is_company_manager(_user, _company)
    when _departments is null or cardinality(_departments) = 0 then
      false
    when public.is_company_manager(_user, _company) then
      not exists (select 1 from unnest(_departments) d
                   where not exists (select 1 from public.departments x
                                      where x.id = d and x.company_id = _company))
    else
      not exists (
        select 1 from unnest(_departments) d
         where d is distinct from public.member_department(_user, _company)
           and not (public.is_supervisor(_user, _company)
                    and public.can_manage_department(_user, _company, d)))
  end;
$$;

-- Your own, an admin's clean-up of an announcement, or a message in a
-- department you supervise.
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

commit;

notify pgrst, 'reload schema';
