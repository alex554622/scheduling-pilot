-- Every account on the platform, and what a super admin may do with one.
--
-- The Companies page reads `profiles`, so anyone without a profile row was
-- invisible: an account that signed up and never confirmed its email, or one
-- created while `on_auth_user_created` was missing. They exist in `auth.users`
-- and can sign in, but no screen on the platform ever showed them.
--
-- `auth.users` is not readable by any client, so the listing is a definer
-- function that gates itself on the super admin role. Everything below does
-- the same: the check is inside the function, because a definer function runs
-- as its owner and RLS will not do it for us.
--
-- Re-runnable; applied by hand in Studio.

-- --------------------------------------------------------------- the listing
create or replace function public.admin_accounts()
returns table (
  user_id uuid,
  email text,
  email_confirmed boolean,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  full_name text,
  company_id uuid,
  company_name text,
  pending_company_id uuid,
  pending_company_name text,
  is_active boolean,
  has_profile boolean,
  roles text[]
)
language sql stable security definer set search_path = public
as $$
  select
    u.id,
    u.email::text,
    u.email_confirmed_at is not null,
    u.created_at,
    u.last_sign_in_at,
    coalesce(p.full_name, ''),
    p.company_id,
    c.name,
    p.pending_company_id,
    pc.name,
    coalesce(p.is_active, true),
    p.id is not null,
    coalesce(array_agg(distinct ur.role::text) filter (where ur.role is not null), '{}')
  from auth.users u
  left join public.profiles p   on p.id  = u.id
  left join public.companies c  on c.id  = p.company_id
  left join public.companies pc on pc.id = p.pending_company_id
  left join public.user_roles ur on ur.user_id = u.id
  -- No rows at all for anyone but a platform admin.
  where public.has_role(auth.uid(), 'super_admin'::app_role)
  group by u.id, u.email, u.email_confirmed_at, u.created_at, u.last_sign_in_at,
           p.full_name, p.company_id, c.name, p.pending_company_id, pc.name,
           p.is_active, p.id
  order by u.created_at desc;
$$;
revoke all on function public.admin_accounts() from public, anon;
grant execute on function public.admin_accounts() to authenticated;

-- ------------------------------------------------------- put them somewhere
-- No RLS policy lets a super admin write another person's profile, and this is
-- the only thing they need to write on one: which company it belongs to.
-- Passing null takes the account out of every company.
create or replace function public.admin_set_user_company(_user uuid, _company uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.has_role(auth.uid(), 'super_admin'::app_role) then
    raise exception 'not authorized';
  end if;
  if _company is not null
     and not exists (select 1 from public.companies where id = _company) then
    raise exception 'no such company';
  end if;

  -- Upsert for the same reason `bootstrap_company` does it: an account with no
  -- profile row is exactly the case this is here to rescue.
  insert into public.profiles (id, company_id, pending_company_id)
  values (_user, _company, null)
  on conflict (id) do update
    set company_id = excluded.company_id,
        pending_company_id = null;

  -- A role is granted inside a company, so it does not survive leaving one.
  -- Platform admin is not granted inside anything and is left alone.
  delete from public.user_roles
   where user_id = _user
     and role <> 'super_admin'::app_role
     and company_id is distinct from _company;
end;
$$;
revoke all on function public.admin_set_user_company(uuid, uuid) from public, anon;
grant execute on function public.admin_set_user_company(uuid, uuid) to authenticated;

-- ------------------------------------------------------------ give them a role
-- One role per company, replacing whatever was there. `_role` null clears it.
-- `_company` null is the platform itself, which is where super_admin lives.
create or replace function public.admin_set_user_role(_user uuid, _company uuid, _role public.app_role)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.has_role(auth.uid(), 'super_admin'::app_role) then
    raise exception 'not authorized';
  end if;
  -- Taking the last platform admin's own role away would lock the platform out
  -- of itself, so it is refused rather than discovered later.
  if _role is distinct from 'super_admin'::app_role
     and exists (select 1 from public.user_roles
                  where user_id = _user and role = 'super_admin'::app_role)
     and (select count(*) from public.user_roles where role = 'super_admin'::app_role) <= 1 then
    raise exception 'this is the last platform admin';
  end if;

  delete from public.user_roles
   where user_id = _user and company_id is not distinct from _company;

  if _role is not null then
    insert into public.user_roles (user_id, company_id, role)
    values (_user, _company, _role);
  end if;
end;
$$;
revoke all on function public.admin_set_user_role(uuid, uuid, public.app_role) from public, anon;
grant execute on function public.admin_set_user_role(uuid, uuid, public.app_role) to authenticated;

-- ---------------------------------------------------------------- erase them
-- Deleting the auth account is what actually removes a person: every table that
-- holds their work references `auth.users` with `on delete cascade`, so their
-- shifts, punches, time off, trades and availability go with it. Audit log
-- entries keep the record and lose the actor.
--
-- There is no undo, which is why the screen that calls this makes you type the
-- email first.
create or replace function public.admin_delete_user(_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.has_role(auth.uid(), 'super_admin'::app_role) then
    raise exception 'not authorized';
  end if;
  if _user = auth.uid() then
    raise exception 'you cannot delete the account you are signed in with';
  end if;
  if exists (select 1 from public.user_roles
              where user_id = _user and role = 'super_admin'::app_role)
     and (select count(distinct user_id) from public.user_roles
           where role = 'super_admin'::app_role) <= 1 then
    raise exception 'this is the last platform admin';
  end if;

  delete from auth.users where id = _user;
end;
$$;
revoke all on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;
