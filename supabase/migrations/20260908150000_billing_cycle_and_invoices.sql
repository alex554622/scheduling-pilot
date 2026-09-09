-- Turn the end of a free trial into a real billing cycle.
--
-- The day a company first pays becomes its billing date, and every renewal
-- rolls forward from the previous period end rather than from "now", so the
-- date never drifts by a day each month.
--
-- A super admin gets three moves when a company reaches that date without
-- paying: mark it paid (which issues an invoice), extend the period for free,
-- or suspend the account.

-- ---- invoices ----

create sequence if not exists public.invoice_number_seq;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- Human-facing, stable, and never reused: INV-2026-0001.
  number text not null unique,
  plan_id uuid references public.pricing_plans(id) on delete set null,
  plan_name text not null default '',
  amount_cents int not null default 0,
  status text not null default 'paid' check (status in ('draft', 'sent', 'paid', 'void')),
  period_start timestamptz,
  period_end timestamptz,
  issued_at timestamptz not null default now(),
  paid_at timestamptz,
  sent_at timestamptz,
  /** Where it was emailed, captured at send time so a later profile edit can't rewrite history. */
  sent_to text,
  note text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists invoices_company_idx on public.invoices (company_id, issued_at desc);

alter table public.invoices enable row level security;

-- A company admin can read their own invoices; super admins see everything.
drop policy if exists invoices_read on public.invoices;
create policy invoices_read on public.invoices for select to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    or public.has_role(auth.uid(), 'company_admin'::app_role, company_id)
  );

-- Writes go through the RPCs below, never straight from a client.
revoke all on public.invoices from anon;
grant select on public.invoices to authenticated;

create or replace function public.next_invoice_number()
returns text
language sql volatile security definer set search_path = public
as $$
  select 'INV-' || to_char(now(), 'YYYY') || '-' ||
         lpad(nextval('public.invoice_number_seq')::text, 4, '0');
$$;

-- ---- who is due, and who is late ----

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
      where p.company_id = c.id
        and public.has_role(p.id, 'company_admin'::app_role, c.id)
      order by p.created_at
      limit 1)
  from public.companies c
  left join public.company_subscriptions cs on cs.company_id = c.id
  left join public.pricing_plans pp on pp.id = cs.plan_id
  where public.has_role(auth.uid(), 'super_admin'::app_role)
  order by cs.current_period_end nulls last;
$$;

revoke all on function public.billing_overview() from public, anon;
grant execute on function public.billing_overview() to authenticated;

-- ---- the three moves ----

/**
 * Record a payment. Rolls the period forward `_months` from the previous end —
 * or from today on a first payment — so the billing day of the month sticks,
 * and issues a paid invoice for the period just bought.
 */
create or replace function public.mark_subscription_paid(
  _company uuid,
  _months int default 1,
  _note text default ''
) returns public.invoices
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  sub public.company_subscriptions;
  plan public.pricing_plans;
  starts_at timestamptz;
  ends_at timestamptz;
  inv public.invoices;
begin
  if not public.has_role(caller, 'super_admin'::app_role) then
    raise exception 'not authorized';
  end if;
  if _months is null or _months < 1 or _months > 36 then
    raise exception 'months must be between 1 and 36';
  end if;

  select * into sub from public.company_subscriptions
   where company_id = _company order by updated_at desc limit 1 for update;
  if not found then raise exception 'this company has no subscription'; end if;

  select * into plan from public.pricing_plans where id = sub.plan_id;

  -- Renewing from the previous end keeps the billing date fixed; a first
  -- payment (or one made long after a lapse) starts a fresh cycle today.
  starts_at := case
    when sub.current_period_end is null or sub.current_period_end < now() then now()
    else sub.current_period_end
  end;
  ends_at := starts_at + (_months || ' months')::interval;

  update public.company_subscriptions
     set status = 'active',
         current_period_start = starts_at,
         current_period_end = ends_at,
         updated_at = now()
   where id = sub.id;

  -- Paying clears a suspension.
  update public.companies
     set status = 'active'
   where id = _company and status in ('past_due', 'suspended');

  insert into public.invoices (
    company_id, number, plan_id, plan_name, amount_cents, status,
    period_start, period_end, paid_at, note, created_by
  ) values (
    _company, public.next_invoice_number(), plan.id, coalesce(plan.name, '—'),
    coalesce(plan.price_cents, 0) * _months, 'paid',
    starts_at, ends_at, now(), coalesce(_note, ''), caller
  )
  returning * into inv;

  return inv;
