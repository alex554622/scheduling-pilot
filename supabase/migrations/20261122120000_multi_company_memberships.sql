-- Multi-company memberships.
--
-- One account can now belong to several companies, with its own role,
-- department, position and employment details in each, and switch between
-- them without signing out.
--
-- How "the current company" is decided (current_company_id()):
--   1. a super admin's open ghost session, as before;
--   2. else the `x-company-id` request header the app sends with every API call,
--      but only if the caller has an ACTIVE membership there. A header naming a
--      company they are not active in gives NO company at all (never a silent
--      fallback to another one), so a stale tab can't read or write elsewhere;
--   3. else, with no header (realtime, old app builds), profiles.company_id —
--      now "the company last selected" — if that membership is still active.
--
-- has_role(me, role, company) for company roles now also requires an active
-- membership and, when asked about the caller themselves, that the company is
-- the selected one. So being an admin in one company gives nothing anywhere
-- else, and a suspension or revocation bites on the very next request.
--
-- Data: company_memberships holds the per-company fields that used to live on
-- profiles (department, position, employee code, weekly max, active flag).
-- profiles keeps them as a mirror of the selected company for the app build
-- that is live today; the new app never reads them. Nothing is deleted:
-- every profiles.company_id becomes an active membership, every open
-- employment separation a revoked one, every pending_company_id a pending
-- join request.
--
-- Apply order (by hand, in Studio):
--   this file  →  20261122130000_multi_company_supervisor_scope.sql
-- The second file needs 20261121120000_supervisor_departments.sql applied
-- first. This file does not depend on it.
--
-- Re-runnable.

-- ============================================================== tables ====

begin;

create table if not exists public.company_memberships (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  company_id        uuid not null references public.companies(id) on delete cascade,
  status            text not null default 'active'
                    check (status in ('active', 'suspended', 'revoked', 'left')),
  department_id     uuid references public.departments(id) on delete set null,
  position          text,
  position_id       uuid references public.positions(id) on delete set null,
  employee_code     text,
  max_weekly_hours  numeric(5,2) not null default 40,
  is_active         boolean not null default true,
  joined_at         timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  status_changed_by uuid references auth.users(id) on delete set null,
  status_reason     text,
  unique (user_id, company_id)
);
create index if not exists company_memberships_company_idx
  on public.company_memberships (company_id, status);
create index if not exists company_memberships_user_idx
  on public.company_memberships (user_id, status);

create table if not exists public.company_join_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  message       text check (message is null or char_length(message) <= 500),
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references auth.users(id) on delete set null,
  decision_note text check (decision_note is null or char_length(decision_note) <= 500)
);
create unique index if not exists company_join_requests_one_pending
  on public.company_join_requests (user_id, company_id) where status = 'pending';
create index if not exists company_join_requests_company_idx
  on public.company_join_requests (company_id, status, created_at desc);
create index if not exists company_join_requests_user_idx
  on public.company_join_requests (user_id, created_at desc);

-- Every company-code lookup, for rate limiting. Never readable from the client.
create table if not exists public.company_code_attempts (
  id      bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  at      timestamptz not null default now(),
  ok      boolean not null
);
create index if not exists company_code_attempts_user_idx
  on public.company_code_attempts (user_id, at desc);

alter table public.companies
  add column if not exists join_code_enabled boolean not null default true,
  add column if not exists members_can_leave boolean not null default true;

-- Notifications belong to the company they are about; null = account-wide
-- (membership decisions, platform notices). Older rows stay null and so keep
-- showing up wherever the person is.
alter table public.notifications
  add column if not exists company_id uuid references public.companies(id) on delete cascade;
create index if not exists notifications_user_company_idx
  on public.notifications (user_id, company_id, created_at desc);

-- ============================================ per-company keys on tables ====
-- These were one row per person; a person in two companies needs one each.

do $$
begin
  if exists (select 1 from pg_constraint
              where conrelid = 'public.employee_clock_codes'::regclass
                and conname = 'employee_clock_codes_pkey'
                and array_length(conkey, 1) = 1) then
    alter table public.employee_clock_codes drop constraint employee_clock_codes_pkey;
    alter table public.employee_clock_codes add primary key (user_id, company_id);
  end if;

  if exists (select 1 from pg_constraint
              where conrelid = 'public.member_visibility'::regclass
                and conname = 'member_visibility_pkey'
                and array_length(conkey, 1) = 1) then
    alter table public.member_visibility drop constraint member_visibility_pkey;
    alter table public.member_visibility add primary key (user_id, company_id);
  end if;

  if exists (select 1 from pg_constraint
              where conrelid = 'public.break_reminder_dismissals'::regclass
                and conname = 'break_reminder_dismissals_user_id_kind_key') then
    alter table public.break_reminder_dismissals
      drop constraint break_reminder_dismissals_user_id_kind_key;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.break_reminder_dismissals'::regclass
                    and conname = 'break_reminder_dismissals_user_company_kind_key') then
    alter table public.break_reminder_dismissals
      add constraint break_reminder_dismissals_user_company_kind_key unique (user_id, company_id, kind);
  end if;
end $$;

-- ============================================================ backfill ====

-- Everyone's current company becomes an active membership with their details.
insert into public.company_memberships (
  user_id, company_id, status, department_id, position, position_id,
  employee_code, max_weekly_hours, is_active, joined_at
)
select p.id, p.company_id, 'active', p.department_id, p.position, p.position_id,
       p.employee_code, p.max_weekly_hours, p.is_active, p.created_at
  from public.profiles p
  join auth.users u on u.id = p.id
 where p.company_id is not null
on conflict (user_id, company_id) do nothing;

-- Former employees keep a revoked membership, so rehire still restores them.
insert into public.company_memberships (
  user_id, company_id, status, department_id, position, position_id,
  employee_code, max_weekly_hours, joined_at, status_changed_at, status_changed_by,
  status_reason
)
select distinct on (s.user_id, s.company_id)
       s.user_id, s.company_id, 'revoked',
       (select d.id from public.departments d where d.id = s.prior_department_id),
       s.prior_position,
       (select po.id from public.positions po where po.id = s.prior_position_id),
       s.prior_employee_code, coalesce(s.prior_max_weekly_hours, 40),
       s.separated_at, s.separated_at, s.separated_by, s.reason::text
  from public.employment_separations s
 where s.rehired_at is null
 order by s.user_id, s.company_id, s.separated_at desc
on conflict (user_id, company_id) do nothing;

-- Waiting join requests.
insert into public.company_join_requests (user_id, company_id, status)
select p.id, p.pending_company_id, 'pending'
  from public.profiles p
  join auth.users u on u.id = p.id
 where p.pending_company_id is not null
   and not exists (select 1 from public.company_memberships m
                    where m.user_id = p.id and m.company_id = p.pending_company_id
                      and m.status = 'active')
on conflict do nothing;

-- ============================================================= helpers ====

-- The company the app asked for in this request, or null.
create or replace function public.requested_company_id()
returns uuid language plpgsql stable set search_path = public
as $$
declare
  h text;
begin
  h := nullif(current_setting('request.headers', true), '')::json ->> 'x-company-id';
  if h is null or h !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return h::uuid;
exception when others then
  return null;
end; $$;

create or replace function public.current_company_id()
returns uuid language plpgsql stable security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  ghost uuid;
  wanted uuid;
  cid uuid;
begin
  if uid is null then return null; end if;

  ghost := public.ghost_company_id();
  if ghost is not null then return ghost; end if;

  wanted := public.requested_company_id();
  if wanted is not null then
    select m.company_id into cid
      from public.company_memberships m
     where m.user_id = uid and m.company_id = wanted and m.status = 'active';
    return cid;  -- null when not active there: no silent fallback
  end if;

  select m.company_id into cid
    from public.profiles p
    join public.company_memberships m
      on m.user_id = p.id and m.company_id = p.company_id and m.status = 'active'
   where p.id = uid;
  return cid;
end; $$;

create or replace function public.has_role(_user uuid, _role public.app_role, _company uuid default null)
returns boolean language sql stable security definer set search_path = public
as $$
  select case
    when _role = 'super_admin'::public.app_role then
      exists (select 1 from public.user_roles
               where user_id = _user and role = _role
                 and (_company is null or company_id = _company))
    else
      exists (
        select 1
          from public.user_roles r
          join public.company_memberships m
            on m.user_id = r.user_id and m.company_id = r.company_id and m.status = 'active'
         where r.user_id = _user
           and r.role = _role
           and (_company is null or r.company_id = _company)
           -- Your own rights only count inside the company you have selected.
           and (_user is distinct from auth.uid() or r.company_id = public.current_company_id())
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
      )
  end;
$$;

-- An active member of that company.
create or replace function public.is_member(_user uuid, _company uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.company_memberships
                  where user_id = _user and company_id = _company and status = 'active');
$$;

-- The caller's selected company, if _user is an active member of it. What
-- "that employee's company" means for anything a manager does to someone.
create or replace function public.member_company(_user uuid)
returns uuid language sql stable security definer set search_path = public
as $$
  select m.company_id
    from public.company_memberships m
   where m.user_id = _user
     and m.company_id = public.current_company_id()
     and m.status = 'active';
$$;

-- Last-admin guard used by leave / demote / suspend / delete-account.
create or replace function public.other_active_admins(_company uuid, _user uuid)
returns int language sql stable security definer set search_path = public
as $$
  select count(distinct r.user_id)::int
    from public.user_roles r
    join public.company_memberships m
      on m.user_id = r.user_id and m.company_id = r.company_id and m.status = 'active'
   where r.company_id = _company
     and r.role = 'company_admin'::public.app_role
     and r.user_id <> _user;
$$;

-- Moves someone's selected company off one they no longer belong to.
create or replace function public.reselect_company(_user uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  update public.profiles p
     set company_id = (select m.company_id from public.company_memberships m
                        where m.user_id = _user and m.status = 'active'
                        order by m.status_changed_at desc limit 1)
   where p.id = _user
     and (p.company_id is null
          or not exists (select 1 from public.company_memberships m
                          where m.user_id = _user and m.company_id = p.company_id
                            and m.status = 'active'));
end; $$;

create or replace function public.log_membership_event(
  _company uuid, _action text, _user uuid, _before jsonb default null, _after jsonb default null
)
returns void language sql security definer set search_path = public
as $$
  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, before, after)
  values (_company, auth.uid(), _action, 'membership', _user, _before, _after);
$$;

create or replace function public.notify_member(
  _user uuid, _type text, _title text, _body text, _link text default '/settings?tab=companies'
)
returns void language sql security definer set search_path = public
as $$
  insert into public.notifications (user_id, type, title, body, link, company_id)
  values (_user, _type, _title, _body, _link, null);
$$;

-- ------------------------------------------- punch helpers, per company ----
-- They used to look at someone's last punch anywhere; a person who works for
-- two companies has two independent clocks. A null company keeps the old
-- behaviour for any caller that predates this file.

drop function if exists public.break_locked_until(uuid);
create or replace function public.break_locked_until(_user uuid, _company uuid default null)
returns timestamptz
language sql stable security definer set search_path = public
as $$
  select case
           when p.kind = 'break_start'
                and p.break_minutes is not null
                and p.at + make_interval(mins => p.break_minutes) > now()
           then p.at + make_interval(mins => p.break_minutes)
         end
    from public.time_punches p
   where p.user_id = _user
     and (_company is null or p.company_id = _company)
   order by p.at desc, p.created_at desc, p.id desc
   limit 1;
$$;

drop function if exists public.current_work_location(uuid);
create or replace function public.current_work_location(_user uuid, _company uuid default null)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  p public.time_punches;
  moved uuid;
begin
  select * into p from public.time_punches
   where user_id = _user and kind = 'in'
     and (_company is null or company_id = _company)
   order by at desc, created_at desc, id desc
   limit 1;
  if p.id is null then return null; end if;
  select location_id into moved from public.location_moves
   where user_id = _user and company_id = p.company_id and at >= p.at
   order by at desc, created_at desc
   limit 1;
  return coalesce(moved, p.location_id);
end; $$;

drop function if exists public.stretch_location(uuid, timestamptz);
create or replace function public.stretch_location(_user uuid, _at timestamptz, _company uuid default null)
returns uuid
language sql stable security definer set search_path = public
as $$
  select p.location_id
    from public.time_punches p
   where p.user_id = _user
     and (_company is null or p.company_id = _company)
     and p.kind = 'in'
     and p.at <= _at
     and p.at > _at - interval '24 hours'
   order by p.at desc, p.created_at desc, p.id desc
   limit 1;
$$;

-- ================================================= profile mirror ====
-- profiles.company_id = the selected company. The per-company columns on
-- profiles follow the selected membership, so the app build live today keeps
-- reading the right values. Writes that build makes to those columns go back
-- to the membership — but only from that company's admin (an employee may
-- still change their own job title, as before; nothing else).

create or replace function public.profiles_membership_mirror()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  m public.company_memberships;
  admin boolean;
