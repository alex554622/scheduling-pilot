-- Ghost mode: a super admin steps into one company as if they were its admin,
-- to help out as IT. Nothing about their account changes — no profile
-- company_id, no extra user_roles row. Instead the two helpers every policy and
-- RPC is built on learn about an open ghost session:
--
--   current_company_id()  → the ghosted company while a session is open
--   has_role(me, 'company_admin', that company) → true while a session is open
--
-- so every page and RPC that already works for a company admin works for the
-- super admin too, without touching any of them. Only the caller's own checks
-- change (`_user = auth.uid()`): lists of "who are this company's admins", read
-- by other people, never pick the ghost up.
--
-- Start and end are written to the company's audit log, and anything changed
-- along the way carries the super admin's own user id as the actor.

create table if not exists public.ghost_sessions (
  id uuid primary key default gen_random_uuid(),
  super_admin_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

-- One open session per super admin.
create unique index if not exists ghost_sessions_one_open
  on public.ghost_sessions (super_admin_id) where ended_at is null;
create index if not exists ghost_sessions_company_idx
  on public.ghost_sessions (company_id, started_at desc);

alter table public.ghost_sessions enable row level security;

-- Read-only from the client; opened and closed through the RPCs below.
drop policy if exists ghost_sessions_read on public.ghost_sessions;
create policy ghost_sessions_read on public.ghost_sessions for select to authenticated
  using (
    super_admin_id = auth.uid()
    or exists (select 1 from public.user_roles r
                where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role)
  );

-- The company the caller is ghosting, or null. Re-checks the real super_admin
-- row every time, so taking the role away ends ghost access immediately.
create or replace function public.ghost_company_id()
returns uuid language sql stable security definer set search_path = public
as $$
  select g.company_id
    from public.ghost_sessions g
   where g.super_admin_id = auth.uid()
     and g.ended_at is null
     and exists (select 1 from public.user_roles r
                  where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role)
   limit 1;
$$;

revoke execute on function public.ghost_company_id() from public, anon;
grant execute on function public.ghost_company_id() to authenticated;

create or replace function public.current_company_id()
returns uuid language sql stable security definer set search_path = public
as $$
  select coalesce(
    public.ghost_company_id(),
    (select company_id from public.profiles where id = auth.uid())
  );
$$;

create or replace function public.has_role(_user uuid, _role public.app_role, _company uuid default null)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
     where user_id = _user
       and role = _role
       and (_company is null or company_id = _company)
  )
  or (
    _user = auth.uid()
    and _role::text in ('company_admin', 'supervisor')
    and exists (
      select 1 from public.ghost_sessions g
       where g.super_admin_id = _user
         and g.ended_at is null
         and (_company is null or g.company_id = _company)
         and exists (select 1 from public.user_roles r
                      where r.user_id = _user and r.role = 'super_admin'::public.app_role)
    )
  );
$$;

create or replace function public.start_ghost_session(_company uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  prev uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.user_roles
                  where user_id = uid and role = 'super_admin'::public.app_role) then
    raise exception 'only a super admin can use ghost mode';
  end if;
  if not exists (select 1 from public.companies where id = _company) then
    raise exception 'company not found';
  end if;

  -- Switching straight from one company to another closes the first one.
  update public.ghost_sessions
     set ended_at = now()
   where super_admin_id = uid and ended_at is null
  returning company_id into prev;
  if prev is not null then
    insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id)
    values (prev, uid, 'ghost.ended', 'company', prev);
  end if;

  insert into public.ghost_sessions (super_admin_id, company_id) values (uid, _company);
  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id)
  values (_company, uid, 'ghost.started', 'company', _company);
end; $$;

create or replace function public.end_ghost_session()
returns void language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  prev uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  update public.ghost_sessions
     set ended_at = now()
   where super_admin_id = uid and ended_at is null
  returning company_id into prev;
  if prev is not null then
    insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id)
    values (prev, uid, 'ghost.ended', 'company', prev);
  end if;
end; $$;

revoke execute on function public.start_ghost_session(uuid) from public, anon;
revoke execute on function public.end_ghost_session() from public, anon;
grant execute on function public.start_ghost_session(uuid) to authenticated;
grant execute on function public.end_ghost_session() to authenticated;
