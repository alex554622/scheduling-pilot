-- An invitation issued before the merge can still carry role = 'supervisor',
-- which the new user_roles CHECK constraint rejects. Land those invitees as
-- company admins instead of failing the acceptance.
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

  update public.profiles set company_id = inv.company_id where id = uid;

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
