-- Pin search_path on the one helper that was missing it. Immutable + no table
-- references, but a mutable search_path on a SECURITY DEFINER call chain is a
-- privilege-escalation vector, so close it.
create or replace function public.haversine_m(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision)
returns double precision
language sql immutable
set search_path = public
as $$
  select 2 * 6371000 * asin(sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2
    + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2) ^ 2
  ))
$$;

-- Trigger functions are invoked by the trigger, never by a client. Leaving them
-- granted to PUBLIC exposes them as callable /rest/v1/rpc/... endpoints.
revoke all on function public.notify_company_status_change() from public, anon, authenticated;
revoke all on function public.notify_membership_decision() from public, anon, authenticated;
revoke all on function public.assign_join_code_on_approval() from public, anon, authenticated;
revoke all on function public.generate_company_join_code() from public, anon, authenticated;

-- Internal helper: used inside other SECURITY DEFINER functions, not by clients.
revoke all on function public.is_company_manager(uuid, uuid) from public, anon, authenticated;

-- These all check auth.uid() themselves, but there is no reason for the anon
-- role to reach them at all. Keep them granted to authenticated only.
revoke all on function public.accept_invitation(uuid) from public, anon;
grant execute on function public.accept_invitation(uuid) to authenticated;

revoke all on function public.approve_membership(uuid) from public, anon;
grant execute on function public.approve_membership(uuid) to authenticated;

revoke all on function public.reject_membership(uuid) from public, anon;
grant execute on function public.reject_membership(uuid) to authenticated;

revoke all on function public.join_company_by_code(text) from public, anon;
grant execute on function public.join_company_by_code(text) to authenticated;

revoke all on function public.manager_update_punch(uuid, timestamptz, text, text) from public, anon;
grant execute on function public.manager_update_punch(uuid, timestamptz, text, text) to authenticated;

revoke all on function public.manager_insert_punch(uuid, timestamptz, text, text) from public, anon;
grant execute on function public.manager_insert_punch(uuid, timestamptz, text, text) to authenticated;

revoke all on function public.manager_delete_punch(uuid, text) from public, anon;
grant execute on function public.manager_delete_punch(uuid, text) to authenticated;

revoke all on function public.clock_punch(double precision, double precision, double precision) from anon;
revoke all on function public.break_punch(double precision, double precision, double precision, integer) from anon;
revoke all on function public.set_company_location(double precision, double precision, integer) from anon;

-- get_invitation_by_token stays reachable by anon on purpose: the /join page
-- resolves an invite link before the recipient has signed in.
