-- Give every new company a free trial of the top plan, and let a super admin
-- manage how long that trial runs.
--
-- `bootstrap_company` already makes whoever creates a company its admin. What
-- it didn't do was give them anything to use: with no subscription row,
-- `company_plan_id` fell through to the `companies.plan` text and a brand new
-- company resolved to no capabilities at all.
--
-- The trial clock starts when a super admin approves the company, not when it
-- is created — a company sits at 'pending' unable to sign in, and burning trial
-- days while waiting would be the wrong kind of surprise.

-- ---- settings a super admin controls ----

insert into public.app_settings (key, value)
values ('trial_days', '30'::jsonb)
on conflict (key) do nothing;

insert into public.app_settings (key, value)
values ('trial_plan', '"Enterprise"'::jsonb)
on conflict (key) do nothing;

-- The public pricing page advertises the trial length and the billing mode, but
-- `app_settings` was readable only by signed-in users — so a visitor silently
-- got the fallbacks. Expose just these two keys, and nothing else in the table.
drop policy if exists settings_read_public_keys on public.app_settings;
create policy settings_read_public_keys
  on public.app_settings for select
  to anon
  using (key in ('trial_days', 'payments_enabled'));

create or replace function public.trial_days()
returns int
language sql stable security definer set search_path = public
as $$
  select greatest(0, coalesce(
    (select nullif(value #>> '{}', '')::int from public.app_settings where key = 'trial_days'),
    30
  ));
$$;

create or replace function public.trial_plan_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select pp.id
  from public.pricing_plans pp
  where lower(pp.name) = lower(coalesce(
          (select value #>> '{}' from public.app_settings where key = 'trial_plan'),
          'Enterprise'))
  limit 1;
$$;

revoke all on function public.trial_days() from public, anon;
revoke all on function public.trial_plan_id() from public, anon;
grant execute on function public.trial_days() to authenticated;
grant execute on function public.trial_plan_id() to authenticated;

-- ---- a trial subscription is created with the company ----

create or replace function public.bootstrap_company(_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  insert into public.companies (name, status) values (_name, 'pending') returning id into cid;
  insert into public.user_roles (user_id, company_id, role) values (uid, cid, 'company_admin');
  update public.profiles set company_id = cid where id = uid;

  -- Period dates stay null until approval; `company_plan_id` treats a trial
  -- with no end date as not yet started, which is right for a pending company.
  insert into public.company_subscriptions (company_id, plan_id, status)
  values (cid, public.trial_plan_id(), 'trialing');

  return cid;
end;
$$;

revoke all on function public.bootstrap_company(text) from public, anon;
grant execute on function public.bootstrap_company(text) to authenticated;

-- ---- approval starts the clock, and hands out the join code as before ----

create or replace function public.assign_join_code_on_approval()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if NEW.status = 'active' and NEW.join_code is null then
    NEW.join_code := public.generate_company_join_code();
  end if;
  return NEW;
end;
$$;

create or replace function public.start_trial_on_approval()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Only the moment of approval, and only a trial that hasn't started yet.
  if NEW.status = 'active' and coalesce(OLD.status, '') <> 'active' then
    update public.company_subscriptions
      set current_period_start = now(),
          current_period_end = now() + (public.trial_days() || ' days')::interval,
          updated_at = now()
      where company_id = NEW.id
        and status = 'trialing'
        and current_period_end is null;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_start_trial_on_approval on public.companies;
create trigger trg_start_trial_on_approval
after update of status on public.companies
for each row execute function public.start_trial_on_approval();

-- ---- an expired trial stops granting anything ----

create or replace function public.company_plan_id(_company uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select cs.plan_id
       from public.company_subscriptions cs
      where cs.company_id = _company
        and cs.plan_id is not null
        and (
          cs.status = 'active'
          -- A trial only counts while it is running.
          or (cs.status = 'trialing'
              and cs.current_period_end is not null
              and cs.current_period_end > now())
        )
      order by cs.updated_at desc
      limit 1),
    (select pp.id
       from public.pricing_plans pp
       join public.companies c on lower(c.plan) = lower(pp.name)
      where c.id = _company
      limit 1)
  );
$$;

-- ---- what the UI needs to show a countdown ----

create or replace function public.company_trial_status(_company uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object(
       'trialing', cs.current_period_end is not null and cs.current_period_end > now(),
       'expired',  cs.current_period_end is not null and cs.current_period_end <= now(),
       'ends_at',  cs.current_period_end,
       'days_left', greatest(0, ceil(extract(epoch from (cs.current_period_end - now())) / 86400))::int,
       'plan', (select pp.name from public.pricing_plans pp where pp.id = cs.plan_id)
     )
     from public.company_subscriptions cs
     where cs.company_id = _company and cs.status = 'trialing'
     order by cs.updated_at desc
     limit 1),
    jsonb_build_object('trialing', false, 'expired', false)
  );
$$;

revoke all on function public.company_trial_status(uuid) from public, anon;
grant execute on function public.company_trial_status(uuid) to authenticated;

-- ---- backfill: companies that predate this and have no subscription ----

insert into public.company_subscriptions (company_id, plan_id, status, current_period_start, current_period_end)
select c.id, public.trial_plan_id(), 'trialing', now(), now() + (public.trial_days() || ' days')::interval
from public.companies c
where c.status = 'active'
  and not exists (select 1 from public.company_subscriptions s where s.company_id = c.id);

notify pgrst, 'reload schema';
