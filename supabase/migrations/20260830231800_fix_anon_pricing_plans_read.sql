-- The public pricing page (anon) returned 401 "permission denied for function
-- has_role": the policy OR'd in has_role(), but EXECUTE on has_role is granted
-- to `authenticated` only, and Postgres evaluates the whole USING expression.
--
-- Split it in two rather than granting anon EXECUTE on has_role — that grant
-- would let an unauthenticated caller probe any user's roles by UUID.
-- Permissive policies are OR'd, so a super admin still sees inactive plans.
drop policy "plans_read_public" on public.pricing_plans;

create policy "plans_read_public" on public.pricing_plans
  for select to anon, authenticated
  using (active = true);

create policy "plans_read_super_admin" on public.pricing_plans
  for select to authenticated
  using (public.has_role(auth.uid(), 'super_admin'::app_role));
