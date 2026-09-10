-- accept_invitation set company_id but left pending_company_id alone. A user who
-- had requested to join one company by code and then accepted an emailed
-- invitation instead ended up with BOTH columns set.
--
-- That combination made the member unremovable. Clearing profiles.company_id
-- has to satisfy one of the three UPDATE policies' WITH CHECK against the new
-- row, and with pending_company_id still set all three fail:
--   profile_admin_update    company_id is not null            -> false
--   profile_update_pending  ... or pending_company_id is null  -> false
--   profile_update_self     id = auth.uid()                   -> false (admin acting)
-- which surfaces as "new row violates row-level security policy for table
-- profiles". Joining a company supersedes any outstanding request, so clear it.
create or replace function public.accept_invitation(_token uuid)
returns uuid
language plpgsql security definer set search_path = public
as $fn$
declare
  uid uuid := auth.uid();
  user_email text := lower(coalesce((auth.jwt() ->> 'email'), ''));
  inv public.invitations%rowtype;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into inv from public.invitations where token = _token for update;
  if not found then raise exception 'invitation not found'; end if;
  if inv.status <> 'pending' then raise exception 'invitation is %', inv.status; end if;
  if inv.expires_at < now() then raise exception 'invitation expired'; end if;
  if lower(inv.email) <> user_email then
    raise exception 'invitation email does not match signed-in user';
  end if;

  update public.profiles
    set company_id = inv.company_id, pending_company_id = null
    where id = uid;

  insert into public.user_roles (user_id, company_id, role)
  values (
    uid,
    inv.company_id,
    case when inv.role = 'supervisor'::app_role then 'company_admin'::app_role else inv.role end
  )
  on conflict do nothing;

  update public.invitations
    set status = 'accepted', accepted_at = now(), accepted_by = uid
    where id = inv.id;

  return inv.company_id;
end;
$fn$;

revoke all on function public.accept_invitation(uuid) from public, anon;
grant execute on function public.accept_invitation(uuid) to authenticated;

-- Existing members carrying a stale request. They are already in a company, so
-- the outstanding request is dead regardless; this also clears them out of their
-- admin's pending join-request list, where they should never have appeared.
update public.profiles
  set pending_company_id = null
where company_id is not null
  and pending_company_id is not null;
