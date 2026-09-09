
-- Revoke broad execute, allow only authenticated callers
revoke execute on function public.bootstrap_company(text) from public, anon;
revoke execute on function public.join_company(uuid) from public, anon;
revoke execute on function public.claim_super_admin() from public, anon;
revoke execute on function public.has_role(uuid, public.app_role, uuid) from public, anon;
revoke execute on function public.current_company_id() from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

grant execute on function public.bootstrap_company(text) to authenticated;
grant execute on function public.join_company(uuid) to authenticated;
grant execute on function public.claim_super_admin() to authenticated;
grant execute on function public.has_role(uuid, public.app_role, uuid) to authenticated;
grant execute on function public.current_company_id() to authenticated;

-- Tighten with check clauses
drop policy "timeoff_admin_update" on public.time_off_requests;
create policy "timeoff_admin_update" on public.time_off_requests for update to authenticated
  using (
    public.has_role(auth.uid(), 'company_admin', company_id)
    or public.has_role(auth.uid(), 'supervisor', company_id)
  )
  with check (
    public.has_role(auth.uid(), 'company_admin', company_id)
    or public.has_role(auth.uid(), 'supervisor', company_id)
  );

drop policy "trades_party_update" on public.shift_trades;
create policy "trades_party_update" on public.shift_trades for update to authenticated
  using (
    from_employee_id = auth.uid()
    or to_employee_id = auth.uid()
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or public.has_role(auth.uid(), 'supervisor', company_id)
  )
  with check (
    from_employee_id = auth.uid()
    or to_employee_id = auth.uid()
    or public.has_role(auth.uid(), 'company_admin', company_id)
    or public.has_role(auth.uid(), 'supervisor', company_id)
  );
