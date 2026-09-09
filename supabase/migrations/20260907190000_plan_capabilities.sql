-- Make a subscription plan actually decide what a company can do.
--
-- `pricing_plans.features` is a list of marketing strings for the pricing page;
-- nothing reads it. This adds a machine-readable sibling — `capabilities`, a
-- flag per feature — plus a seat cap, so a super admin can hand a company the
-- time clock, geofencing or reports by ticking a box.
--
-- Basic is deliberately narrow: design a schedule and post it, nothing else.
-- Pro and Enterprise carry the same capabilities and differ only in headcount.

alter table public.pricing_plans
  add column if not exists capabilities jsonb not null default '{}'::jsonb,
  -- Null means unlimited. A plain int keeps the seat check trivial.
  add column if not exists max_employees int;

comment on column public.pricing_plans.capabilities is
  'Feature flags this plan grants, e.g. {"time_clock": true}. Missing key = denied.';
comment on column public.pricing_plans.max_employees is
  'Seat cap for companies on this plan. Null = unlimited.';

-- ---- the full set of gateable capabilities, and what each tier gets ----

create or replace function public.default_plan_capabilities()
returns jsonb language sql immutable
as $$
  select jsonb_build_object(
    'schedule_design',  false,  -- build and edit shifts
    'schedule_publish', false,  -- release a schedule to staff
    'auto_scheduling',  false,  -- the schedule generator
    'org_structure',    false,  -- departments, locations, positions
    'availability',     false,
    'time_clock',       false,  -- clock in / out, breaks
    'geofence',         false,  -- location rules on punches
    'timecards',        false,  -- timecards, printing, CSV
    'shift_trades',     false,
    'time_off',         false,
    'reports',          false,
    'audit_log',        false
  );
$$;

-- Basic: design and post schedules. Nothing else.
update public.pricing_plans
set capabilities = public.default_plan_capabilities() || jsonb_build_object(
      'schedule_design',  true,
      'schedule_publish', true
    ),
    max_employees = 25
where lower(name) = 'basic';

-- Pro and Enterprise are the same product; only the headcount differs.
update public.pricing_plans
set capabilities = (
      select jsonb_object_agg(key, true)
      from jsonb_each(public.default_plan_capabilities())
    ),
    max_employees = 25
where lower(name) = 'pro';

update public.pricing_plans
set capabilities = (
      select jsonb_object_agg(key, true)
      from jsonb_each(public.default_plan_capabilities())
    ),
    max_employees = null
where lower(name) = 'enterprise';

-- Any other plan starts locked down rather than silently wide open.
update public.pricing_plans
set capabilities = public.default_plan_capabilities()
where capabilities = '{}'::jsonb;

-- The old `features` bullets were hand-typed and already contradict the flags —
-- Basic advertised "Shift trades" and "Time-off requests", neither of which it
-- grants. Pricing cards now render from `capabilities`, so clear the stale copy
-- and let `features` mean only genuine extras ("Priority support") from here on.
update public.pricing_plans set features = '[]'::jsonb;

-- The capacity line is derived from max_employees for the same reason.
update public.pricing_plans
set capacity = case
      when max_employees is null then 'Unlimited employees'
      else 'Up to ' || max_employees || ' employees'
    end;

-- ---- resolving a company's plan ----

-- Two places claim to know a company's plan: `company_subscriptions.plan_id`
-- and the older `companies.plan` text column, and they can disagree. The
-- subscription wins; the text column is the fallback so a company that never
-- got a subscription row still resolves to something.
create or replace function public.company_plan_id(_company uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select cs.plan_id
       from public.company_subscriptions cs
      where cs.company_id = _company
        and cs.status in ('active', 'trialing')
        and cs.plan_id is not null
      order by cs.updated_at desc
      limit 1),
    (select pp.id
       from public.pricing_plans pp
       join public.companies c on lower(c.plan) = lower(pp.name)
      where c.id = _company
      limit 1)
  );
$$;

create or replace function public.company_capabilities(_company uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select public.default_plan_capabilities() || coalesce(
    (select pp.capabilities
       from public.pricing_plans pp
      where pp.id = public.company_plan_id(_company)),
    '{}'::jsonb
  );
$$;

create or replace function public.company_has_capability(_company uuid, _key text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((public.company_capabilities(_company) ->> _key)::boolean, false);
$$;

create or replace function public.company_seat_limit(_company uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select cs.seats_limit
       from public.company_subscriptions cs
      where cs.company_id = _company and cs.seats_limit is not null
      order by cs.updated_at desc
      limit 1),
    (select pp.max_employees
       from public.pricing_plans pp
      where pp.id = public.company_plan_id(_company))
  );
$$;

revoke all on function public.default_plan_capabilities() from public, anon;
revoke all on function public.company_plan_id(uuid) from public, anon;
revoke all on function public.company_capabilities(uuid) from public, anon;
revoke all on function public.company_has_capability(uuid, text) from public, anon;
revoke all on function public.company_seat_limit(uuid) from public, anon;
grant execute on function public.default_plan_capabilities() to authenticated;
grant execute on function public.company_plan_id(uuid) to authenticated;
grant execute on function public.company_capabilities(uuid) to authenticated;
grant execute on function public.company_has_capability(uuid, text) to authenticated;
grant execute on function public.company_seat_limit(uuid) to authenticated;

-- ---- enforce the seat cap where members are actually added ----

create or replace function public.approve_membership(_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  cid uuid;
  caller uuid := auth.uid();
  cap int;
  used int;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  select pending_company_id into cid from public.profiles where id = _user;
  if cid is null then raise exception 'no pending request'; end if;
  if not (public.has_role(caller, 'company_admin'::app_role, cid)
          or public.has_role(caller, 'super_admin'::app_role)) then
    raise exception 'not authorized';
  end if;

  cap := public.company_seat_limit(cid);
  if cap is not null then
    select count(*) into used from public.profiles where company_id = cid;
    if used >= cap then
      raise exception 'Your plan covers % employees and all seats are in use. Upgrade the plan to add more.', cap;
    end if;
  end if;

  update public.profiles
    set company_id = cid, pending_company_id = null
    where id = _user;
  insert into public.user_roles (user_id, company_id, role)
    values (_user, cid, 'employee')
    on conflict do nothing;
end;
$$;

revoke all on function public.approve_membership(uuid) from public, anon;
grant execute on function public.approve_membership(uuid) to authenticated;

-- ---- let a super admin edit capabilities, and everyone read their own ----
-- pricing_plans is already readable; capabilities ride along on that policy.

notify pgrst, 'reload schema';