begin
  if new.company_id is distinct from old.company_id then
    if new.company_id is not null then
      select * into m from public.company_memberships
       where user_id = new.id and company_id = new.company_id;
      if m.id is null or m.status <> 'active' then
        raise exception 'not an active member of that company';
      end if;
      new.department_id    := m.department_id;
      new.position         := m.position;
      new.position_id      := m.position_id;
      new.employee_code    := m.employee_code;
      new.max_weekly_hours := m.max_weekly_hours;
      new.is_active        := m.is_active;
    else
      new.department_id := null;
      new.position      := null;
      new.position_id   := null;
      new.employee_code := null;
    end if;
    return new;
  end if;

  -- Only a statement aimed at profiles itself writes through; the copy made
  -- by the membership trigger below (depth 2) does not bounce back.
  if pg_trigger_depth() > 1 or new.company_id is null then return new; end if;
  if (new.department_id, new.position, new.position_id, new.employee_code,
      new.max_weekly_hours, new.is_active)
     is not distinct from
     (old.department_id, old.position, old.position_id, old.employee_code,
      old.max_weekly_hours, old.is_active) then
    return new;
  end if;

  admin := auth.uid() is null
           or public.has_role(auth.uid(), 'company_admin'::public.app_role, new.company_id)
           or public.has_role(auth.uid(), 'super_admin'::public.app_role);
  if not admin then
    new.department_id    := old.department_id;
    new.position_id      := old.position_id;
    new.employee_code    := old.employee_code;
    new.max_weekly_hours := old.max_weekly_hours;
    new.is_active        := old.is_active;
    if new.id is distinct from auth.uid() then new.position := old.position; end if;
  end if;

  update public.company_memberships
     set department_id = new.department_id, position = new.position,
         position_id = new.position_id, employee_code = new.employee_code,
         max_weekly_hours = new.max_weekly_hours, is_active = new.is_active
   where user_id = new.id and company_id = new.company_id;
  return new;
end; $$;

drop trigger if exists profiles_membership_mirror on public.profiles;
create trigger profiles_membership_mirror
  before update on public.profiles
  for each row execute function public.profiles_membership_mirror();

create or replace function public.memberships_to_profile()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if new.status = 'active' then
    update public.profiles
       set department_id = new.department_id, position = new.position,
           position_id = new.position_id, employee_code = new.employee_code,
           max_weekly_hours = new.max_weekly_hours, is_active = new.is_active
     where id = new.user_id and company_id = new.company_id;
  else
    perform public.reselect_company(new.user_id);
  end if;
  return null;
end; $$;

drop trigger if exists memberships_to_profile on public.company_memberships;
create trigger memberships_to_profile
  after insert or update on public.company_memberships
  for each row execute function public.memberships_to_profile();

-- Notifications are stamped with the company the action happened in, when
-- the recipient belongs to it. Membership notices stay account-wide.
create or replace function public.notifications_stamp_company()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  cid uuid;
begin
  if new.company_id is not null or new.type like 'membership\_%' then return new; end if;
  cid := public.current_company_id();
  if cid is not null and exists (select 1 from public.company_memberships m
                                  where m.user_id = new.user_id and m.company_id = cid) then
    new.company_id := cid;
  end if;
  return new;
end; $$;

drop trigger if exists notifications_stamp_company on public.notifications;
create trigger notifications_stamp_company
  before insert on public.notifications
  for each row execute function public.notifications_stamp_company();

-- Role changes made straight against user_roles (the Employees page does
-- this) go into the company's audit log too.
create or replace function public.audit_user_roles()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(new.company_id, old.company_id) is null then return null; end if;
  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, before, after)
  values (coalesce(new.company_id, old.company_id), auth.uid(),
          'membership.role_' || case when tg_op = 'INSERT' then 'granted' else 'removed' end,
          'membership', coalesce(new.user_id, old.user_id),
          case when tg_op = 'DELETE' then jsonb_build_object('role', old.role) end,
          case when tg_op = 'INSERT' then jsonb_build_object('role', new.role) end);
  return null;
end; $$;

drop trigger if exists audit_user_roles on public.user_roles;
create trigger audit_user_roles
  after insert or delete on public.user_roles
  for each row execute function public.audit_user_roles();

-- ================================================================ RLS ====

alter table public.company_memberships enable row level security;
alter table public.company_join_requests enable row level security;
alter table public.company_code_attempts enable row level security;

-- Read-only from the client; every change goes through the functions below
-- (or the company_members view's trigger).
drop policy if exists memberships_view on public.company_memberships;
create policy memberships_view on public.company_memberships for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_role(auth.uid(), 'company_admin'::public.app_role, company_id)
    or public.has_role(auth.uid(), 'super_admin'::public.app_role)
  );

drop policy if exists join_requests_view on public.company_join_requests;
create policy join_requests_view on public.company_join_requests for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_role(auth.uid(), 'company_admin'::public.app_role, company_id)
    or public.has_role(auth.uid(), 'super_admin'::public.app_role)
  );

revoke insert, update, delete on public.company_memberships from anon, authenticated;
revoke insert, update, delete on public.company_join_requests from anon, authenticated;
revoke all on public.company_code_attempts from anon, authenticated;
grant select on public.company_memberships to authenticated;
grant select on public.company_join_requests to authenticated;

-- The people in the selected company, shaped like the old profiles rows so a
-- page that listed `profiles where company_id = X` reads this instead.
-- Not security_invoker: it filters for itself, exactly like profile_view did
-- (members see their company's people; a super admin sees everyone).
create or replace view public.company_members as
select m.user_id        as id,
       m.company_id,
       p.full_name,
       p.phone,
       m.position,
       m.position_id,
       m.department_id,
       m.employee_code,
       m.max_weekly_hours,
       m.is_active,
       m.status,
       m.joined_at,
       p.created_at
  from public.company_memberships m
  join public.profiles p on p.id = m.user_id
 where m.status = 'active'
   and (m.company_id = public.current_company_id()
        or public.has_role(auth.uid(), 'super_admin'::public.app_role));

revoke all on public.company_members from anon;
grant select, update on public.company_members to authenticated;

-- Edits through the view: name and phone go to the profile, everything else
-- to that company's membership. Admins of the row's company only — and a
-- person may change their own name and job title.
create or replace function public.company_members_update()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  admin boolean := public.has_role(auth.uid(), 'company_admin'::public.app_role, old.company_id)
                   or public.has_role(auth.uid(), 'super_admin'::public.app_role);
  self boolean := old.id = auth.uid();
begin
  if not (admin or self) then raise exception 'not authorized'; end if;
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id then
    raise exception 'a membership cannot be moved';
  end if;

  if new.full_name is distinct from old.full_name or new.phone is distinct from old.phone then
    update public.profiles
       set full_name = coalesce(new.full_name, full_name),
           phone = case when admin then new.phone else phone end
     where id = old.id;
  end if;

  if admin then
    if new.department_id is not null and not exists (
         select 1 from public.departments where id = new.department_id and company_id = old.company_id) then
      raise exception 'that department is not in this company';
    end if;
    if new.position_id is not null and not exists (
         select 1 from public.positions where id = new.position_id and company_id = old.company_id) then
      raise exception 'that position is not in this company';
    end if;
    update public.company_memberships
       set position = new.position, position_id = new.position_id,
           department_id = new.department_id, employee_code = new.employee_code,
           max_weekly_hours = coalesce(new.max_weekly_hours, max_weekly_hours),
           is_active = coalesce(new.is_active, is_active)
     where user_id = old.id and company_id = old.company_id;
  elsif new.position is distinct from old.position then
    update public.company_memberships set position = new.position
     where user_id = old.id and company_id = old.company_id;
  end if;
  return new;
end; $$;

drop trigger if exists company_members_update on public.company_members;
create trigger company_members_update
  instead of update on public.company_members
  for each row execute function public.company_members_update();

-- ----------------------------------------------------- existing policies ----

-- A profile is visible to its owner, to the people in the selected company
-- it belongs to (former members: admins only), to that company's admins
-- while the person has a request waiting, and to super admins.
drop policy if exists "profile_view" on public.profiles;
create policy "profile_view" on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or exists (select 1 from public.company_memberships m
                where m.user_id = profiles.id
                  and m.company_id = public.current_company_id()
                  and (m.status = 'active'
                       or public.has_role(auth.uid(), 'company_admin'::public.app_role, m.company_id)))
    or exists (select 1 from public.company_join_requests r
                where r.user_id = profiles.id
                  and r.status = 'pending'
                  and public.has_role(auth.uid(), 'company_admin'::public.app_role, r.company_id))
    or public.has_role(auth.uid(), 'super_admin'::public.app_role)
  );
drop policy if exists profile_view_pending on public.profiles;
drop policy if exists profile_update_pending on public.profiles;

-- Roles can only be handed to people who belong to the company.
drop policy if exists "roles_company_admin_manage" on public.user_roles;
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
    and exists (select 1 from public.company_memberships m
                 where m.user_id = user_roles.user_id and m.company_id = user_roles.company_id
                   and m.status in ('active', 'suspended'))
  );

