-- Temporary passwords: a company admin resets a member's password.
--
-- From Employees → Edit member → "Set a temporary password", an admin gives a
-- member a temporary password (typed, or made up here). It replaces their old
-- one at once, signs them out of every device, and is marked as temporary:
-- after signing in with it they must choose their own before they can use the
-- app. The admin hands the password over in person; nothing is emailed.
--
-- Who may reset whom:
--   * a company admin, for an active member of the company they have
--     selected — not themselves, not a platform admin, and not someone who is
--     also active in another company where this admin is not an admin (a
--     password is for the whole account, so one company may not take over a
--     person another company relies on);
--   * a platform admin, for anyone but another platform admin.
-- Every reset is written to the audit log.
--
-- The password is stored the way Auth stores it (bcrypt in
-- auth.users.encrypted_password), so signing in works as normal. Setting one
-- also confirms the email address: the admin is vouching for the person, and
-- an unconfirmed address would otherwise refuse the sign-in.
--
-- Re-runnable; applied by hand in Studio.

begin;

create extension if not exists pgcrypto with schema extensions;

-- One row per account whose password is temporary. Nobody reads it directly.
create table if not exists public.password_resets (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  set_by     uuid references auth.users(id) on delete set null,
  set_at     timestamptz not null default now(),
  temp_hash  text not null
);
alter table public.password_resets enable row level security;
revoke all on public.password_resets from public, anon, authenticated;
grant all on public.password_resets to service_role;

-- May _actor give _target a temporary password from _company?
create or replace function public.can_reset_password(_actor uuid, _target uuid, _company uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _actor is not null and _target is not null and _actor <> _target
     and not public.has_role(_target, 'super_admin'::public.app_role)
     and (
          public.has_role(_actor, 'super_admin'::public.app_role)
       or (_company is not null
           and public.has_role(_actor, 'company_admin'::public.app_role, _company)
           and exists (select 1 from public.company_memberships m
                        where m.user_id = _target and m.company_id = _company and m.status = 'active')
           and not exists (select 1 from public.company_memberships m
                            where m.user_id = _target and m.status = 'active'
                              and m.company_id <> _company
                              and not public.has_role(_actor, 'company_admin'::public.app_role, m.company_id)))
     );
$$;
revoke all on function public.can_reset_password(uuid, uuid, uuid) from public, anon;
grant execute on function public.can_reset_password(uuid, uuid, uuid) to authenticated;

-- Give _user a temporary password and return it. A blank _password makes one
-- up: ten letters and digits, without look-alikes (0/O, 1/l/I).
create or replace function public.admin_set_temp_password(_user uuid, _password text default null)
returns text language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  cid uuid := public.current_company_id();
  alphabet constant text := 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  pw text := nullif(btrim(coalesce(_password, '')), '');
  bytes bytea;
  h text;
  i int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public.can_reset_password(auth.uid(), _user, cid) then
    raise exception 'You can''t reset this person''s password.';
  end if;

  if pw is null then
    bytes := extensions.gen_random_bytes(10);
    pw := '';
    for i in 0..9 loop
      pw := pw || substr(alphabet, (get_byte(bytes, i) % length(alphabet)) + 1, 1);
    end loop;
  elsif length(pw) < 8 then
    raise exception 'A temporary password needs at least 8 characters.';
  elsif length(pw) > 72 then
    raise exception 'A temporary password can be at most 72 characters.';
  end if;

  h := extensions.crypt(pw, extensions.gen_salt('bf', 10));
  update auth.users
     set encrypted_password = h,
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at = now()
   where id = _user;
  if not found then raise exception 'That account no longer exists.'; end if;

  -- Sign them out everywhere: the old password's sessions end with it.
  begin
    delete from auth.refresh_tokens where user_id = _user::text;
    delete from auth.sessions where user_id = _user;
  exception when undefined_table or undefined_column then
    null; -- an older Auth schema: the password still changed
  end;

  insert into public.password_resets (user_id, company_id, set_by, set_at, temp_hash)
  values (_user, cid, auth.uid(), now(), h)
  on conflict (user_id) do update
    set company_id = excluded.company_id, set_by = excluded.set_by,
        set_at = excluded.set_at, temp_hash = excluded.temp_hash;

  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id)
  values (cid, auth.uid(), 'member.temp_password_set', 'user', _user);

  return pw;
end; $$;
revoke all on function public.admin_set_temp_password(uuid, text) from public, anon;
grant execute on function public.admin_set_temp_password(uuid, text) to authenticated;

-- Is the caller still on a temporary password? False once they have changed
-- it any way at all (this screen, or "Forgot password").
create or replace function public.my_password_change_required()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.password_resets r
                   join auth.users u on u.id = r.user_id
                  where r.user_id = auth.uid() and u.encrypted_password = r.temp_hash);
$$;
revoke all on function public.my_password_change_required() from public, anon;
grant execute on function public.my_password_change_required() to authenticated;

-- After choosing their own password: drop the temporary mark. Does nothing
-- (and says so) while the password is still the temporary one.
create or replace function public.finish_password_change()
returns boolean language plpgsql volatile security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if public.my_password_change_required() then return false; end if;
  delete from public.password_resets where user_id = auth.uid();
  return true;
end; $$;
revoke all on function public.finish_password_change() from public, anon;
grant execute on function public.finish_password_change() to authenticated;

commit;

notify pgrst, 'reload schema';
