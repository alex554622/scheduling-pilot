-- SECURITY FIX (privilege escalation).
--
-- has_role(_user, _role, _company) treats a NULL _company as "in ANY company".
-- The old roles_admin_manage policy checked
--     has_role(auth.uid(), 'company_admin', company_id)
-- against the row being written. For a row with company_id = NULL that collapses
-- to "is the caller a company_admin of anything?" — true for every company admin.
--
-- So any company admin could run
--     insert into user_roles (user_id, company_id, role)
--     values (auth.uid(), null, 'super_admin');
-- and become a platform super admin, gaining read access to every tenant.
-- Verified reproducible before this migration.
--
-- Fix: split the policy. Platform-level rows (company_id IS NULL) are
-- super-admin-only. Company admins may only write rows scoped to a company they
-- already administer, and may never grant super_admin.
drop policy "roles_admin_manage" on public.user_roles;

create policy "roles_super_admin_manage" on public.user_roles
  for all to authenticated
  using (public.has_role(auth.uid(), 'super_admin'))
  with check (public.has_role(auth.uid(), 'super_admin'));

create policy "roles_company_admin_manage" on public.user_roles
  for all to authenticated
  using (
    company_id is not null
    and role <> 'super_admin'
    and public.has_role(auth.uid(), 'company_admin', company_id)
  )
  with check (
    company_id is not null
    and role <> 'super_admin'
    and public.has_role(auth.uid(), 'company_admin', company_id)
  );

-- Same NULL degeneracy, lower severity: profiles.company_id is nullable, so
-- profile_admin_update let any company admin edit — and claim — the profile of
-- any user who did not yet belong to a company. Scope it to their own company;
-- the separate profile_update_pending policy still covers approving joiners.
drop policy "profile_admin_update" on public.profiles;

create policy "profile_admin_update" on public.profiles
  for update to authenticated
  using (
    company_id is not null
    and public.has_role(auth.uid(), 'company_admin', company_id)
  )
  with check (
    company_id is not null
    and public.has_role(auth.uid(), 'company_admin', company_id)
  );
