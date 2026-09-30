-- The platform admin's view of a business: who opened it, who approved it, and
-- a lock on the approval itself.
--
-- Three gaps this closes:
--
--   1. Nothing recorded who registered a company. Every screen guessed, by
--      taking the oldest company admin — which is wrong the moment the owner
--      promotes someone who signed up before them, and says nothing at all once
--      the owner is deleted. `created_by` is now written by `bootstrap_company`.
--
--   2. Approval could be skipped. `company_admin_update` lets a company's own
--      admin update its row, and nothing stopped that update from setting
--      `status = 'active'`. A pending business could approve itself from the
--      browser console. The guard below keeps status, billing and review
--      columns for platform admins, the same way `guard_break_alert_sound`
--      already keeps that one column.
--
--   3. There was no "no". A registration could be approved or left pending for
--      ever. `admin_review_company` approves or rejects in one audited step,
--      records who decided and when, and a rejection carries its reason to the
--      business.
--
-- `admin_companies()` is the Companies page's single read: every company with
-- its creator's email (auth.users, which no client may read), headcounts,
-- subscription and last activity — one round trip instead of five queries
-- stitched together in the browser.
--
-- Re-runnable; applied by hand in Studio.

-- ------------------------------------------------------------------ columns
alter table public.companies
  add column if not exists created_by  uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists review_note text;

comment on column public.companies.created_by is
  'The account that registered this company through bootstrap_company.';
comment on column public.companies.reviewed_by is
  'The platform admin who approved or rejected the registration.';
comment on column public.companies.review_note is
  'Why a registration was rejected (shown to the business), or a note on approval.';

-- The approval queue is "pending, newest first", read on every visit.
create index if not exists companies_status_created_idx
  on public.companies (status, created_at desc);

-- Companies that predate the column: the best evidence left is the earliest
-- company admin, which is the same guess every screen made until now. Only
-- fills blanks, so re-running never overwrites a recorded creator.
update public.companies c
   set created_by = first_admin.user_id
  from (
    select distinct on (ur.company_id) ur.company_id, ur.user_id
      from public.user_roles ur
      join auth.users u on u.id = ur.user_id
      left join public.profiles p on p.id = ur.user_id
     where ur.role = 'company_admin'::public.app_role
       and ur.company_id is not null
     order by ur.company_id, coalesce(p.created_at, u.created_at)
  ) first_admin
 where first_admin.company_id = c.id
   and c.created_by is null;

-- ------------------------------------------------------------------- guard
-- Row-level security cannot protect some columns of a row, so the rule lives in
-- a trigger. A company admin keeps everything they already edit — name,
-- timezone, settings, worksite — and loses only what was never theirs.
--
-- `auth.uid() is null` is the service role or a statement run by hand in
-- Studio: there is no end user to check.
--
-- A join code appearing where there was none is let through: it is what
-- `trg_assign_join_code` does to an active company, and that trigger fires
-- before this one (triggers run in name order).
create or replace function public.guard_company_platform_columns()
returns trigger language plpgsql security definer set search_path = public
as $fn$
begin
  if auth.uid() is null
     or public.has_role(auth.uid(), 'super_admin'::public.app_role) then
    return new;
  end if;

  if new.status                is distinct from old.status
     or new.billing_mode          is distinct from old.billing_mode
     or new.plan                  is distinct from old.plan
     or new.data_retention_months is distinct from old.data_retention_months
     or (new.join_code is distinct from old.join_code and old.join_code is not null)
     or new.created_by            is distinct from old.created_by
     or new.reviewed_at           is distinct from old.reviewed_at
     or new.reviewed_by           is distinct from old.reviewed_by
     or new.review_note           is distinct from old.review_note then
    raise exception 'Only a platform admin can change a company''s status, billing or review.';
  end if;
  return new;
end;
$fn$;
revoke all on function public.guard_company_platform_columns() from public, anon, authenticated;

drop trigger if exists trg_guard_company_platform_columns on public.companies;
create trigger trg_guard_company_platform_columns
before update on public.companies
for each row execute function public.guard_company_platform_columns();