drop policy if exists employee_clock_codes_admin_all on public.employee_clock_codes;
create policy employee_clock_codes_admin_all on public.employee_clock_codes for all to authenticated
  using (public.has_role(auth.uid(), 'company_admin'::public.app_role, company_id)
         or public.has_role(auth.uid(), 'super_admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'company_admin'::public.app_role, company_id)
              or public.has_role(auth.uid(), 'super_admin'::public.app_role));

drop policy if exists kiosk_devices_admin_all on public.kiosk_devices;
create policy kiosk_devices_admin_all on public.kiosk_devices for all to authenticated
  using (public.has_role(auth.uid(), 'company_admin'::public.app_role, company_id)
         or public.has_role(auth.uid(), 'super_admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'company_admin'::public.app_role, company_id)
              or public.has_role(auth.uid(), 'super_admin'::public.app_role));

-- Your own rows: only the selected company's.
drop policy if exists "availability_self_manage" on public.employee_availability;
create policy "availability_self_manage" on public.employee_availability for all to authenticated
  using (employee_id = auth.uid() and company_id = public.current_company_id())
  with check (employee_id = auth.uid() and company_id = public.current_company_id());

drop policy if exists location_moves_view on public.location_moves;
create policy location_moves_view on public.location_moves for select to authenticated
  using (
    (user_id = auth.uid() and company_id = public.current_company_id())
    or (company_id = public.current_company_id()
        and public.has_role(auth.uid(), 'company_admin'::app_role, company_id))
    or public.has_role(auth.uid(), 'super_admin'::app_role)
  );

drop policy if exists notifications_own_select on public.notifications;
create policy notifications_own_select on public.notifications for select to authenticated
  using (user_id = auth.uid()
         and (company_id is null or company_id = public.current_company_id()));

-- ======================================================== member RPCs ====

-- The companies I belong to (any status but revoked/left), for the switcher.
create or replace function public.my_companies()
returns table (
  company_id uuid, name text, company_status text, membership_status text,
  roles text[], is_selected boolean, unread integer
)
language sql stable security definer set search_path = public
as $$
  select c.id, c.name, c.status, m.status,
         coalesce((select array_agg(r.role::text order by r.role)
                     from public.user_roles r
                    where r.user_id = m.user_id and r.company_id = m.company_id), '{}'),
         c.id = (select p.company_id from public.profiles p where p.id = auth.uid()),
         (select count(*)::int from public.notifications n
           where n.user_id = m.user_id and n.company_id = m.company_id and n.read_at is null)
    from public.company_memberships m
    join public.companies c on c.id = m.company_id
   where m.user_id = auth.uid()
     and m.status in ('active', 'suspended')
   order by c.name;
$$;

-- Remember the company the app switched to (the default for new sessions
-- and for requests that carry no header).
create or replace function public.switch_company(_company uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public.is_member(auth.uid(), _company) then
    raise exception 'You are not an active member of that company.';
  end if;
  update public.profiles set company_id = _company where id = auth.uid();
end; $$;

-- My join requests, newest first, with the company's name.
create or replace function public.my_join_requests()
returns table (
  id uuid, company_id uuid, company_name text, status text, message text,
  created_at timestamptz, decided_at timestamptz, decision_note text
)
language sql stable security definer set search_path = public
as $$
  select r.id, r.company_id, c.name, r.status, r.message, r.created_at, r.decided_at, r.decision_note
    from public.company_join_requests r
    join public.companies c on c.id = r.company_id
   where r.user_id = auth.uid()
   order by r.created_at desc
   limit 50;
$$;

-- Code lookup with rate limiting. Never raises after recording the attempt
-- (a raise would roll the record back), so failures return ok = false.
-- 10 lookups per 10 minutes, 20 misses per day, per account.
create or replace function public.lookup_company_code(_code text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  code text := upper(regexp_replace(coalesce(_code, ''), '\s', '', 'g'));
  recent int;
  misses int;
  c record;
  ok boolean;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if char_length(code) < 4 or char_length(code) > 32 or code !~ '^[A-Z0-9-]+$' then
    return jsonb_build_object('ok', false, 'message', 'Enter a valid company code.');
  end if;

  select count(*) filter (where at > now() - interval '10 minutes'),
         count(*) filter (where not a.ok)
    into recent, misses
    from public.company_code_attempts a
   where a.user_id = uid and a.at > now() - interval '1 day';
  if recent >= 10 or misses >= 20 then
    return jsonb_build_object('ok', false, 'message', 'Too many code attempts. Try again later.');
  end if;

  select co.id, co.name, co.status, co.join_code_enabled into c
    from public.companies co where upper(co.join_code) = code;
  ok := c.id is not null and c.status = 'active' and c.join_code_enabled;
  insert into public.company_code_attempts (user_id, ok) values (uid, ok);
  delete from public.company_code_attempts where at < now() - interval '2 days';

  if not ok then
    return jsonb_build_object('ok', false, 'message', 'That company code is not valid.');
  end if;
  return jsonb_build_object(
    'ok', true, 'company_id', c.id, 'name', c.name,
    'membership', (select m.status from public.company_memberships m
                    where m.user_id = uid and m.company_id = c.id),
    'pending', exists (select 1 from public.company_join_requests r
                        where r.user_id = uid and r.company_id = c.id and r.status = 'pending'));
end; $$;

-- Ask to join. A valid code never grants access by itself: it files a
-- request an admin of that company has to approve.
create or replace function public.request_to_join(_code text, _message text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  hit jsonb;
  cid uuid;
  mstatus text;
  rid uuid;
  who text;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  hit := public.lookup_company_code(_code);
  if not (hit->>'ok')::boolean then return hit; end if;
  cid := (hit->>'company_id')::uuid;

  select status into mstatus from public.company_memberships where user_id = uid and company_id = cid;
  if mstatus = 'active' then
    return jsonb_build_object('ok', false, 'message', 'You are already a member of that company.');
  elsif mstatus = 'suspended' then
    return jsonb_build_object('ok', false, 'message',
      'Your membership in that company is suspended. Ask one of its admins.');
  end if;

  select id into rid from public.company_join_requests
   where user_id = uid and company_id = cid and status = 'pending';
  if rid is null then
    insert into public.profiles (id, full_name)
    select u.id, coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), split_part(u.email, '@', 1))
      from auth.users u where u.id = uid
    on conflict (id) do nothing;

    insert into public.company_join_requests (user_id, company_id, message)
    values (uid, cid, nullif(btrim(coalesce(_message, '')), ''))
    returning id into rid;

    -- The live app build shows "waiting for approval" from this column.
    update public.profiles set pending_company_id = cid
     where id = uid and pending_company_id is null;

    select coalesce(nullif(trim(full_name), ''), 'Someone') into who from public.profiles where id = uid;
    insert into public.notifications (user_id, type, title, body, link, company_id)
    select distinct r.user_id, 'join_request', 'New request to join',
           who || ' asked to join ' || (hit->>'name') || '.', '/employees/join-requests', cid
      from public.user_roles r
      join public.company_memberships m
        on m.user_id = r.user_id and m.company_id = r.company_id and m.status = 'active'
     where r.company_id = cid and r.role = 'company_admin'::public.app_role;

    perform public.log_membership_event(cid, 'membership.requested', uid);
  end if;

  return jsonb_build_object('ok', true, 'request_id', rid, 'company_id', cid, 'name', hit->>'name');
end; $$;

-- Kept for the signup flow and the live app build: same as request_to_join.
create or replace function public.join_company_by_code(_code text)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
begin
  r := public.request_to_join(_code, null);
  if not (r->>'ok')::boolean then raise exception '%', r->>'message'; end if;
  return (r->>'company_id')::uuid;
end; $$;

-- Joining by company id without approval is gone.
create or replace function public.join_company(_company uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  raise exception 'Ask for the company code and send a join request instead.';
end; $$;

create or replace function public.cancel_join_request(_request uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  r public.company_join_requests;
begin
  update public.company_join_requests
     set status = 'cancelled', decided_at = now(), decided_by = auth.uid()
   where id = _request and user_id = auth.uid() and status = 'pending'
  returning * into r;
  if r.id is null then raise exception 'That request is not waiting any more.'; end if;
  update public.profiles
     set pending_company_id = (select q.company_id from public.company_join_requests q
                                where q.user_id = r.user_id and q.status = 'pending'
                                order by q.created_at desc limit 1)
   where id = r.user_id and pending_company_id = r.company_id;
  perform public.log_membership_event(r.company_id, 'membership.request_cancelled', r.user_id);
end; $$;

-- Gives someone exactly one role in a company.
create or replace function public.set_company_role(_user uuid, _company uuid, _role public.app_role)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if _role not in ('employee', 'company_admin', 'supervisor') then
    raise exception 'That role cannot be given inside a company.';
  end if;
  delete from public.user_roles
   where user_id = _user and company_id = _company and role <> _role;
  insert into public.user_roles (user_id, company_id, role)
  values (_user, _company, _role) on conflict do nothing;
end; $$;

create or replace function public.seat_check(_company uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  cap int := public.company_seat_limit(_company);
  used int;
begin
  if cap is null then return; end if;
  select count(*) into used from public.company_memberships
   where company_id = _company and status in ('active', 'suspended');
  if used >= cap then
    raise exception 'Your plan covers % employees and all seats are in use. Upgrade the plan to add more.', cap;
  end if;
end; $$;

-- Approve or reject a join request. Approving sets the role (only an admin
-- can make another admin — and only admins get here), department and team.
create or replace function public.decide_join_request(
  _request uuid,
  _approve boolean,
  _role public.app_role default 'employee',
  _department uuid default null,
  _position_id uuid default null,
  _position text default null,
  _note text default null
)
returns void language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  r public.company_join_requests;
  cname text;
  existing public.company_memberships;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  select * into r from public.company_join_requests where id = _request for update;
  if r.id is null then raise exception 'request not found'; end if;
  if not (public.has_role(caller, 'company_admin'::public.app_role, r.company_id)
          or public.has_role(caller, 'super_admin'::public.app_role)) then
    raise exception 'not authorized';
  end if;
  if r.status <> 'pending' then raise exception 'That request has already been answered.'; end if;
  select name into cname from public.companies where id = r.company_id;

  if not _approve then
    update public.company_join_requests
       set status = 'rejected', decided_at = now(), decided_by = caller,
           decision_note = nullif(btrim(coalesce(_note, '')), '')
     where id = r.id;
    perform public.notify_member(r.user_id, 'membership_rejected', 'Join request declined',
      'Your request to join ' || cname || ' was declined'
      || coalesce(': ' || nullif(btrim(coalesce(_note, '')), ''), '.'));
    perform public.log_membership_event(r.company_id, 'membership.rejected', r.user_id,
      null, jsonb_build_object('note', _note));
  else
    if _role not in ('employee', 'company_admin', 'supervisor') then
      raise exception 'That role cannot be given inside a company.';
    end if;
    if _department is not null and not exists (
         select 1 from public.departments where id = _department and company_id = r.company_id) then
      raise exception 'that department is not in this company';
    end if;
    if _position_id is not null and not exists (
         select 1 from public.positions where id = _position_id and company_id = r.company_id) then
      raise exception 'that position is not in this company';
    end if;

    select * into existing from public.company_memberships
     where user_id = r.user_id and company_id = r.company_id;
    if existing.status = 'suspended' then
      raise exception 'That person is suspended here. Reinstate them instead.';
    end if;
    if existing.id is null or existing.status <> 'active' then
      perform public.seat_check(r.company_id);
    end if;

    insert into public.company_memberships (
      user_id, company_id, status, department_id, position_id, position,
      joined_at, status_changed_at, status_changed_by
    ) values (
      r.user_id, r.company_id, 'active', _department, _position_id, nullif(btrim(coalesce(_position, '')), ''),
      now(), now(), caller
    )
    on conflict (user_id, company_id) do update
      set status = 'active',
          department_id = coalesce(excluded.department_id, company_memberships.department_id),
          position_id = coalesce(excluded.position_id, company_memberships.position_id),
          position = coalesce(excluded.position, company_memberships.position),
          is_active = true,
          status_changed_at = now(), status_changed_by = caller, status_reason = null;

    perform public.set_company_role(r.user_id, r.company_id, _role);

    -- Someone coming back closes their old separation record.
    update public.employment_separations
       set rehired_at = now(), rehired_by = caller
     where user_id = r.user_id and company_id = r.company_id and rehired_at is null;

    update public.company_join_requests
       set status = 'approved', decided_at = now(), decided_by = caller,
           decision_note = nullif(btrim(coalesce(_note, '')), '')
     where id = r.id;

    -- Their first company becomes the selected one.
    update public.profiles set company_id = r.company_id
     where id = r.user_id and company_id is null;

    perform public.notify_member(r.user_id, 'membership_approved', 'You''re in',
      'Your request to join ' || cname || ' was approved. Switch to it from the company menu.');
    perform public.log_membership_event(r.company_id, 'membership.approved', r.user_id, null,
      jsonb_build_object('role', _role, 'department_id', _department, 'position_id', _position_id));
  end if;

  update public.profiles
     set pending_company_id = (select q.company_id from public.company_join_requests q
                                where q.user_id = r.user_id and q.status = 'pending'
                                order by q.created_at desc limit 1)
   where id = r.user_id and pending_company_id = r.company_id;
end; $$;

-- The live app build approves by person, not by request.
create or replace function public.approve_membership(_user uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  rid uuid;
begin
  select q.id into rid from public.company_join_requests q
   where q.user_id = _user and q.status = 'pending'
     and (q.company_id = public.current_company_id()
          or public.has_role(auth.uid(), 'super_admin'::public.app_role))
   order by (q.company_id = public.current_company_id()) desc nulls last, q.created_at desc
   limit 1;
  if rid is null then raise exception 'no pending request'; end if;
  perform public.decide_join_request(rid, true);
end; $$;

create or replace function public.reject_membership(_user uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  rid uuid;
begin
  select q.id into rid from public.company_join_requests q
   where q.user_id = _user and q.status = 'pending'
     and (q.company_id = public.current_company_id()
          or public.has_role(auth.uid(), 'super_admin'::public.app_role))
   order by (q.company_id = public.current_company_id()) desc nulls last, q.created_at desc
   limit 1;
  if rid is null then return; end if;
  perform public.decide_join_request(rid, false);
end; $$;

-- Change someone's role in the selected company.
create or replace function public.set_member_role(_user uuid, _role public.app_role)
returns void language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid := public.current_company_id();
  before text[];
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if cid is null or not (public.has_role(caller, 'company_admin'::public.app_role, cid)
                         or public.has_role(caller, 'super_admin'::public.app_role)) then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.company_memberships
                  where user_id = _user and company_id = cid and status in ('active', 'suspended')) then
    raise exception 'That person is not a member of this company.';
  end if;
  if _role <> 'company_admin' and public.has_role(_user, 'company_admin'::public.app_role, cid)
     and public.other_active_admins(cid, _user) = 0 then
    raise exception 'Make someone else an admin first: a company needs at least one.';
  end if;
  select coalesce(array_agg(role::text), '{}') into before
    from public.user_roles where user_id = _user and company_id = cid;
  perform public.set_company_role(_user, cid, _role);
  perform public.log_membership_event(cid, 'membership.role_changed', _user,
    jsonb_build_object('roles', before), jsonb_build_object('roles', array[_role::text]));
end; $$;

-- Suspend: keeps everything, takes all access away right now.
create or replace function public.suspend_membership(_user uuid, _reason text default null)
returns void language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid := public.current_company_id();
  cname text;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if cid is null or not (public.has_role(caller, 'company_admin'::public.app_role, cid)
                         or public.has_role(caller, 'super_admin'::public.app_role)) then
    raise exception 'not authorized';
  end if;
  if _user = caller then raise exception 'You cannot suspend yourself.'; end if;
  update public.company_memberships
     set status = 'suspended', status_changed_at = now(), status_changed_by = caller,
         status_reason = nullif(btrim(coalesce(_reason, '')), '')
   where user_id = _user and company_id = cid and status = 'active';
  if not found then raise exception 'That person is not an active member of this company.'; end if;
  select name into cname from public.companies where id = cid;
  perform public.notify_member(_user, 'membership_suspended', 'Access suspended',
    'Your access to ' || cname || ' has been suspended by an admin.');
  perform public.log_membership_event(cid, 'membership.suspended', _user, null,
    jsonb_build_object('reason', _reason));
end; $$;

create or replace function public.reinstate_membership(_user uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid := public.current_company_id();
  cname text;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if cid is null or not (public.has_role(caller, 'company_admin'::public.app_role, cid)
                         or public.has_role(caller, 'super_admin'::public.app_role)) then
    raise exception 'not authorized';
  end if;
  update public.company_memberships
     set status = 'active', status_changed_at = now(), status_changed_by = caller, status_reason = null
   where user_id = _user and company_id = cid and status = 'suspended';
  if not found then raise exception 'That person is not suspended here.'; end if;
  update public.profiles set company_id = cid where id = _user and company_id is null;
  select name into cname from public.companies where id = cid;
  perform public.notify_member(_user, 'membership_reinstated', 'Access restored',
    'Your access to ' || cname || ' is back.');
  perform public.log_membership_event(cid, 'membership.reinstated', _user);
end; $$;

-- Ends someone's membership in one company. Shared by removal (an admin) and
-- leaving (the person). Their account and other companies are untouched.
create or replace function public.end_membership(
  _user uuid, _company uuid, _status text,
  _reason public.separation_reason, _note text, _by uuid
)
returns void language plpgsql security definer set search_path = public
as $$
declare
  prof public.profiles;
  m public.company_memberships;
  roles public.app_role[];
begin
  select * into m from public.company_memberships
   where user_id = _user and company_id = _company and status in ('active', 'suspended')
   for update;
  if m.id is null then raise exception 'That person is not a member of this company.'; end if;
  select * into prof from public.profiles where id = _user;

  select coalesce(array_agg(role), '{}'::public.app_role[]) into roles
    from public.user_roles where user_id = _user and company_id = _company;

  update public.employment_separations
     set rehired_at = now(), rehired_by = null
   where user_id = _user and company_id = _company and rehired_at is null;

  insert into public.employment_separations (
    user_id, company_id, reason, note, separated_by,
    prior_full_name, prior_position, prior_roles,
    prior_department_id, prior_position_id,
    prior_employee_code, prior_max_weekly_hours
  ) values (
    _user, _company, _reason, nullif(btrim(coalesce(_note, '')), ''), _by,
    coalesce(prof.full_name, ''), m.position, roles,
    m.department_id, m.position_id, m.employee_code, m.max_weekly_hours
  );

  delete from public.user_roles where user_id = _user and company_id = _company;
  if to_regclass('public.supervisor_assignments') is not null then
    execute 'delete from public.supervisor_assignments
              where company_id = $1 and (supervisor_id = $2 or employee_id = $2)'
      using _company, _user;
  end if;

  -- Details stay on the membership row, so a rehire puts them back.
  update public.company_memberships
     set status = _status, status_changed_at = now(), status_changed_by = _by,
         status_reason = coalesce(nullif(btrim(coalesce(_note, '')), ''), _reason::text)
   where id = m.id;
end; $$;

create or replace function public.remove_company_member(
  _user uuid,
  _reason public.separation_reason default 'other',
  _note text default null
)
returns void language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid := public.current_company_id();
  cname text;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _user = caller then raise exception 'You cannot remove yourself from the company.'; end if;
  if cid is null or not (public.has_role(caller, 'company_admin'::public.app_role, cid)
                         or public.has_role(caller, 'super_admin'::public.app_role)) then
    raise exception 'not authorized';
  end if;
  perform public.end_membership(_user, cid, 'revoked', _reason, _note, caller);
  select name into cname from public.companies where id = cid;
  perform public.notify_member(_user, 'membership_revoked', 'Removed from a company',
    'You are no longer a member of ' || cname || '.');
  perform public.log_membership_event(cid, 'membership.revoked', _user, null,
    jsonb_build_object('reason', _reason, 'note', _note));
end; $$;

-- Leave a company yourself, if the company allows it.
create or replace function public.leave_company(_company uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  allowed boolean;
  last_kind text;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.company_memberships
                  where user_id = uid and company_id = _company and status in ('active', 'suspended')) then
    raise exception 'You are not a member of that company.';
  end if;
  select members_can_leave into allowed from public.companies where id = _company;
  if not coalesce(allowed, true) then
    raise exception 'This company does not let members leave on their own. Ask one of its admins.';
  end if;
  if exists (select 1 from public.user_roles r
              where r.user_id = uid and r.company_id = _company and r.role = 'company_admin')
     and public.other_active_admins(_company, uid) = 0
     and exists (select 1 from public.company_memberships m
                  where m.company_id = _company and m.user_id <> uid and m.status = 'active') then
    raise exception 'Make someone else an admin before you leave: the company needs at least one.';
  end if;
  select kind into last_kind from public.time_punches
   where user_id = uid and company_id = _company
   order by at desc, created_at desc, id desc limit 1;
  if last_kind is not null and last_kind <> 'out' then
    raise exception 'Clock out of this company before you leave it.';
  end if;

  perform public.end_membership(uid, _company, 'left', 'other', 'Left the company', uid);
  update public.company_join_requests set status = 'cancelled', decided_at = now(), decided_by = uid
   where user_id = uid and company_id = _company and status = 'pending';
  perform public.log_membership_event(_company, 'membership.left', uid);
end; $$;

-- Rehire someone this company removed (or who left), in the selected company.
create or replace function public.rehire_company_member(_user uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid := public.current_company_id();
  sep public.employment_separations;
  r public.app_role;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if cid is null or not (public.has_role(caller, 'company_admin'::public.app_role, cid)
                         or public.has_role(caller, 'super_admin'::public.app_role)) then
    raise exception 'not authorized';
  end if;
  select * into sep from public.employment_separations
   where user_id = _user and company_id = cid and rehired_at is null
   order by separated_at desc limit 1;
  if sep.id is null then raise exception 'No open separation record for that user.'; end if;
  if public.is_member(_user, cid) then raise exception 'That person already works here.'; end if;

  perform public.seat_check(cid);

  insert into public.company_memberships (
    user_id, company_id, status, department_id, position_id, position, employee_code,
    max_weekly_hours, status_changed_by
  ) values (
    _user, cid, 'active',
    (select d.id from public.departments d where d.id = sep.prior_department_id),
    (select po.id from public.positions po where po.id = sep.prior_position_id),
    sep.prior_position, sep.prior_employee_code, coalesce(sep.prior_max_weekly_hours, 40), caller
  )
  on conflict (user_id, company_id) do update
    set status = 'active', is_active = true, status_changed_at = now(),
        status_changed_by = caller, status_reason = null;

  if array_length(sep.prior_roles, 1) is null then
    perform public.set_company_role(_user, cid, 'employee');
  else
    foreach r in array sep.prior_roles loop
      insert into public.user_roles (user_id, company_id, role)
      values (_user, cid, r) on conflict do nothing;
    end loop;
  end if;

  update public.employment_separations set rehired_at = now(), rehired_by = caller where id = sep.id;
  update public.profiles set company_id = cid where id = _user and company_id is null;
  perform public.log_membership_event(cid, 'membership.rehired', _user);
end; $$;

create or replace function public.forget_former_member(_user uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid := public.current_company_id();
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if cid is null or not (public.has_role(caller, 'company_admin'::public.app_role, cid)
                         or public.has_role(caller, 'super_admin'::public.app_role)) then
    raise exception 'No former employee record here that you can delete.';
  end if;
  if not exists (select 1 from public.employment_separations where user_id = _user and company_id = cid) then
    raise exception 'No former employee record here that you can delete.';
  end if;
  if exists (select 1 from public.company_memberships
              where user_id = _user and company_id = cid and status in ('active', 'suspended')) then
    raise exception 'That person works here right now. Remove them from the company first.';
  end if;

  delete from public.employment_separations where user_id = _user and company_id = cid;
  delete from public.employee_clock_codes where user_id = _user and company_id = cid;
  delete from public.company_memberships
   where user_id = _user and company_id = cid and status in ('revoked', 'left');
  perform public.log_membership_event(cid, 'membership.forgotten', _user);
end; $$;

-- -------------------------------------------------------- company code ----

create or replace function public.regenerate_join_code()
returns text language plpgsql security definer set search_path = public
as $$
declare
  cid uuid := public.current_company_id();
  code text;
begin
  if cid is null or not public.has_role(auth.uid(), 'company_admin'::public.app_role, cid) then
    raise exception 'not authorized';
  end if;
  code := public.generate_company_join_code();
  update public.companies set join_code = code where id = cid;
  perform public.log_membership_event(cid, 'company.join_code_changed', null);
  return code;
end; $$;

create or replace function public.set_membership_policy(_join_code_enabled boolean, _members_can_leave boolean)
returns void language plpgsql security definer set search_path = public
as $$
declare
  cid uuid := public.current_company_id();
begin
  if cid is null or not public.has_role(auth.uid(), 'company_admin'::public.app_role, cid) then
    raise exception 'not authorized';
  end if;
  update public.companies
     set join_code_enabled = coalesce(_join_code_enabled, join_code_enabled),
         members_can_leave = coalesce(_members_can_leave, members_can_leave)
   where id = cid;
  perform public.log_membership_event(cid, 'company.membership_policy_changed', null, null,
    jsonb_build_object('join_code_enabled', _join_code_enabled, 'members_can_leave', _members_can_leave));
end; $$;

-- ------------------------------------------- existing entry points ----

create or replace function public.bootstrap_company(_name text)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  insert into public.companies (name, status, created_by)
  values (_name, 'pending', uid)
  returning id into cid;

  insert into public.profiles (id) values (uid) on conflict (id) do nothing;
  insert into public.company_memberships (user_id, company_id, status_changed_by)
  values (uid, cid, uid);
  insert into public.user_roles (user_id, company_id, role) values (uid, cid, 'company_admin');
  update public.profiles set company_id = cid where id = uid;

  insert into public.company_subscriptions (company_id, plan_id, status)
  values (cid, public.trial_plan_id(), 'trialing');

  return cid;
end; $$;

create or replace function public.accept_invitation(_token uuid)
returns uuid language plpgsql security definer set search_path = public
as $fn$
declare
  uid uuid := auth.uid();
  user_email text := lower(coalesce((auth.jwt() ->> 'email'), ''));
  inv public.invitations%rowtype;
  grant_role public.app_role;
  was_active boolean;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into inv from public.invitations where token = _token for update;
  if not found then raise exception 'invitation not found'; end if;
  if inv.status <> 'pending' then raise exception 'invitation is %', inv.status; end if;
  if inv.expires_at < now() then raise exception 'invitation expired'; end if;
  if lower(inv.email) <> user_email then
    raise exception 'invitation email does not match signed-in user';
  end if;
  grant_role := case when inv.role in ('employee', 'company_admin', 'supervisor') then inv.role
               else 'employee'::public.app_role end;

  was_active := public.is_member(uid, inv.company_id);
  insert into public.profiles (id) values (uid) on conflict (id) do nothing;
  insert into public.company_memberships (user_id, company_id, status_changed_by)
  values (uid, inv.company_id, inv.invited_by)
  on conflict (user_id, company_id) do update
    set status = 'active', status_changed_at = now(), status_changed_by = excluded.status_changed_by,
        status_reason = null;
  -- Already working here: add the role, never take one away.
  if was_active then
    insert into public.user_roles (user_id, company_id, role)
    values (uid, inv.company_id, grant_role) on conflict do nothing;
  else
    perform public.set_company_role(uid, inv.company_id, grant_role);
  end if;

  update public.employment_separations set rehired_at = now(), rehired_by = inv.invited_by
   where user_id = uid and company_id = inv.company_id and rehired_at is null;
  update public.company_join_requests set status = 'approved', decided_at = now(), decided_by = inv.invited_by
   where user_id = uid and company_id = inv.company_id and status = 'pending';

  -- An invitation is followed straight into that company.
  update public.profiles
     set company_id = inv.company_id,
         pending_company_id = case when pending_company_id = inv.company_id then null else pending_company_id end
   where id = uid;

  update public.invitations
     set status = 'accepted', accepted_at = now(), accepted_by = uid
   where id = inv.id;
  perform public.log_membership_event(inv.company_id, 'membership.invitation_accepted', uid, null,
    jsonb_build_object('role', grant_role));

  return inv.company_id;
end;
$fn$;

-- Super admin rescue tool: put someone into a company (as an employee if they
-- had no role there) and select it. Their other memberships are left alone.
create or replace function public.admin_set_user_company(_user uuid, _company uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not public.has_role(auth.uid(), 'super_admin'::app_role) then
    raise exception 'not authorized';
  end if;
  if _company is not null and not exists (select 1 from public.companies where id = _company) then
    raise exception 'no such company';
  end if;

  insert into public.profiles (id) values (_user) on conflict (id) do nothing;
  if _company is not null then
    insert into public.company_memberships (user_id, company_id, status_changed_by)
    values (_user, _company, auth.uid())
    on conflict (user_id, company_id) do update
      set status = 'active', status_changed_at = now(), status_changed_by = auth.uid(), status_reason = null;
    if not exists (select 1 from public.user_roles where user_id = _user and company_id = _company) then
      insert into public.user_roles (user_id, company_id, role) values (_user, _company, 'employee');
    end if;
    update public.company_join_requests set status = 'approved', decided_at = now(), decided_by = auth.uid()
     where user_id = _user and company_id = _company and status = 'pending';
    perform public.log_membership_event(_company, 'membership.added_by_platform', _user);
  end if;
  update public.profiles set company_id = _company, pending_company_id = null where id = _user;
end; $$;

create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = public
as $$
declare
  _me uuid := auth.uid();
begin
  if _me is null then raise exception 'not signed in'; end if;

  if public.has_role(_me, 'super_admin'::app_role)
     and (select count(distinct user_id) from public.user_roles
           where role = 'super_admin'::app_role) <= 1 then
    raise exception 'this is the last platform admin';
  end if;

  -- The last admin of any company that still has other people in it.
  if exists (
    select 1
      from public.user_roles r
      join public.company_memberships m
        on m.user_id = r.user_id and m.company_id = r.company_id and m.status = 'active'
     where r.user_id = _me
       and r.role = 'company_admin'::public.app_role
       and public.other_active_admins(r.company_id, _me) = 0
       and exists (select 1 from public.company_memberships o
                    where o.company_id = r.company_id and o.user_id <> _me and o.status = 'active')
  ) then
    raise exception 'make someone else a company admin before deleting your account';
  end if;

  delete from auth.users where id = _me;
end; $$;

-- =========================================== rewritten functions ====
-- The latest versions of these, changed only where they read the caller's
-- company from profiles, looked people up by profiles.company_id, or looked
-- at someone's punches/locations/codes without saying which company.

-- clock_punch
create or replace function public.clock_punch(_lat double precision, _lng double precision, _accuracy double precision default null)
returns public.time_punches
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  cid uuid;
  c record;
  s jsonb;
  require_geo boolean;
  has_gps boolean := _lat is not null and _lng is not null;
  last_kind text;
  next_kind text;
  dist double precision;
  who text;
  row public.time_punches;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  cid := public.current_company_id();
  if cid is null then raise exception 'you must be a member of a company'; end if;

  select latitude, longitude, geofence_radius_m, settings
    into c
  from public.companies where id = cid;
  s := coalesce(c.settings, '{}'::jsonb);
  require_geo := coalesce((s->>'require_geofence')::boolean, true);

  if has_gps and c.latitude is not null and c.longitude is not null then
    dist := public.haversine_m(c.latitude, c.longitude, _lat, _lng);
    if require_geo and dist > coalesce(c.geofence_radius_m, 200) then
      raise exception 'You are % meters from the worksite (allowed: %m). Move closer to clock in/out.',
        round(dist)::int, c.geofence_radius_m;
    end if;
  else
    dist := null;
  end if;

  select kind into last_kind from public.time_punches
    where user_id = uid and company_id = cid
    order by at desc, created_at desc, id desc
    limit 1;

  -- on the clock unless there is no punch yet, or the last one was 'out'
  next_kind := case
                 when last_kind is null or last_kind = 'out' then 'in'
                 else 'out'
               end;

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, accuracy_m, distance_m, within_geofence)
  values (uid, cid, next_kind, _lat, _lng, _accuracy, dist, has_gps)
  returning * into row;

  -- No location while the company has a geofence: tell the admins.
  if not has_gps and require_geo and c.latitude is not null and c.longitude is not null then
    select coalesce(nullif(trim(full_name), ''), 'An employee') into who
      from public.profiles where id = uid;

    insert into public.notifications (user_id, type, title, body, link)
    select distinct ur.user_id, 'punch_without_gps',
           case when next_kind = 'in' then 'Clock-in without GPS' else 'Clock-out without GPS' end,
           who || ' clocked ' || next_kind || ' with their GPS location turned off.',
           '/timecards'
      from public.user_roles ur
      join public.company_memberships m on m.user_id = ur.user_id and m.company_id = ur.company_id and m.status = 'active'
     where ur.company_id = cid
       and ur.role = 'company_admin'::public.app_role
       and ur.user_id <> uid
       and public.wants_notification(ur.user_id, 'punch_without_gps');
  end if;

  return row;
end;
$function$;

-- break_punch
create or replace function public.break_punch(_lat double precision, _lng double precision, _accuracy double precision default null, _minutes integer default null)
returns public.time_punches
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  cid uuid;
  c record;
  s jsonb;
  require_geo boolean;
  has_gps boolean := _lat is not null and _lng is not null;
  allow10 boolean; allow30 boolean; allow60 boolean;
  last_kind text;
  last_break_minutes int;
  next_kind text;
  dist double precision;
  row public.time_punches;
  bmin int;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  cid := public.current_company_id();
  if cid is null then raise exception 'you must be a member of a company'; end if;

  select latitude, longitude, geofence_radius_m, settings into c from public.companies where id = cid;
  s := coalesce(c.settings, '{}'::jsonb);
  require_geo := coalesce((s->>'require_geofence')::boolean, true);
  allow10 := coalesce((s->>'allow_break_10')::boolean, true);
  allow30 := coalesce((s->>'allow_break_30')::boolean, true);
  allow60 := coalesce((s->>'allow_break_60')::boolean, true);

  if has_gps and c.latitude is not null and c.longitude is not null then
    dist := public.haversine_m(c.latitude, c.longitude, _lat, _lng);
    if require_geo and dist > coalesce(c.geofence_radius_m, 200) then
      raise exception 'You are % meters from the worksite (allowed: %m).',
        round(dist)::int, c.geofence_radius_m;
    end if;
  end if;

  select kind, break_minutes into last_kind, last_break_minutes
    from public.time_punches
    where user_id = uid and company_id = cid
    order by at desc, created_at desc, id desc
    limit 1;

  if last_kind is null or last_kind = 'out' then
    raise exception 'You need to clock in before starting a break.';
  end if;

  next_kind := case when last_kind = 'break_start' then 'break_end' else 'break_start' end;

  if next_kind = 'break_start' then
    if _minutes is null or _minutes not in (10, 30, 60) then
      raise exception 'Pick a break length: 10, 30, or 60 minutes.';
    end if;
    if (_minutes = 10 and not allow10)
       or (_minutes = 30 and not allow30)
       or (_minutes = 60 and not allow60) then
      raise exception 'That break length is disabled by your company''s App rules.';
    end if;
    bmin := _minutes;
  else
    bmin := last_break_minutes;
  end if;

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, accuracy_m, distance_m, within_geofence, break_minutes)
  values (uid, cid, next_kind, _lat, _lng, _accuracy, dist, has_gps, bmin)
  returning * into row;
  return row;
end;
$function$;

-- switch_location
create or replace function public.switch_location(
  _location uuid,
  _lat double precision,
  _lng double precision,
  _accuracy double precision default null
)
returns public.location_moves
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  c record;
  require_geo boolean;
  dist double precision;
  last_kind text;
  row public.location_moves;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if _lat is null or _lng is null then raise exception 'location required'; end if;

  cid := public.current_company_id();
  if cid is null then raise exception 'you must be a member of a company'; end if;

  if not exists (select 1 from public.locations where id = _location and company_id = cid) then
    raise exception 'that location is not in this company';
  end if;
  if exists (select 1 from public.employee_locations where employee_id = uid and company_id = cid)
     and not exists (select 1 from public.employee_locations
                      where employee_id = uid and location_id = _location) then
    raise exception 'you are not set up to work at that location';
  end if;

  -- The same distance rule as clock_punch.
  select latitude, longitude, geofence_radius_m, settings into c
    from public.companies where id = cid;
  require_geo := coalesce((coalesce(c.settings, '{}'::jsonb)->>'require_geofence')::boolean, true);
  if c.latitude is not null and c.longitude is not null then
    dist := public.haversine_m(c.latitude, c.longitude, _lat, _lng);
    if require_geo and dist > coalesce(c.geofence_radius_m, 200) then
      raise exception 'You are % meters from the worksite (allowed: %m). Move closer to clock in/out.',
        round(dist)::int, c.geofence_radius_m;
    end if;
  end if;

  select kind into last_kind from public.time_punches
   where user_id = uid and company_id = cid
   order by at desc, created_at desc, id desc
   limit 1;
  if last_kind is null or last_kind = 'out' then
    raise exception 'Clock in first.';
  end if;
  if last_kind = 'break_start' then
    raise exception 'End your break before changing location.';
  end if;

  if public.current_work_location(uid, cid) is not distinct from _location then
    raise exception 'You are already at that location.';
  end if;

  insert into public.location_moves (company_id, user_id, location_id)
  values (cid, uid, _location)
  returning * into row;
  return row;
end; $$;

-- set_punch_location
create or replace function public.set_punch_location(_punch uuid, _location uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  p public.time_punches;
  manager boolean;
  next_in timestamptz;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into p from public.time_punches where id = _punch;
  if p.id is null then raise exception 'punch not found'; end if;
  if p.kind <> 'in' then raise exception 'pick the clock-in of the stretch to move'; end if;

  manager := public.has_role(uid, 'super_admin')
             or public.has_role(uid, 'company_admin', p.company_id);

  if _location is not null and not exists (
    select 1 from public.locations where id = _location and company_id = p.company_id
  ) then
    raise exception 'that location is not in this company';
  end if;

  if not manager then
    if p.user_id <> uid then raise exception 'you can only change your own time'; end if;
    if _location is null then raise exception 'pick a location'; end if;
    -- Only the stretch they are on now: their latest clock-in, not yet closed.
    if exists (
      select 1 from public.time_punches q
       where q.user_id = uid and q.company_id = p.company_id
         and (q.at, q.created_at, q.id) > (p.at, p.created_at, p.id)
         and q.kind in ('in', 'out')
    ) then
      raise exception 'only a manager can change a finished shift';
    end if;
    if exists (select 1 from public.employee_locations where employee_id = uid and company_id = p.company_id)
       and not exists (select 1 from public.employee_locations
                        where employee_id = uid and location_id = _location) then
      raise exception 'you are not set up to work at that location';
    end if;
  end if;

  select q.at into next_in
    from public.time_punches q
   where q.user_id = p.user_id and q.company_id = p.company_id and q.kind = 'in' and q.at > p.at
   order by q.at
   limit 1;

  update public.time_punches q
     set location_id = _location
   where q.user_id = p.user_id and q.company_id = p.company_id
     and (q.id = p.id
          or (q.kind <> 'in' and q.at >= p.at
              and q.at < coalesce(next_in, p.at + interval '24 hours')));

  -- The whole stretch is at one place now, so any moves made during it go.
  delete from public.location_moves m
   where m.user_id = p.user_id and m.company_id = p.company_id
     and m.at >= p.at
     and m.at < coalesce(next_in, p.at + interval '24 hours');
end; $$;

-- set_punch_location_on_insert
create or replace function public.set_punch_location_on_insert()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.location_id is not null then return new; end if;
  if new.kind = 'in' then
    new.location_id := public.resolve_punch_location(
      new.user_id, new.company_id, new.at, new.latitude, new.longitude);
  else
    new.location_id := public.stretch_location(new.user_id, new.at, new.company_id);
  end if;
  return new;
end; $$;

-- enforce_break_length
create or replace function public.enforce_break_length()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  ends_at timestamptz;
begin
  -- Ending a break, or clocking out while on one, both close it.
  if new.kind not in ('break_end', 'out') then return new; end if;

  -- Operators on the database directly (no request JWT) and the service role.
  if auth.jwt() is null or auth.jwt()->>'role' = 'service_role' then return new; end if;

  -- An admin may end anyone's break early, their own included. kiosk_punch
  -- checks for itself, since the tablet may be signed in as an admin.
  if auth.uid() is not null and public.is_company_manager(auth.uid(), new.company_id) then
    return new;
  end if;

  ends_at := public.break_locked_until(new.user_id, new.company_id);
  if ends_at is null then return new; end if;

  raise exception 'Your break isn''t over yet — % min left. Only an admin can end it early.',
    greatest(1, ceil(extract(epoch from ends_at - now()) / 60))::int;
end; $$;

-- kiosk_state
create or replace function public.kiosk_state(_token text, _code text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
  last_kind text;
  s jsonb;
  uid uuid;
  cid uuid;
  locked timestamptz;
begin
  r := public.kiosk_resolve(_token, _code);
  if not (r->>'ok')::boolean then return r; end if;
  uid := (r->>'user_id')::uuid;
  cid := (r->>'company_id')::uuid;

  select kind into last_kind from public.time_punches
   where user_id = uid and company_id = cid
   order by at desc, created_at desc, id desc
   limit 1;

  select coalesce(settings, '{}'::jsonb) into s from public.companies where id = cid;

  if not public.is_company_manager(uid, cid) then
    locked := public.break_locked_until(uid, cid);
  end if;

  return jsonb_build_object(
    'ok', true,
    'name', r->>'name',
    'state', case
               when last_kind is null or last_kind = 'out' then 'out'
               when last_kind = 'break_start' then 'on_break'
               else 'in'
             end,
    'break_ends_at', locked,
    'breaks', jsonb_build_object(
      '10', coalesce((s->>'allow_break_10')::boolean, true),
      '30', coalesce((s->>'allow_break_30')::boolean, true),
      '60', coalesce((s->>'allow_break_60')::boolean, true)
    )
  );
end; $$;

-- kiosk_punch
create or replace function public.kiosk_punch(_token text, _code text, _action text, _minutes integer default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
  uid uuid;
  cid uuid;
  c record;
  s jsonb;
  last_kind text;
  last_break_minutes int;
  next_kind text;
  bmin int;
  locked timestamptz;
  row public.time_punches;
begin
  r := public.kiosk_resolve(_token, _code);
  if not (r->>'ok')::boolean then return r; end if;
  uid := (r->>'user_id')::uuid;
  cid := (r->>'company_id')::uuid;

  select latitude, longitude, coalesce(settings, '{}'::jsonb) as settings into c
    from public.companies where id = cid;
  s := c.settings;

  select kind, break_minutes into last_kind, last_break_minutes
    from public.time_punches
   where user_id = uid and company_id = cid
   order by at desc, created_at desc, id desc
   limit 1;

  if last_kind = 'break_start' and not public.is_company_manager(uid, cid) then
    locked := public.break_locked_until(uid, cid);
    if locked is not null then
      return jsonb_build_object('ok', false, 'message',
        format('Your break isn''t over yet — %s min left. Only an admin can end it early.',
               greatest(1, ceil(extract(epoch from locked - now()) / 60))::int));
    end if;
  end if;

  if _action = 'clock' then
    next_kind := case when last_kind is null or last_kind = 'out' then 'in' else 'out' end;
    bmin := null;
  elsif _action = 'break' then
    if last_kind is null or last_kind = 'out' then
      return jsonb_build_object('ok', false, 'message', 'Clock in before starting a break.');
    end if;
    next_kind := case when last_kind = 'break_start' then 'break_end' else 'break_start' end;
    if next_kind = 'break_start' then
      if _minutes is null or _minutes not in (10, 30, 60) then
        return jsonb_build_object('ok', false, 'message', 'Pick a break length: 10, 30 or 60 minutes.');
      end if;
      if (_minutes = 10 and not coalesce((s->>'allow_break_10')::boolean, true))
         or (_minutes = 30 and not coalesce((s->>'allow_break_30')::boolean, true))
         or (_minutes = 60 and not coalesce((s->>'allow_break_60')::boolean, true)) then
        return jsonb_build_object('ok', false, 'message', 'That break length is turned off in your App rules.');
      end if;
      bmin := _minutes;
    else
      bmin := last_break_minutes;
    end if;
  else
    return jsonb_build_object('ok', false, 'message', 'Unknown action.');
  end if;

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, distance_m, within_geofence, break_minutes)
  values (uid, cid, next_kind, c.latitude, c.longitude,
          case when c.latitude is not null then 0 else null end, true, bmin)
  returning * into row;

  return jsonb_build_object('ok', true, 'name', r->>'name', 'kind', row.kind, 'at', row.at);
end; $$;

-- kiosk_resolve
create or replace function public.kiosk_resolve(_token text, _code text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  d record;
  p record;
begin
  select * into d from public.kiosk_devices where token = _token and revoked_at is null;
  if d.id is null then
    return jsonb_build_object('ok', false, 'message', 'This device link is no longer valid. Ask an admin for a new one.');
  end if;
  if d.locked_until is not null and d.locked_until > now() then
    return jsonb_build_object('ok', false, 'message', 'Too many wrong codes. Try again in a minute.');
  end if;
  if _code is null or _code !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'message', 'Enter your 4-digit code.');
  end if;

  select c.user_id as uid, pr.full_name as name into p
  from public.employee_clock_codes c
  join public.profiles pr on pr.id = c.user_id
  join public.company_memberships m on m.user_id = c.user_id and m.company_id = c.company_id and m.status = 'active'
  where c.company_id = d.company_id and c.code = _code;

  if p.uid is null then
    update public.kiosk_devices
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5 then now() + interval '1 minute' else locked_until end
     where id = d.id;
    return jsonb_build_object('ok', false, 'message', 'That code was not recognised.');
  end if;

  update public.kiosk_devices
     set failed_attempts = 0, locked_until = null, last_used_at = now()
   where id = d.id;

  return jsonb_build_object('ok', true, 'company_id', d.company_id, 'user_id', p.uid, 'name', p.name);
end; $$;

-- create_kiosk_device
create or replace function public.create_kiosk_device(_label text default 'Shared clock-in')
returns public.kiosk_devices
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  row public.kiosk_devices;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  cid := public.current_company_id();
  if cid is null then raise exception 'you must be a member of a company'; end if;
  if not public.has_role(uid, 'company_admin'::public.app_role, cid) then
    raise exception 'only a company admin can set up a shared clock-in device';
  end if;

  insert into public.kiosk_devices (company_id, label, token, created_by)
  values (
    cid,
    coalesce(nullif(trim(_label), ''), 'Shared clock-in'),
    -- 64 hex characters from two v4 UUIDs, so this needs no pgcrypto.
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
    uid
  )
  returning * into row;
  return row;
end; $$;

-- set_company_location
create or replace function public.set_company_location(_lat double precision, _lng double precision, _radius integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  cid := public.current_company_id();
  if cid is null then raise exception 'no company'; end if;
  if not (public.has_role(uid, 'company_admin'::app_role, cid)
          or public.has_role(uid, 'super_admin'::app_role)) then
    raise exception 'not authorized';
  end if;
  if _radius is null or _radius < 25 or _radius > 5000 then
    raise exception 'radius must be between 25 and 5000 meters';
  end if;
  update public.companies
    set latitude = _lat, longitude = _lng, geofence_radius_m = _radius
    where id = cid;
end;
$$;

-- set_employee_clock_code
create or replace function public.set_employee_clock_code(_user uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  candidate text;
  tries int := 0;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  cid := public.member_company(_user);
  if cid is null then raise exception 'that person is not in a company'; end if;
  if not public.has_role(uid, 'company_admin'::public.app_role, cid) then
    raise exception 'only a company admin can issue clock-in codes';
  end if;

  loop
    tries := tries + 1;
    candidate := lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (
      select 1 from public.employee_clock_codes
       where company_id = cid and code = candidate and user_id <> _user
    );
    if tries > 200 then raise exception 'could not find a free code - clear some old ones first'; end if;
  end loop;

  insert into public.employee_clock_codes (user_id, company_id, code)
  values (_user, cid, candidate)
  on conflict (user_id, company_id) do update
    set code = excluded.code, updated_at = now();

  return candidate;
end; $$;

-- clear_employee_clock_code
create or replace function public.clear_employee_clock_code(_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  delete from public.employee_clock_codes c
   where c.user_id = _user
     and public.has_role(uid, 'company_admin'::public.app_role, c.company_id);
end; $$;

-- revoke_kiosk_device
create or replace function public.revoke_kiosk_device(_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  update public.kiosk_devices d
     set revoked_at = now()
   where d.id = _id
     and public.has_role(uid, 'company_admin'::public.app_role, d.company_id);
  if not found then raise exception 'device not found'; end if;
end; $$;

-- dismiss_break_reminder
create or replace function public.dismiss_break_reminder(
  _user uuid,
  _kind text,
  _stretch_start timestamptz
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid;
begin
  if _kind not in ('break', 'lunch') then raise exception 'invalid reminder kind'; end if;

  cid := public.member_company(_user);
  if cid is null then raise exception 'employee has no company'; end if;
  if not public.is_company_manager(caller, cid) then raise exception 'not authorized'; end if;

  insert into public.break_reminder_dismissals (company_id, user_id, kind, stretch_start, dismissed_by, dismissed_at)
  values (cid, _user, _kind, _stretch_start, caller, now())
  on conflict (user_id, company_id, kind) do update
    set stretch_start = excluded.stretch_start,
        dismissed_by = excluded.dismissed_by,
        dismissed_at = excluded.dismissed_at,
        company_id = excluded.company_id;
end;
$$;

-- generate_schedule
create or replace function public.generate_schedule(
  _name text,
  _starts_on date,
  _ends_on date,
  _rules jsonb,
  _employee_ids uuid[] default null::uuid[],
  _respect_availability boolean default true,
  _allow_overtime boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  caller     uuid := auth.uid();
  cid        uuid;
  tz         text;
  s          jsonb;
  week_start_day int;
  sched_id   uuid;
  sched_dept uuid;
  sched_loc  uuid;
  d          date;
  rule       jsonb;
  tpl        record;
  headcount  int;
  i          int;
  slot_start timestamptz;
  slot_end   timestamptz;
  slot_hours numeric;
  local_end_time time;
  wk         date;
  chosen     uuid;
  created    int := 0;
  assigned   int := 0;
  open_cnt   int := 0;
  dow        int;
  skipped    text[] := '{}';
begin
  if caller is null then raise exception 'not authenticated'; end if;

  cid := public.current_company_id();
  if cid is null then raise exception 'you must belong to a company'; end if;

  if not public.is_company_manager(caller, cid) then
    raise exception 'only company admins can generate schedules';
  end if;

  if _starts_on is null or _ends_on is null then raise exception 'pick a date range'; end if;
  if _ends_on < _starts_on then raise exception 'the end date must be on or after the start date'; end if;
  if _ends_on - _starts_on > 366 then raise exception 'a schedule cannot span more than 366 days'; end if;
  if _rules is null or jsonb_array_length(_rules) = 0 then
    raise exception 'pick at least one shift template';
  end if;

  select c.timezone, c.settings into tz, s from public.companies c where c.id = cid;
  tz := coalesce(tz, 'UTC');
  week_start_day := coalesce((s->>'week_start_day')::int, 0);

  create temp table _rules_ok on commit drop as
  select r.value as rule, t.id as template_id, t.department_id, t.location_id
  from jsonb_array_elements(_rules) r
  join public.shift_templates t
    on t.id = (r.value->>'template_id')::uuid and t.company_id = cid;

  if not exists (select 1 from _rules_ok) then
    raise exception 'none of the selected templates belong to your company';
  end if;

  select case when count(distinct department_id) = 1 then (array_agg(distinct department_id))[1] end,
         case when count(distinct location_id)   = 1 then (array_agg(distinct location_id))[1]   end
    into sched_dept, sched_loc
  from _rules_ok;

  insert into public.schedules (company_id, name, starts_on, ends_on, created_by, status, department_id, location_id)
  values (cid, coalesce(nullif(trim(_name), ''), 'Generated schedule'),
          _starts_on, _ends_on, caller, 'draft', sched_dept, sched_loc)
  returning id into sched_id;

  create temp table _pool on commit drop as
    select p.id, p.full_name, m.max_weekly_hours
    from public.company_memberships m
    join public.profiles p on p.id = m.user_id
    where m.company_id = cid
      and m.status = 'active'
      and m.is_active
      and (_employee_ids is null or p.id = any(_employee_ids));

  create temp table _load (
    employee_id uuid,
    week_start  date,
    hours       numeric,
    primary key (employee_id, week_start)
  ) on commit drop;

  insert into _load (employee_id, week_start, hours)
  select sh.employee_id,
         (sh.starts_at at time zone tz)::date
           - (((extract(dow from (sh.starts_at at time zone tz))::int - week_start_day) + 7) % 7),
         sum(extract(epoch from (sh.ends_at - sh.starts_at)) / 3600.0)
  from public.shifts sh
  where sh.company_id = cid
    and sh.employee_id is not null
    and sh.starts_at >= (_starts_on - 7)::timestamptz
  group by 1, 2;

  d := _starts_on;
  while d <= _ends_on loop
    dow := extract(dow from d)::int;

    for rule in select x.rule from _rules_ok x loop
      continue when not (coalesce(rule->'weekdays', '[]'::jsonb) @> to_jsonb(dow));

      select t.id, t.name, t.start_time, t.end_time, t.break_minutes, t.required_headcount,
             t.color, t.position_id, t.department_id, t.location_id
        into tpl
      from public.shift_templates t
      where t.id = (rule->>'template_id')::uuid and t.company_id = cid;
      continue when not found;

      headcount := greatest(1, coalesce((rule->>'headcount')::int, tpl.required_headcount, 1));

      slot_start := (d + tpl.start_time) at time zone tz;
      if tpl.end_time > tpl.start_time then
        slot_end       := (d + tpl.end_time) at time zone tz;
        local_end_time := tpl.end_time;
      else
        slot_end       := ((d + 1) + tpl.end_time) at time zone tz;
        local_end_time := time '23:59:59';
      end if;
      slot_hours := extract(epoch from (slot_end - slot_start)) / 3600.0;
      wk := d - (((dow - week_start_day) + 7) % 7);

      for i in 1..headcount loop
        chosen := null;

        select cand.id into chosen
        from _pool cand
        where
          not exists (
            select 1 from public.shifts x
            where x.employee_id = cand.id and x.company_id = cid
              and x.starts_at < slot_end
              and x.ends_at   > slot_start
          )
          and not exists (
            select 1 from public.time_off_requests t
            where t.employee_id = cand.id and t.company_id = cid
              and t.status = 'approved'
              and t.start_date <= d
              and t.end_date   >= d
          )
          and (
            not _respect_availability
            or not exists (select 1 from public.employee_availability a where a.employee_id = cand.id and a.company_id = cid)
            or (
              exists (
                select 1 from public.employee_availability a
                where a.employee_id = cand.id and a.company_id = cid
                  and a.is_available
                  and a.weekday = dow
                  and a.start_time <= tpl.start_time
                  and a.end_time   >= local_end_time
                  and (a.effective_from is null or a.effective_from <= d)
                  and (a.effective_to   is null or a.effective_to   >= d)
              )
              and not exists (
                select 1 from public.employee_availability a
                where a.employee_id = cand.id and a.company_id = cid
                  and a.is_available = false
                  and a.weekday = dow
                  and a.start_time < local_end_time
                  and a.end_time   > tpl.start_time
                  and (a.effective_from is null or a.effective_from <= d)
                  and (a.effective_to   is null or a.effective_to   >= d)
              )
            )
          )
          and (
            _allow_overtime
            or coalesce((select l.hours from _load l
                          where l.employee_id = cand.id and l.week_start = wk), 0) + slot_hours
               <= cand.max_weekly_hours
          )
        order by
          case
            when tpl.position_id is null then 0
            when exists (select 1 from public.employee_positions ep
                          where ep.employee_id = cand.id and ep.position_id = tpl.position_id) then 0
            else 1
          end,
          coalesce((select l.hours from _load l
                     where l.employee_id = cand.id and l.week_start = wk), 0),
          cand.full_name
        limit 1;

        insert into public.shifts (
          company_id, employee_id, schedule_id, template_id,
          department_id, location_id, position_id,
          starts_at, ends_at, break_minutes, position, color, published
        ) values (
          cid, chosen, sched_id, tpl.id,
          tpl.department_id, tpl.location_id, tpl.position_id,
          slot_start, slot_end, tpl.break_minutes,
          coalesce((select po.name from public.positions po where po.id = tpl.position_id), tpl.name),
          tpl.color, false
        );

        created := created + 1;

        if chosen is null then
          open_cnt := open_cnt + 1;
        else
          assigned := assigned + 1;
          insert into _load (employee_id, week_start, hours)
          values (chosen, wk, slot_hours)
          on conflict (employee_id, week_start)
          do update set hours = _load.hours + excluded.hours;
        end if;
      end loop;
    end loop;

    d := d + 1;
  end loop;

  return jsonb_build_object(
    'schedule_id',       sched_id,
    'shifts_created',    created,
    'assigned',          assigned,
    'open',              open_cnt,
    'skipped_templates', to_jsonb(skipped)
  );
end;
$fn$;

-- check_shift_conflicts
create or replace function public.check_shift_conflicts(
  _employee_id uuid,
  _starts_at   timestamptz,
  _ends_at     timestamptz,
  _position_id uuid default null,
  _shift_id    uuid default null   -- exclude this shift when editing
)
returns table (code text, severity text, message text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  caller       uuid := auth.uid();
  emp          record;
  co           record;
  tz           text;
  s            jsonb;
  local_start  timestamp;
  local_end    timestamp;
  dow          int;
  week_start_day int;
  wk_start     date;
  wk_end       date;
  existing_h   numeric := 0;
  new_h        numeric;
  total_h      numeric;
  ot_threshold numeric;
  has_avail    boolean;
begin
  if caller is null then raise exception 'not authenticated'; end if;

  -- Open (unassigned) shift: nothing employee-specific to validate.
  if _employee_id is null then return; end if;

  if _ends_at <= _starts_at then
    return query select 'invalid_range'::text, 'error'::text,
                        'Shift end must be after its start.'::text;
    return;
  end if;

  select p.id, m.company_id, m.is_active, m.max_weekly_hours, p.full_name
    into emp
  from public.profiles p
  join public.company_memberships m
    on m.user_id = p.id and m.status = 'active'
   and m.company_id = public.current_company_id()
  where p.id = _employee_id;

  if not found then
    return query select 'employee_not_found'::text, 'error'::text, 'Employee not found.'::text;
    return;
  end if;

  -- Caller must be inside the employee's company (or platform admin).
  if not (public.has_role(caller, 'super_admin')
          or emp.company_id = public.current_company_id()) then
    raise exception 'not authorized';
  end if;

  if emp.company_id is null then
    return query select 'employee_no_company'::text, 'error'::text,
                        'Employee does not belong to a company.'::text;
    return;
  end if;

  if not emp.is_active then
    return query select 'employee_inactive'::text, 'error'::text,
                        emp.full_name || ' is not an active employee.'::text;
  end if;

  select c.timezone, c.settings into co from public.companies c where c.id = emp.company_id;
  tz := coalesce(co.timezone, 'UTC');
  s  := coalesce(co.settings, '{}'::jsonb);
  ot_threshold   := coalesce((s->>'overtime_threshold_hours')::numeric, 40);
  week_start_day := coalesce((s->>'week_start_day')::int, 0);

  local_start := _starts_at at time zone tz;
  local_end   := _ends_at   at time zone tz;
  dow         := extract(dow from local_start)::int;
  new_h       := extract(epoch from (_ends_at - _starts_at)) / 3600.0;

  -- 1. Double booking.
  if exists (
    select 1 from public.shifts sh
    where sh.employee_id = _employee_id and sh.company_id = emp.company_id
      and (_shift_id is null or sh.id <> _shift_id)
      and sh.starts_at < _ends_at
      and sh.ends_at   > _starts_at
  ) then
    return query select 'double_booked'::text, 'error'::text,
                        emp.full_name || ' already has a shift overlapping this time.'::text;
  end if;

  -- 2. Approved time off covering any part of the shift.
  if exists (
    select 1 from public.time_off_requests t
    where t.employee_id = _employee_id and t.company_id = emp.company_id
      and t.status = 'approved'
      and t.start_date <= local_end::date
      and t.end_date   >= local_start::date
  ) then
    return query select 'on_approved_time_off'::text, 'error'::text,
                        emp.full_name || ' has approved time off covering this shift.'::text;
  end if;

  -- 3. Availability. Only meaningful once the employee has declared some.
  select exists (select 1 from public.employee_availability a where a.employee_id = _employee_id and a.company_id = emp.company_id)
    into has_avail;

  if has_avail then
    if local_end::date > local_start::date then
      return query select 'crosses_midnight'::text, 'warning'::text,
                          'Shift crosses midnight; availability could not be verified automatically.'::text;
    else
      if exists (
        select 1 from public.employee_availability a
        where a.employee_id = _employee_id and a.company_id = emp.company_id
          and a.is_available = false
          and a.weekday = dow
          and a.start_time < local_end::time
          and a.end_time   > local_start::time
          and (a.effective_from is null or a.effective_from <= local_start::date)
          and (a.effective_to   is null or a.effective_to   >= local_start::date)
      ) then
        return query select 'blackout'::text, 'warning'::text,
                            emp.full_name || ' marked this time as unavailable.'::text;
      elsif not exists (
        select 1 from public.employee_availability a
        where a.employee_id = _employee_id and a.company_id = emp.company_id
          and a.is_available = true
          and a.weekday = dow
          and a.start_time <= local_start::time
          and a.end_time   >= local_end::time
          and (a.effective_from is null or a.effective_from <= local_start::date)
          and (a.effective_to   is null or a.effective_to   >= local_start::date)
      ) then
        return query select 'outside_availability'::text, 'warning'::text,
                            'Shift falls outside ' || emp.full_name || '''s stated availability.';
      end if;
    end if;
  end if;

  -- 4. Position qualification.
  if _position_id is not null and not exists (
    select 1 from public.employee_positions ep
    where ep.employee_id = _employee_id and ep.position_id = _position_id
  ) then
    return query select 'not_qualified'::text, 'warning'::text,
                        emp.full_name || ' is not marked qualified for this position.'::text;
  end if;

  -- 5. Weekly hours / overtime, using the company's configured week start.
  wk_start := (local_start::date - (((dow - week_start_day) + 7) % 7));
  wk_end   := wk_start + 7;

  select coalesce(sum(extract(epoch from (sh.ends_at - sh.starts_at)) / 3600.0), 0)
    into existing_h
  from public.shifts sh
  where sh.employee_id = _employee_id and sh.company_id = emp.company_id
    and (_shift_id is null or sh.id <> _shift_id)
    and (sh.starts_at at time zone tz)::date >= wk_start
    and (sh.starts_at at time zone tz)::date <  wk_end;

  total_h := existing_h + new_h;

  if total_h > emp.max_weekly_hours then
    return query select 'exceeds_max_weekly_hours'::text, 'warning'::text,
                        'This puts ' || emp.full_name || ' at ' || round(total_h, 1)
                        || 'h against a ' || round(emp.max_weekly_hours, 1) || 'h weekly max.';
  elsif total_h > ot_threshold then
    return query select 'overtime_risk'::text, 'warning'::text,
                        'This puts ' || emp.full_name || ' at ' || round(total_h, 1)
                        || 'h, over the ' || round(ot_threshold, 1) || 'h overtime threshold.';
  end if;

  return;
end;
$$;

-- check_trade_conflicts
create or replace function public.check_trade_conflicts(
  _shift_id uuid,
  _to_employee_id uuid
)
returns table (code text, severity text, message text)
language plpgsql stable security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  sh     record;
  toemp  record;
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select s.id, s.company_id, s.starts_at, s.ends_at, s.position_id, s.employee_id
    into sh from public.shifts s where s.id = _shift_id;
  if not found then
    return query select 'shift_not_found'::text, 'error'::text, 'Shift not found.'::text;
    return;
  end if;

  if not (public.has_role(caller, 'super_admin')
          or sh.company_id = public.current_company_id()) then
    raise exception 'not authorized';
  end if;

  select p.id, m.company_id, m.is_active, p.full_name
    into toemp from public.profiles p
    join public.company_memberships m on m.user_id = p.id and m.company_id = sh.company_id and m.status = 'active'
   where p.id = _to_employee_id;
  if not found then
    return query select 'employee_not_found'::text, 'error'::text, 'Receiving employee not found.'::text;
    return;
  end if;

  if toemp.company_id is distinct from sh.company_id then
    return query select 'cross_company_trade'::text, 'error'::text,
                        'Both employees must belong to the same company.'::text;
    return;
  end if;

  -- Everything else (active, double-booking, time off, availability,
  -- qualification, weekly hours) is the same battery the scheduler runs.
  return query
    select c.code, c.severity, c.message
    from public.check_shift_conflicts(_to_employee_id, sh.starts_at, sh.ends_at, sh.position_id, sh.id) c;
end;
$$;

-- approve_trade
create or replace function public.approve_trade(_trade uuid, _approve boolean)
returns public.shift_trades
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  t public.shift_trades;
  from_shift public.shifts;
  to_shift public.shifts;
  blocker text;
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select * into t from public.shift_trades where id = _trade for update;
  if not found then raise exception 'trade not found'; end if;
  if not public.is_company_manager(caller, t.company_id) then raise exception 'not authorized'; end if;
  if t.status <> 'pending_supervisor' then
    raise exception 'this trade is not waiting for a manager';
  end if;

  perform public.require_capability(t.company_id, 'shift_trades', 'Shift trades');

  if not _approve then
    update public.shift_trades set status = 'denied' where id = _trade returning * into t;
    return t;
  end if;

  select * into from_shift from public.shifts where id = t.shift_id for update;
  if not found then raise exception 'the shift being traded no longer exists'; end if;

  -- The roster can move between proposing and approving, so confirm the shift
  -- is still the proposer's rather than trusting what was true last week.
  if from_shift.employee_id is distinct from t.from_employee_id then
    raise exception 'that shift is no longer assigned to the employee who offered it';
  end if;

  if t.to_shift_id is not null then
    select * into to_shift from public.shifts where id = t.to_shift_id for update;
    if not found then raise exception 'the shift offered in return no longer exists'; end if;
    if to_shift.employee_id is distinct from t.to_employee_id then
      raise exception 'the shift offered in return is no longer assigned to that employee';
    end if;
  end if;

  if not public.is_member(t.to_employee_id, t.company_id) then
    raise exception 'Cannot approve: both employees must belong to the same company.';
  end if;

  -- Swap first, then validate the result.
  update public.shifts set employee_id = t.to_employee_id where id = t.shift_id;
  if t.to_shift_id is not null then
    update public.shifts set employee_id = t.from_employee_id where id = t.to_shift_id;
  end if;

  -- Refuse anything the scheduler itself would refuse. Warnings are advisory
  -- and pass; only a hard error blocks the swap (and undoes the updates above).
  select c.message into blocker
    from public.check_shift_conflicts(t.to_employee_id, from_shift.starts_at, from_shift.ends_at,
                                      from_shift.position_id, from_shift.id) c
   where c.severity = 'error'
   limit 1;
  if blocker is not null then
    raise exception 'Cannot approve: %', blocker;
  end if;

  if t.to_shift_id is not null then
    select c.message into blocker
      from public.check_shift_conflicts(t.from_employee_id, to_shift.starts_at, to_shift.ends_at,
                                        to_shift.position_id, to_shift.id) c
     where c.severity = 'error'
     limit 1;
    if blocker is not null then
      raise exception 'Cannot approve: %', blocker;
    end if;
  end if;

  update public.shift_trades set status = 'approved' where id = _trade returning * into t;

  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, after)
  values (t.company_id, caller, 'shift_trade.approved', 'shift_trade', t.id,
          jsonb_build_object('shift_id', t.shift_id, 'to_shift_id', t.to_shift_id,
                             'from_employee', t.from_employee_id, 'to_employee', t.to_employee_id));

  return t;
end;
$$;

-- validate_shift_tenancy
create or replace function public.validate_shift_tenancy()
returns trigger language plpgsql
security definer
set search_path = public
as $$
begin
  if new.employee_id is not null
     and not public.is_member(new.employee_id, new.company_id) then
    raise exception 'employee does not belong to this company';
  end if;
  if new.department_id is not null
     and not exists (select 1 from public.departments d
                      where d.id = new.department_id and d.company_id = new.company_id) then
    raise exception 'department belongs to a different company';
  end if;
  if new.location_id is not null
     and not exists (select 1 from public.locations l
                      where l.id = new.location_id and l.company_id = new.company_id) then
    raise exception 'location belongs to a different company';
  end if;
  if new.position_id is not null
     and not exists (select 1 from public.positions po
                      where po.id = new.position_id and po.company_id = new.company_id) then
    raise exception 'position belongs to a different company';
  end if;
  if new.schedule_id is not null
     and not exists (select 1 from public.schedules sc
                      where sc.id = new.schedule_id and sc.company_id = new.company_id) then
    raise exception 'schedule belongs to a different company';
  end if;
  return new;
end;
$$;

-- company_messages_after_post
create or replace function public.company_messages_after_post()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  who text;
begin
  -- Housekeeping on the way past: nobody can read these any more anyway.
  delete from public.company_messages
   where company_id = new.company_id
     and created_at < now() - interval '24 hours';

  if new.is_announcement then
    select nullif(p.full_name, '') into who from public.profiles p where p.id = new.author_id;

    insert into public.notifications (user_id, type, title, body, link)
    select p.id,
           'announcement',
           'Announcement from ' || coalesce(who, 'your admin'),
           left(new.body, 140) || case when char_length(new.body) > 140 then '…' else '' end,
           '/messages'
      from public.profiles p
      join public.company_memberships cm on cm.user_id = p.id and cm.company_id = new.company_id and cm.status = 'active'
     where p.id <> new.author_id
       and public.wants_notification(p.id, 'announcement');
  end if;

  return null;
end;
$$;

-- notify_company_status_change
create or replace function public.notify_company_status_change()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  title text;
  body  text;
begin
  if NEW.status is distinct from OLD.status then
    if NEW.status = 'active' and OLD.status in ('pending', 'rejected') then
      title := 'Company approved';
      body  := NEW.name || ' has been approved by the platform admin. You now have full access.';
    elsif NEW.status = 'rejected' then
      title := 'Registration not approved';
      body  := NEW.name || ' was not approved'
               || coalesce(': ' || nullif(trim(NEW.review_note), ''), '.')
               || ' Reply to support if you think this is a mistake.';
    elsif NEW.status = 'suspended' then
      title := 'Company suspended';
      body  := NEW.name || ' has been suspended. Please contact support.';
    elsif NEW.status = 'past_due' then
      title := 'Account past due';
      body  := NEW.name || ' is past due. Update billing to restore access.';
    elsif NEW.status = 'active' then
      title := 'Account reactivated';
      body  := NEW.name || ' is active again.';
    else
      return NEW;
    end if;

    insert into public.notifications (user_id, type, title, body, link)
    select p.id, 'company_status_' || NEW.status, title, body, '/dashboard'
      from public.profiles p
      join public.company_memberships cm on cm.user_id = p.id and cm.company_id = NEW.id and cm.status = 'active';
  end if;
  return NEW;
end; $$;

-- notify_schedule_published
create or replace function public.notify_schedule_published()
returns trigger language plpgsql security definer set search_path = public
as $$
declare notified int;
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    insert into public.notifications (user_id, type, title, body, link)
    select distinct sh.employee_id, 'schedule_published', 'New schedule published',
           'The schedule "' || new.name || '" has been published.', '/today'
    from public.shifts sh
    where sh.schedule_id = new.id and sh.employee_id is not null;

    get diagnostics notified = row_count;

    if notified = 0 then
      insert into public.notifications (user_id, type, title, body, link)
      select p.id, 'schedule_published', 'New schedule published',
             'The schedule "' || new.name || '" has been published.', '/today'
      from public.profiles p
      join public.company_memberships cm on cm.user_id = p.id and cm.company_id = new.company_id and cm.status = 'active';
    end if;
  end if;
  return new;
end;
$$;

-- push_for_message
create or replace function public.push_for_message()
returns trigger language plpgsql security definer set search_path = public
as $fn$
declare
  who text;
  preview text;
  member record;
begin
  if new.is_announcement then
    return null;
  end if;

  select nullif(full_name, '') into who from public.profiles where id = new.author_id;
  preview := left(new.body, 140) || case when char_length(new.body) > 140 then '…' else '' end;

  for member in
    select user_id as id from public.company_memberships
     where company_id = new.company_id and status = 'active' and user_id <> new.author_id
  loop
    perform public.enqueue_push(
      member.id, 'board_message',
      coalesce(who, 'New message'),
      preview, '/messages', 'msg-' || new.id::text, now()
    );
  end loop;

  return null;
end;
$fn$;

-- billing_overview
create or replace function public.billing_overview()
returns table (
  company_id uuid,
  company_name text,
  company_status text,
  sub_status text,
  plan_name text,
  amount_cents int,
  period_end timestamptz,
  days_until int,
  overdue boolean,
  admin_email text
)
language sql stable security definer set search_path = public
as $$
  select
    c.id,
    c.name,
    c.status,
    coalesce(cs.status, 'none'),
    coalesce(pp.name, '—'),
    coalesce(pp.price_cents, 0),
    cs.current_period_end,
    case when cs.current_period_end is null then null
         else floor(extract(epoch from (cs.current_period_end - now())) / 86400)::int end,
    cs.current_period_end is not null
      and cs.current_period_end <= now()
      and c.status <> 'suspended',
    (select u.email::text
       from public.profiles p
       join auth.users u on u.id = p.id
       join public.company_memberships cm on cm.user_id = p.id and cm.company_id = c.id and cm.status = 'active'
      where true
        and public.has_role(p.id, 'company_admin'::app_role, c.id)
      order by p.created_at
      limit 1)
  from public.companies c
  left join public.company_subscriptions cs on cs.company_id = c.id
  left join public.pricing_plans pp on pp.id = cs.plan_id
  where public.has_role(auth.uid(), 'super_admin'::app_role)
  order by cs.current_period_end nulls last;
$$;

-- admin_companies
create or replace function public.admin_companies()
returns table (
  id                      uuid,
  name                    text,
  status                  text,
  plan                    text,
  billing_mode            text,
  join_code               text,
  created_at              timestamptz,
  timezone                text,
  data_retention_months   integer,
  business_phone          text,
  business_address        text,
  created_by              uuid,
  creator_name            text,
  creator_email           text,
  creator_email_confirmed boolean,
  creator_phone           text,
  creator_last_sign_in_at timestamptz,
  reviewed_at             timestamptz,
  reviewed_by_name        text,
  review_note             text,
  member_count            integer,
  admin_count             integer,
  inactive_count          integer,
  pending_join_count      integer,
  sub_status              text,
  plan_name               text,
  period_end              timestamptz,
  last_punch_at           timestamptz
)
language sql stable security definer set search_path = public
as $$
  select
    c.id,
    c.name::text,
    c.status::text,
    c.plan::text,
    c.billing_mode::text,
    c.join_code::text,
    c.created_at,
    c.timezone::text,
    c.data_retention_months::integer,
    nullif(c.settings ->> 'business_phone', ''),
    nullif(c.settings ->> 'business_address', ''),
    c.created_by,
    nullif(cp.full_name, ''),
    cu.email::text,
    cu.email_confirmed_at is not null,
    nullif(cp.phone, ''),
    cu.last_sign_in_at,
    c.reviewed_at,
    coalesce(nullif(rp.full_name, ''), ru.email::text),
    c.review_note,
    coalesce(m.members, 0),
    coalesce(m.admins, 0),
    coalesce(m.inactive, 0),
    coalesce(j.pending, 0),
    coalesce(cs.status, 'none'),
    pp.name,
    cs.current_period_end,
    -- `time_punches_company_at_idx` makes this one index probe per company.
    (select tp.at from public.time_punches tp
      where tp.company_id = c.id order by tp.at desc limit 1)
  from public.companies c
  left join auth.users cu      on cu.id = c.created_by
  left join public.profiles cp on cp.id = c.created_by
  left join auth.users ru      on ru.id = c.reviewed_by
  left join public.profiles rp on rp.id = c.reviewed_by
  left join lateral (
    select count(*)::int as members,
           count(*) filter (where exists (
             select 1 from public.user_roles ur
              where ur.user_id = p.id and ur.company_id = c.id
                and ur.role = 'company_admin'::public.app_role))::int as admins,
           count(*) filter (where not coalesce(p.is_active, true))::int as inactive
      from (select cm.user_id as id, cm.is_active
              from public.company_memberships cm
             where cm.company_id = c.id and cm.status = 'active') p
  ) m on true
  left join lateral (
    select count(*)::int as pending
      from public.company_join_requests p
     where p.company_id = c.id and p.status = 'pending'
  ) j on true
  left join lateral (
    select s.status, s.plan_id, s.current_period_end
      from public.company_subscriptions s
     where s.company_id = c.id
     order by s.updated_at desc
     limit 1
  ) cs on true
  left join public.pricing_plans pp on pp.id = cs.plan_id
  -- No rows at all for anyone but a platform admin.
  where public.has_role(auth.uid(), 'super_admin'::public.app_role)
  order by (c.status = 'pending') desc, c.created_at desc;
$$;


-- ============================================================== grants ====

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.end_membership(uuid, uuid, text, public.separation_reason, text, uuid)',
    'public.set_company_role(uuid, uuid, public.app_role)',
    'public.seat_check(uuid)',
    'public.log_membership_event(uuid, text, uuid, jsonb, jsonb)',
    'public.notify_member(uuid, text, text, text, text)',
    'public.reselect_company(uuid)',
    'public.other_active_admins(uuid, uuid)',
    'public.break_locked_until(uuid, uuid)',
    'public.current_work_location(uuid, uuid)',
    'public.stretch_location(uuid, timestamptz, uuid)',
    'public.profiles_membership_mirror()',
    'public.memberships_to_profile()',
    'public.notifications_stamp_company()',
    'public.audit_user_roles()',
    'public.company_members_update()',
    'public.join_company(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  foreach f in array array[
    'public.requested_company_id()',
    'public.current_company_id()',
    'public.has_role(uuid, public.app_role, uuid)',
    'public.is_member(uuid, uuid)',
    'public.member_company(uuid)',
    'public.my_companies()',
    'public.switch_company(uuid)',
    'public.my_join_requests()',
    'public.lookup_company_code(text)',
    'public.request_to_join(text, text)',
    'public.join_company_by_code(text)',
    'public.cancel_join_request(uuid)',
    'public.decide_join_request(uuid, boolean, public.app_role, uuid, uuid, text, text)',
    'public.approve_membership(uuid)',
    'public.reject_membership(uuid)',
    'public.set_member_role(uuid, public.app_role)',
    'public.suspend_membership(uuid, text)',
    'public.reinstate_membership(uuid)',
    'public.remove_company_member(uuid, public.separation_reason, text)',
    'public.leave_company(uuid)',
    'public.rehire_company_member(uuid)',
    'public.forget_former_member(uuid)',
    'public.regenerate_join_code()',
    'public.set_membership_policy(boolean, boolean)',
    'public.bootstrap_company(text)',
    'public.accept_invitation(uuid)',
    'public.admin_set_user_company(uuid, uuid)',
    'public.delete_my_account()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';

-- ============================================================== result ====
select
  (select count(*) from public.company_memberships where status = 'active') as active_memberships,
  (select count(*) from public.company_memberships where status = 'revoked') as former_members,
  (select count(*) from public.company_join_requests where status = 'pending') as pending_requests,
  (select count(*) from public.profiles p
    where p.company_id is not null
      and not exists (select 1 from public.company_memberships m
                       where m.user_id = p.id and m.company_id = p.company_id)) as profiles_without_membership;
