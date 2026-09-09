
-- Invitations table for inviting teammates by email with a pre-assigned role.
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  email text not null,
  role app_role not null,
  token uuid not null default gen_random_uuid() unique,
  status text not null default 'pending', -- pending | accepted | revoked
  invited_by uuid not null,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid
);

create index invitations_company_idx on public.invitations(company_id);
create index invitations_email_idx on public.invitations(lower(email));

alter table public.invitations enable row level security;

-- Company admins manage invites for their own company; super admins see everything.
create policy invites_admin_all on public.invitations
  for all to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
  )
  with check (
    public.has_role(auth.uid(), 'super_admin')
    or (
      public.has_role(auth.uid(), 'company_admin', company_id)
      and invited_by = auth.uid()
      and role <> 'super_admin'
    )
  );

-- Users can see their own invites (by email) so they can accept from another device.
create policy invites_self_view on public.invitations
  for select to authenticated
  using (
    lower(email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
  );

-- Lookup an invite by token without exposing the whole table — anonymous-safe metadata only.
create or replace function public.get_invitation_by_token(_token uuid)
returns table (
  id uuid,
  company_id uuid,
  company_name text,
  email text,
  role app_role,
  status text,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, i.company_id, c.name, i.email, i.role, i.status, i.expires_at
  from public.invitations i
  join public.companies c on c.id = i.company_id
  where i.token = _token
$$;

grant execute on function public.get_invitation_by_token(uuid) to anon, authenticated;

-- Accept an invitation: validates email match, attaches profile to company,
-- assigns the pre-selected role, and marks the invite accepted.
create or replace function public.accept_invitation(_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
  values (uid, inv.company_id, inv.role)
  on conflict do nothing;

  update public.invitations
    set status = 'accepted', accepted_at = now(), accepted_by = uid
    where id = inv.id;

  return inv.company_id;
end;
$$;

grant execute on function public.accept_invitation(uuid) to authenticated;
