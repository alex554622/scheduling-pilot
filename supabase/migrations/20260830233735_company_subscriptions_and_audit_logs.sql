-- One subscription row per company, pointing at a pricing_plans row.
-- external_* hold Stripe ids so billing can be wired up without a schema change.
create table public.company_subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null unique references public.companies(id) on delete cascade,
  plan_id uuid references public.pricing_plans(id) on delete set null,
  status text not null default 'trialing'
    check (status in ('trialing','active','past_due','canceled','inactive')),
  seats_limit integer check (seats_limit is null or seats_limit > 0),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  external_customer_id text,
  external_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index company_subscriptions_status_idx on public.company_subscriptions(status);

alter table public.company_subscriptions enable row level security;

-- Company admins read their own billing state; only super admins may change it.
-- Writes must never be client-side once Stripe is live -- use a webhook with the
-- service role, which bypasses RLS.
create policy "subscriptions_view_own" on public.company_subscriptions for select to authenticated
  using (
    company_id = public.current_company_id()
    or public.has_role(auth.uid(), 'super_admin')
  );
create policy "subscriptions_super_admin_manage" on public.company_subscriptions for all to authenticated
  using (public.has_role(auth.uid(), 'super_admin'))
  with check (public.has_role(auth.uid(), 'super_admin'));

-- General-purpose audit trail (time_punch_audit stays as the punch-specific one).
-- The company_id FK is dropped in a later migration: cascade-deleting a company
-- fires these triggers and the FK made tenant deletion impossible.
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,          -- e.g. 'shift.created', 'time_off.approved'
  entity_type text not null,     -- e.g. 'shift'
  entity_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_company_idx on public.audit_logs(company_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs(entity_type, entity_id);

alter table public.audit_logs enable row level security;

-- Managers read their company's trail. Nobody writes directly: rows come only
-- from SECURITY DEFINER triggers, which run as the table owner and bypass RLS.
create policy "audit_logs_manager_read" on public.audit_logs for select to authenticated
  using (
    public.has_role(auth.uid(), 'super_admin')
    or (company_id is not null and (
         public.has_role(auth.uid(), 'company_admin', company_id)
      or public.has_role(auth.uid(), 'supervisor', company_id)))
  );
create policy "audit_logs_no_direct_write" on public.audit_logs for insert to authenticated
  with check (false);

grant select on public.audit_logs to authenticated;
grant select on public.company_subscriptions to authenticated;

create or replace function public.touch_updated_at()
returns trigger language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

create trigger trg_company_subscriptions_touch
before update on public.company_subscriptions
for each row execute function public.touch_updated_at();
