-- Make shift trades actually trade, and make approval atomic.
--
-- Three things were wrong:
--
--   1. Approval was two separate writes from the admin's browser — flip the
--      status, then reassign the shift. If the second failed the trade read
--      "approved" while the schedule never moved, which is the one outcome the
--      feature exists to prevent.
--   2. It was a give-away, not a trade: only the proposer's shift moved. There
--      was nowhere to say "and I'll take yours on Thursday".
--   3. `check_trade_conflicts` already existed — double-booking, time off,
--      availability, qualifications, weekly hours — and nothing called it, so a
--      trade could hand someone a shift they were already working.

-- The shift coming back the other way. Null keeps the old behaviour: a
-- straight hand-off where someone covers a shift and gives nothing up.
alter table public.shift_trades
  add column if not exists to_shift_id uuid references public.shifts(id) on delete cascade;

comment on column public.shift_trades.to_shift_id is
  'Shift offered in return, making it a two-way swap. Null = a straight hand-off.';

/**
 * The recipient's answer. Moves a trade from pending_employee to
 * pending_supervisor, or declines it outright.
 */
create or replace function public.respond_to_trade(_trade uuid, _accept boolean)
returns public.shift_trades
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  t public.shift_trades;
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select * into t from public.shift_trades where id = _trade for update;
  if not found then raise exception 'trade not found'; end if;
  if t.to_employee_id <> caller then
    raise exception 'only the teammate being asked can answer this trade';
  end if;
  if t.status <> 'pending_employee' then
    raise exception 'this trade has already been answered';
  end if;

  perform public.require_capability(t.company_id, 'shift_trades', 'Shift trades');

  update public.shift_trades
     set status = case when _accept then 'pending_supervisor' else 'declined' end
   where id = _trade
   returning * into t;
  return t;
end;
$$;

/**
 * The admin's decision, and the only place the schedule moves.
 *
 * Both reassignments happen in this one statement, so the trade and the roster
 * can never disagree — either the swap lands whole or nothing changes.
 */
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

  -- Refuse anything the scheduler itself would refuse. Warnings are advisory
  -- and pass; only a hard error blocks the swap.
  select c.message into blocker
    from public.check_trade_conflicts(t.shift_id, t.to_employee_id) c
   where c.severity = 'error'
   limit 1;
  if blocker is not null then
    raise exception 'Cannot approve: %', blocker;
  end if;

  if t.to_shift_id is not null then
    select c.message into blocker
      from public.check_trade_conflicts(t.to_shift_id, t.from_employee_id) c
     where c.severity = 'error'
     limit 1;
    if blocker is not null then
      raise exception 'Cannot approve: %', blocker;
    end if;
  end if;

  update public.shifts set employee_id = t.to_employee_id where id = t.shift_id;
  if t.to_shift_id is not null then
    update public.shifts set employee_id = t.from_employee_id where id = t.to_shift_id;
  end if;

  update public.shift_trades set status = 'approved' where id = _trade returning * into t;

  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, after)
  values (t.company_id, caller, 'shift_trade.approved', 'shift_trade', t.id,
          jsonb_build_object('shift_id', t.shift_id, 'to_shift_id', t.to_shift_id,
                             'from_employee', t.from_employee_id, 'to_employee', t.to_employee_id));

  return t;
end;
$$;

revoke all on function public.respond_to_trade(uuid, boolean) from public, anon;
revoke all on function public.approve_trade(uuid, boolean) from public, anon;
grant execute on function public.respond_to_trade(uuid, boolean) to authenticated;
grant execute on function public.approve_trade(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