end;
$$;

/** Give a company more time without charging — a goodwill extension. */
create or replace function public.extend_subscription(
  _company uuid,
  _days int,
  _reason text default ''
) returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  sub public.company_subscriptions;
  base timestamptz;
  ends_at timestamptz;
begin
  if not public.has_role(caller, 'super_admin'::app_role) then
    raise exception 'not authorized';
  end if;
  if _days is null or _days < 1 or _days > 365 then
    raise exception 'extension must be between 1 and 365 days';
  end if;

  select * into sub from public.company_subscriptions
   where company_id = _company order by updated_at desc limit 1 for update;
  if not found then raise exception 'this company has no subscription'; end if;

  -- Extending something already lapsed should give the full period from today,
  -- not silently expire again the moment it is granted.
  base := greatest(coalesce(sub.current_period_end, now()), now());
  ends_at := base + (_days || ' days')::interval;

  update public.company_subscriptions
     set current_period_end = ends_at,
         status = case when sub.status = 'past_due' then 'trialing' else sub.status end,
         updated_at = now()
   where id = sub.id;

  update public.companies set status = 'active'
   where id = _company and status in ('past_due', 'suspended');

  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, before, after)
  values (_company, caller, 'subscription.extended', 'company_subscription', sub.id,
          jsonb_build_object('period_end', sub.current_period_end),
          jsonb_build_object('period_end', ends_at, 'days', _days, 'reason', coalesce(_reason, '')));

  return ends_at;
end;
$$;

/** Suspend for non-payment. Everyone at the company is locked out until it is
 *  paid or reactivated — the authenticated layout already gates on this. */
create or replace function public.suspend_company_for_nonpayment(
  _company uuid,
  _reason text default ''
) returns void
language plpgsql security definer set search_path = public
as $$
declare caller uuid := auth.uid();
begin
  if not public.has_role(caller, 'super_admin'::app_role) then
    raise exception 'not authorized';
  end if;

  update public.companies set status = 'suspended' where id = _company;
  update public.company_subscriptions
     set status = 'past_due', updated_at = now()
   where company_id = _company;

  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, after)
  values (_company, caller, 'company.suspended', 'company', _company,
          jsonb_build_object('reason', coalesce(_reason, ''), 'cause', 'non-payment'));
end;
$$;

/** Stamp an invoice as emailed. The transport lives outside the database. */
create or replace function public.mark_invoice_sent(_invoice uuid, _to text)
returns public.invoices
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  inv public.invoices;
begin
  if not public.has_role(caller, 'super_admin'::app_role) then
    raise exception 'not authorized';
  end if;
  update public.invoices
     set sent_at = now(),
         sent_to = _to,
         status = case when status = 'draft' then 'sent' else status end
   where id = _invoice
   returning * into inv;
  if not found then raise exception 'invoice not found'; end if;
  return inv;
end;
$$;

revoke all on function public.mark_subscription_paid(uuid, int, text) from public, anon;
revoke all on function public.extend_subscription(uuid, int, text) from public, anon;
revoke all on function public.suspend_company_for_nonpayment(uuid, text) from public, anon;
revoke all on function public.mark_invoice_sent(uuid, text) from public, anon;
revoke all on function public.next_invoice_number() from public, anon;
grant execute on function public.mark_subscription_paid(uuid, int, text) to authenticated;
grant execute on function public.extend_subscription(uuid, int, text) to authenticated;
grant execute on function public.suspend_company_for_nonpayment(uuid, text) to authenticated;
grant execute on function public.mark_invoice_sent(uuid, text) to authenticated;

notify pgrst, 'reload schema';
