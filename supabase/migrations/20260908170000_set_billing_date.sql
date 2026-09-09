-- Let a super admin set a company's billing date directly.
--
-- `mark_subscription_paid` and `extend_subscription` move the date as a side
-- effect of an event. This is the plain override for when neither fits — a
-- date agreed off-platform, or fixing one that was set wrong.

create or replace function public.set_billing_date(
  _company uuid,
  _date timestamptz,
  _reason text default ''
) returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  sub public.company_subscriptions;
begin
  if not public.has_role(caller, 'super_admin'::app_role) then
    raise exception 'not authorized';
  end if;
  if _date is null then raise exception 'a billing date is required'; end if;

  select * into sub from public.company_subscriptions
   where company_id = _company order by updated_at desc limit 1 for update;

  -- A company that has never had a subscription still needs one to hold a date.
  if not found then
    insert into public.company_subscriptions (company_id, plan_id, status, current_period_start, current_period_end)
    values (_company, public.company_plan_id(_company), 'trialing', now(), _date)
    returning * into sub;
  else
    update public.company_subscriptions
       set current_period_end = _date,
           -- Pushing the date into the future revives a lapsed subscription;
           -- leaving it in the past should not silently mark them active.
           status = case when sub.status = 'past_due' and _date > now() then 'trialing' else sub.status end,
           updated_at = now()
     where id = sub.id;
  end if;

  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, before, after)
  values (_company, caller, 'billing_date.changed', 'company_subscription', sub.id,
          jsonb_build_object('period_end', sub.current_period_end),
          jsonb_build_object('period_end', _date, 'reason', coalesce(_reason, '')));

  return _date;
end;
$$;

revoke all on function public.set_billing_date(uuid, timestamptz, text) from public, anon;
grant execute on function public.set_billing_date(uuid, timestamptz, text) to authenticated;

notify pgrst, 'reload schema';
