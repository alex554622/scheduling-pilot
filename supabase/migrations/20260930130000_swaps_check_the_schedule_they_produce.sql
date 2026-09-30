-- Let a two-way swap go through whatever days or times the shifts fall on.
--
-- approve_trade ran check_trade_conflicts against the roster as it stood
-- *before* the swap. For a two-way trade that meant each employee's double-
-- booking check still counted the shift they were about to hand over, so two
-- people swapping shifts on the same day (or overlapping times) were refused
-- as "already has a shift overlapping this time" — by their own shift.
--
-- Now the reassignment happens first and the checks run against the schedule
-- the swap actually produces. Any hard error raises, which rolls the whole
-- function back, so the roster is still never left half-swapped.

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

  if not exists (select 1 from public.profiles p
                  where p.id = t.to_employee_id and p.company_id = t.company_id) then
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

revoke all on function public.approve_trade(uuid, boolean) from public, anon;
grant execute on function public.approve_trade(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
