-- Self-service account deletion, required by the App Store (5.1.1(v)) and
-- Google Play (User Data policy) for any app that lets people sign up.
--
-- Same effect as the platform admin's `admin_delete_user`: the login is
-- removed and everything that references it with `on delete cascade` goes
-- with it — profile, roles, shifts, time punches, time off, availability,
-- shift trades, messages they wrote, push subscriptions. Rows that only
-- recorded who did something (audit log, schedules published, invoices
-- created) keep the row and lose the name (`on delete set null`).
--
-- Two guard rails, so one person deleting themselves can't strand others:
--   * the last platform admin can't delete their account;
--   * the only company admin of a company that still has other members has to
--     make someone else an admin first.

create or replace function public.delete_my_account()
returns void
language plpgsql security definer set search_path = public
as $$
declare
  _me uuid := auth.uid();
begin
  if _me is null then
    raise exception 'not signed in';
  end if;

  if public.has_role(_me, 'super_admin'::app_role)
     and (select count(distinct user_id) from public.user_roles
           where role = 'super_admin'::app_role) <= 1 then
    raise exception 'this is the last platform admin';
  end if;

  -- 'supervisor' is the old name for a company admin (see lib/auth.tsx).
  if exists (
    select 1
    from public.user_roles r
    where r.user_id = _me
      and r.company_id is not null
      and r.role::text in ('company_admin', 'supervisor')
      and not exists (
        select 1 from public.user_roles o
         where o.company_id = r.company_id
           and o.role::text in ('company_admin', 'supervisor')
           and o.user_id <> _me)
      and exists (
        select 1 from public.profiles p
         where p.company_id = r.company_id
           and p.id <> _me)
  ) then
    raise exception 'make someone else a company admin before deleting your account';
  end if;

  delete from auth.users where id = _me;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
