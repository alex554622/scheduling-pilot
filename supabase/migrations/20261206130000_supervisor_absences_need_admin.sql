-- A supervisor's absence goes to an admin for the final answer.
--
-- Until now "Mark an absence" on a time card wrote time off as already
-- approved, and cleared the person's shifts, whoever pressed it. For a
-- supervisor that skipped the admin's final approval that every other time-off
-- request needs (20261128120000_request_approval_chain.sql).
--
-- Now:
--   * An admin's absence is unchanged: approved at once, shifts opened.
--   * A supervisor's absence is a pending time-off request that counts as their
--     own approval. Any other supervisor of the person still has to approve it,
--     as with a request the employee made; then it waits on an admin, who is
--     told. Shifts are opened only when the admin approves (decide_time_off),
--     and the employee hears the final answer from record_admin_decision.
--   * A supervisor can withdraw an absence they recorded while it is still
--     pending. Time off an admin has approved, and requests other people made,
--     are no longer theirs to remove (they answer those with Approve/Deny).
--     An admin can still remove any.
--
-- time_off_requests.recorded_by says who marked an absence from a time card
-- (null: the employee asked for it on the Time off page).
--
-- Run after 20261128120000_request_approval_chain.sql. Re-runnable; applied by
-- hand in Studio.

begin;

do $$
begin
  if to_regprocedure('public.supervisor_decide(text, uuid, boolean, text)') is null
     or to_regprocedure('public.route_request(text, uuid)') is null then
    raise exception 'the request approval chain migration is missing; apply it first';
  end if;
end;
$$;

alter table public.time_off_requests
  add column if not exists recorded_by uuid references auth.users(id) on delete set null;

-- The app can't set it directly: only the function below writes it.
create or replace function public.time_off_requests_guard()
returns trigger language plpgsql set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.approval_stage := null;
    new.recorded_by := null;
    return new;
  end if;
  if new.status is distinct from old.status
     or new.approval_stage is distinct from old.approval_stage
     or new.employee_id is distinct from old.employee_id
     or new.company_id is distinct from old.company_id
     or new.start_date is distinct from old.start_date
     or new.end_date is distinct from old.end_date
     or new.recorded_by is distinct from old.recorded_by then
    raise exception 'time-off requests are answered with the Approve and Deny buttons';
  end if;
  return new;
end; $$;

create or replace function public.manager_record_absence(
  _employee uuid,
  _kind text,
  _start date,
  _end date,
  _note text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid;
  tz text;
  new_id uuid;
  admin boolean;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _kind not in ('vacation', 'sick', 'family_leave', 'personal', 'other') then
    raise exception 'unknown absence type: %', _kind;
  end if;
  if _start is null or _end is null or _end < _start then
    raise exception 'the last day cannot be before the first';
  end if;
  if _end - _start > 366 then raise exception 'an absence can run at most a year'; end if;

  cid := public.member_company(_employee);
  if cid is null then raise exception 'that person is not in a company'; end if;
  admin := public.is_company_manager(caller, cid);
  if not (admin or public.can_approve_time_off(caller, _employee)) then
    raise exception 'not authorized';
  end if;

  if admin then
    insert into public.time_off_requests
      (company_id, employee_id, kind, start_date, end_date, status, note, recorded_by)
    values (cid, _employee, _kind, _start, _end, 'approved',
            nullif(trim(coalesce(_note, '')), ''), caller)
    returning id into new_id;

    select coalesce(c.timezone, 'UTC') into tz from public.companies c where c.id = cid;
    update public.shifts sh
       set employee_id = null
     where sh.employee_id = _employee
       and sh.company_id = cid
       and sh.ends_at > now()
       and (sh.starts_at at time zone tz)::date <= _end
       and (sh.ends_at   at time zone tz)::date >= _start;
    return new_id;
  end if;

  -- A supervisor: a pending request, routed like any other (the insert
  -- trigger calls route_request), with their own approval already given.
  if cid is distinct from public.current_company_id() then
    raise exception 'switch to that company first';
  end if;
  insert into public.time_off_requests
    (company_id, employee_id, kind, start_date, end_date, status, note, recorded_by)
  values (cid, _employee, _kind, _start, _end, 'pending',
          nullif(trim(coalesce(_note, '')), ''), caller)
  returning id into new_id;

  -- route_request asked the caller to approve what they just recorded.
  delete from public.notifications
   where user_id = caller and type = 'approval_needed' and created_at = now();

  -- Their approval; it moves to the admins once no other supervisor is left.
  -- (Without a row of their own — route_request found none — it is already
  -- with the admins or the other supervisors.)
  if exists (select 1 from public.request_approvals a
              where a.request_type = 'time_off' and a.request_id = new_id
                and a.approver_id = caller and a.stage = 'supervisor') then
    perform public.supervisor_decide('time_off', new_id, true, 'Recorded as an absence from the time card');
  end if;

  return new_id;
end;
$$;

create or replace function public.manager_remove_absence(_request uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  r public.time_off_requests;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  select * into r from public.time_off_requests where id = _request for update;
  if not found then raise exception 'absence not found'; end if;
  if r.status not in ('approved', 'pending') then raise exception 'this absence is already withdrawn'; end if;

  if public.is_company_manager(caller, r.company_id) then
    update public.time_off_requests set status = 'cancelled', approval_stage = null where id = _request;
    insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, before)
    values (r.company_id, caller, 'time_off.removed', 'time_off', r.id, to_jsonb(r));
    return;
  end if;

  if not (r.company_id = public.current_company_id()
          and public.can_approve_time_off(caller, r.employee_id)) then
    raise exception 'not authorized';
  end if;
  if r.status = 'approved' then
    raise exception 'Only an admin can remove time off that has been approved.';
  end if;
  if r.recorded_by is distinct from caller then
    raise exception 'Answer this request with Approve or Deny on the Time off page.';
  end if;

  update public.time_off_requests set status = 'cancelled', approval_stage = null where id = _request;
  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, before)
  values (r.company_id, caller, 'time_off.withdrawn', 'time_off', r.id, to_jsonb(r));
end;
$$;

revoke all on function public.manager_record_absence(uuid, text, date, date, text) from public, anon;
revoke all on function public.manager_remove_absence(uuid) from public, anon;
grant execute on function public.manager_record_absence(uuid, text, date, date, text) to authenticated;
grant execute on function public.manager_remove_absence(uuid) to authenticated;

commit;

notify pgrst, 'reload schema';
