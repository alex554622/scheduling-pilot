-- Removing an employee was a client-side `update profiles set company_id = null`,
-- which RLS rejects: profile_admin_update's WITH CHECK runs against the NEW row,
-- and that row's company_id is null, so `company_id is not null` fails and the
-- statement dies with "new row violates row-level security policy".
--
-- Widening the policy is the wrong fix — the `company_id is not null` guard is
-- what closed the privilege-escalation hole in 20260830232500 (has_role(_user,
-- _role, null) matches ANY company, so a null company_id let any admin claim any
-- company-less profile). Instead, move the whole removal behind a definer RPC
-- that authorizes the caller explicitly, the same shape as approve_membership.
--
-- It also makes the removal atomic. The old client did two statements; the roles
-- delete committed and the profile update then failed, leaving members stripped
-- of their roles but still attached to the company.
create or replace function public.remove_company_member(_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  cid uuid;
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _user = caller then
    raise exception 'You cannot remove yourself from the company.';
  end if;

  select company_id into cid from public.profiles where id = _user;
  if cid is null then raise exception 'That user is not a member of a company.'; end if;

  if not (public.has_role(caller, 'company_admin'::app_role, cid)
          or public.has_role(caller, 'super_admin'::app_role)) then
    raise exception 'not authorized';
  end if;

  delete from public.user_roles where user_id = _user and company_id = cid;
  update public.profiles set company_id = null where id = _user;
end;
$$;

revoke all on function public.remove_company_member(uuid) from public, anon;
grant execute on function public.remove_company_member(uuid) to authenticated;
