-- ---------------------------------------------------------------- billing gate
-- README: "If subscription is inactive: Company cannot create new schedules.
-- Employees can still view existing schedules."
-- No subscription row means not yet billed (trial), which stays allowed.
create or replace function public.company_can_schedule(_company uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select cs.status not in ('canceled','inactive')
       from public.company_subscriptions cs where cs.company_id = _company),
    true
  );
$$;
revoke all on function public.company_can_schedule(uuid) from public, anon;
grant execute on function public.company_can_schedule(uuid) to authenticated;

create or replace function public.enforce_subscription_for_schedule()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if not public.company_can_schedule(new.company_id) then
    raise exception 'Your subscription is inactive. Existing schedules stay visible, but new ones cannot be created.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_subscription_for_schedule() from public, anon, authenticated;

create trigger trg_enforce_subscription_for_schedule
before insert on public.schedules
for each row execute function public.enforce_subscription_for_schedule();

-- ---------------------------------------------------------- schedule publishing
create or replace function public.stamp_schedule_publication()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    new.published_at := now();
    new.published_by := coalesce(auth.uid(), new.published_by);
  end if;
  return new;
end;
$$;
revoke all on function public.stamp_schedule_publication() from public, anon, authenticated;

create trigger trg_stamp_schedule_publication
before update of status on public.schedules
for each row execute function public.stamp_schedule_publication();

-- README notification: "New schedule published". Notify the employees who
-- actually have shifts in it; fall back to the whole company if none assigned.
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
      from public.profiles p where p.company_id = new.company_id;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.notify_schedule_published() from public, anon, authenticated;

create trigger trg_notify_schedule_published
after update of status on public.schedules
for each row execute function public.notify_schedule_published();

-- --------------------------------------------------------------- audit logging
-- Generic trigger: pass the entity name as the first trigger argument.
-- SECURITY DEFINER so it runs as the table owner and bypasses the
-- "no direct write" policy on audit_logs.
create or replace function public.write_audit_log()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  b jsonb; a jsonb; cid uuid; eid uuid;
  entity text := TG_ARGV[0];
begin
  if    TG_OP = 'INSERT' then b := null;            a := to_jsonb(new);
  elsif TG_OP = 'UPDATE' then b := to_jsonb(old);   a := to_jsonb(new);
  else                        b := to_jsonb(old);   a := null;
  end if;

  cid := coalesce((a->>'company_id')::uuid, (b->>'company_id')::uuid);
  eid := coalesce((a->>'id')::uuid,         (b->>'id')::uuid);

  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, before, after)
  values (cid, auth.uid(), entity || '.' || lower(TG_OP), entity, eid, b, a);

  return coalesce(new, old);
end;
$$;
revoke all on function public.write_audit_log() from public, anon, authenticated;

create trigger trg_audit_shifts
after insert or update or delete on public.shifts
for each row execute function public.write_audit_log('shift');

create trigger trg_audit_schedules
after insert or update or delete on public.schedules
for each row execute function public.write_audit_log('schedule');

create trigger trg_audit_time_off
after update on public.time_off_requests
for each row execute function public.write_audit_log('time_off_request');

create trigger trg_audit_trades
after update on public.shift_trades
for each row execute function public.write_audit_log('shift_trade');

create trigger trg_audit_user_roles
after insert or update or delete on public.user_roles
for each row execute function public.write_audit_log('user_role');

create trigger trg_audit_subscriptions
after insert or update or delete on public.company_subscriptions
for each row execute function public.write_audit_log('company_subscription');

-- ------------------------------------------------------------- trade validation
-- README "When trading a shift, check": both employees same company + active,
-- receiver qualified, available, and not pushed over max weekly hours.
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

  select p.id, p.company_id, p.is_active, p.full_name
    into toemp from public.profiles p where p.id = _to_employee_id;
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
revoke all on function public.check_trade_conflicts(uuid, uuid) from public, anon;
grant execute on function public.check_trade_conflicts(uuid, uuid) to authenticated;