-- ------------------------------------------------------- record the creator
-- As in 20260920130000, plus `created_by`.
create or replace function public.bootstrap_company(_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  insert into public.companies (name, status, created_by)
  values (_name, 'pending', uid)
  returning id into cid;
  insert into public.user_roles (user_id, company_id, role) values (uid, cid, 'company_admin');

  insert into public.profiles (id, company_id)
  values (uid, cid)
  on conflict (id) do update set company_id = excluded.company_id;

  insert into public.company_subscriptions (company_id, plan_id, status)
  values (cid, public.trial_plan_id(), 'trialing');

  return cid;
end;
$$;
revoke all on function public.bootstrap_company(text) from public, anon;
grant execute on function public.bootstrap_company(text) to authenticated;

-- ------------------------------------------------ tell the platform admins
-- As in 20260915120000, but the notification is enough to act on from a lock
-- screen: who registered it and how to reach them, and a link that opens this
-- company rather than the whole list.
create or replace function public.notify_new_company()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  who   text;
  email text;
begin
  if NEW.status is distinct from 'pending' then return NEW; end if;

  select nullif(p.full_name, ''), u.email::text
    into who, email
    from auth.users u
    left join public.profiles p on p.id = u.id
   where u.id = coalesce(NEW.created_by, auth.uid());

  insert into public.notifications (user_id, type, title, body, link)
  select distinct ur.user_id,
         'company_pending',
         'New business awaiting approval',
         NEW.name || ' was registered by '
           || coalesce(who || ' (' || email || ')', email, 'an unknown account')
           || '.',
         '/companies?company=' || NEW.id
    from public.user_roles ur
   where ur.role = 'super_admin';

  return NEW;
end; $$;

drop trigger if exists trg_notify_new_company on public.companies;
create trigger trg_notify_new_company
after insert on public.companies
for each row execute function public.notify_new_company();

-- ----------------------------------------------- tell the business, too
-- As in 20260623043307, plus rejection. The reason is the point of telling
-- them: "not approved" alone is a dead end.
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
     where p.company_id = NEW.id;
  end if;
  return NEW;
end; $$;
revoke all on function public.notify_company_status_change() from public, anon, authenticated;

-- ------------------------------------------------------------- the decision
-- Approve or reject, in one step that records who and when and leaves an
-- audit entry. Approval still goes through the existing triggers — join code,
-- trial clock, "you're approved" notification — because it is still an update
-- of `status` to 'active'.
--
-- Only a registration can be reviewed. Suspending or reinstating a live
-- company is a different decision and stays on the status control.
create or replace function public.admin_review_company(
  _company uuid,
  _approve boolean,
  _note    text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  c      public.companies;
  note   text := nullif(trim(coalesce(_note, '')), '');
  next   text := case when _approve then 'active' else 'rejected' end;
begin
  if not public.has_role(caller, 'super_admin'::public.app_role) then
    raise exception 'not authorized';
  end if;

  select * into c from public.companies where id = _company for update;
  if not found then raise exception 'no such company'; end if;

  if c.status not in ('pending', 'rejected') then
    raise exception 'This company is already %; change its status instead.', c.status;
  end if;
  if not _approve and note is null then
    raise exception 'Give a reason — the business is told why it was not approved.';
  end if;

  update public.companies
     set status      = next,
         reviewed_at = now(),
         reviewed_by = caller,
         review_note = note
   where id = _company;

  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, before, after)
  values (_company, caller,
          case when _approve then 'company.approved' else 'company.rejected' end,
          'company', _company,
          jsonb_build_object('status', c.status),
          jsonb_build_object('status', next, 'note', note));
end;
$$;
revoke all on function public.admin_review_company(uuid, boolean, text) from public, anon;
grant execute on function public.admin_review_company(uuid, boolean, text) to authenticated;

-- ------------------------------------------------------------ the directory
-- Every company, with everything the Companies page shows beside it. Pending
-- registrations first, then newest.
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
      from public.profiles p
     where p.company_id = c.id
  ) m on true
  left join lateral (
    select count(*)::int as pending
      from public.profiles p
     where p.pending_company_id = c.id
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
revoke all on function public.admin_companies() from public, anon;
grant execute on function public.admin_companies() to authenticated;

notify pgrst, 'reload schema';
