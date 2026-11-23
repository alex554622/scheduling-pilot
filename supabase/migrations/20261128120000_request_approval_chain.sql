-- Time off and shift trades go through the department's supervisors, then an
-- admin.
--
--   1. The employee asks. (For a trade: the teammate accepts first, as before.)
--   2. Every supervisor whose assignment covers the employee must approve. With
--      two supervisors, both; with one, that one; with none, this step is
--      skipped. A trade asks the supervisors of both people in it. Nobody
--      approves a request they are part of.
--   3. Then a company admin gives the final answer. Nothing is approved, and no
--      schedule moves, until they do.
--   4. The outcome is sent to the employee, every supervisor on the request, and
--      (for a trade) the teammate.
--
-- A denial at any step ends the request. An admin may deny at any step; they
-- may approve only once the supervisors are done.
--
-- Who must approve is fixed when the request reaches step 2 (one row per
-- supervisor in request_approvals). A supervisor who has since lost that
-- person (assignment removed, role taken away, the person moved department)
-- no longer holds the request up: such a request moves on to the admin by
-- itself.
--
-- Every decision is a request_approvals row: who, which step, approved or
-- denied, when, and their comment. Rows are written only by the functions
-- here; nobody can insert or change one from the app.
--
-- Status values are unchanged, so nothing else that reads them changes:
-- time off stays 'pending' and a trade stays 'pending_supervisor' while
-- waiting; the new approval_stage column says on whom ('supervisors' or
-- 'admin').
--
-- Also closes a gap: the table policies let a requester or supervisor write a
-- status straight to the row. A guard trigger now refuses any status change
-- made directly from the app other than an employee cancelling their own trade.
--
-- Requests already pending when this runs go straight to the admin step,
-- where they were already waiting.
--
-- The "Supervisors can approve time off" company switch no longer applies to
-- requests (supervisors always take part). It still controls whether a
-- supervisor can record absences on a card.
--
-- Run after 20261127120000_org_structure_assignments.sql. Re-runnable; applied
-- by hand in Studio.

begin;

-- ---------------------------------------------------------- stage column ----

alter table public.time_off_requests add column if not exists approval_stage text;
alter table public.shift_trades      add column if not exists approval_stage text;

alter table public.time_off_requests drop constraint if exists time_off_requests_approval_stage_check;
alter table public.time_off_requests add constraint time_off_requests_approval_stage_check
  check (approval_stage is null or approval_stage in ('supervisors', 'admin'));
alter table public.shift_trades drop constraint if exists shift_trades_approval_stage_check;
alter table public.shift_trades add constraint shift_trades_approval_stage_check
  check (approval_stage is null or approval_stage in ('supervisors', 'admin'));

-- Already waiting: they were in the admin's queue.
update public.time_off_requests set approval_stage = 'admin'
 where status = 'pending' and approval_stage is null;
update public.shift_trades set approval_stage = 'admin'
 where status = 'pending_supervisor' and approval_stage is null;

-- ------------------------------------------------------------ decisions ----

create table if not exists public.request_approvals (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  request_type text not null check (request_type in ('time_off', 'shift_trade')),
  request_id   uuid not null,
  approver_id  uuid not null references auth.users(id) on delete cascade,
  stage        text not null check (stage in ('supervisor', 'admin')),
  -- null: still waiting on this person
  decision     text check (decision in ('approved', 'denied')),
  comment      text check (comment is null or char_length(comment) <= 1000),
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (request_type, request_id, approver_id, stage)
);
create index if not exists request_approvals_request_idx
  on public.request_approvals (request_type, request_id);
create index if not exists request_approvals_waiting_idx
  on public.request_approvals (approver_id) where decision is null;

alter table public.request_approvals enable row level security;
revoke all on public.request_approvals from anon, authenticated;
grant select on public.request_approvals to authenticated;
grant all on public.request_approvals to service_role;

-- --------------------------------------------------------------- helpers ----

-- The supervisors who must approve a request from _employee in _company: every
-- supervisor whose assignment in that company covers the employee's
-- department (or the employee by name). Never the employee themselves.
create or replace function public.request_supervisors(_company uuid, _employee uuid)
returns setof uuid language sql stable security definer set search_path = public
as $$
  select distinct a.supervisor_id
    from public.company_memberships m
    join public.supervisor_assignments a
      on a.company_id = m.company_id
     and a.department_id = m.department_id
     and (a.employee_id is null or a.employee_id = m.user_id)
   where m.company_id = _company
     and m.user_id = _employee
     and m.status = 'active'
     and a.supervisor_id <> _employee
     and public.is_supervisor(a.supervisor_id, _company)
     and public.is_member(a.supervisor_id, _company);
$$;

-- The people a request is about: the employee, or both sides of a trade.
create or replace function public.request_parties(_type text, _request uuid)
returns table (company_id uuid, employee_id uuid)
language sql stable security definer set search_path = public
as $$
  select r.company_id, r.employee_id
    from public.time_off_requests r
   where _type = 'time_off' and r.id = _request
  union
  select t.company_id, t.from_employee_id
    from public.shift_trades t
   where _type = 'shift_trade' and t.id = _request
  union
  select t.company_id, t.to_employee_id
    from public.shift_trades t
   where _type = 'shift_trade' and t.id = _request;
$$;

-- Does _user still supervise someone in this request (and is not in it)?
create or replace function public.still_approves(_type text, _request uuid, _user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select not exists (select 1 from public.request_parties(_type, _request) p
                      where p.employee_id = _user)
     and exists (select 1 from public.request_parties(_type, _request) p
                  where _user in (select public.request_supervisors(p.company_id, p.employee_id)));
$$;

-- Supervisors who have not answered yet and still supervise someone in it.
create or replace function public.outstanding_supervisors(_type text, _request uuid)
returns setof uuid language sql stable security definer set search_path = public
as $$
  select a.approver_id
    from public.request_approvals a
   where a.request_type = _type
     and a.request_id = _request
     and a.stage = 'supervisor'
     and a.decision is null
     and public.still_approves(_type, _request, a.approver_id);
$$;

-- Anyone with a part in the request: the people in it, its approvers, and the
-- company's admins. Decides who can read its decisions.
create or replace function public.can_see_request(_type text, _request uuid, _user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.request_parties(_type, _request) p
                  where p.employee_id = _user
                     or public.is_company_manager(_user, p.company_id))
      or exists (select 1 from public.request_approvals a
                  where a.request_type = _type and a.request_id = _request
                    and a.approver_id = _user);
$$;

drop policy if exists request_approvals_view on public.request_approvals;
create policy request_approvals_view on public.request_approvals for select to authenticated
  using (public.can_see_request(request_type, request_id, auth.uid()));

create or replace function public.member_name(_user uuid)
returns text language sql stable security definer set search_path = public
as $$
  select coalesce(nullif(trim(p.full_name), ''), 'A teammate')
    from public.profiles p where p.id = _user;
$$;

-- One line describing a request, for notifications.
create or replace function public.request_summary(_type text, _request uuid)
returns text language plpgsql stable security definer set search_path = public
as $$
declare
  r public.time_off_requests;
  t public.shift_trades;
  s public.shifts;
begin
  if _type = 'time_off' then
    select * into r from public.time_off_requests where id = _request;
    return coalesce(public.member_name(r.employee_id), 'A teammate') || '''s '
      || replace(r.kind, '_', ' ') || ' request for '
      || to_char(r.start_date, 'Mon FMDD')
      || case when r.end_date <> r.start_date then ' – ' || to_char(r.end_date, 'Mon FMDD') else '' end;
  end if;
  select * into t from public.shift_trades where id = _request;
  select * into s from public.shifts where id = t.shift_id;
  return 'The shift trade between ' || coalesce(public.member_name(t.from_employee_id), 'a teammate')
    || ' and ' || coalesce(public.member_name(t.to_employee_id), 'a teammate')
    || coalesce(' for ' || to_char(s.starts_at, 'Mon FMDD'), '');
end; $$;

create or replace function public.notify_company_admins(
  _company uuid, _type text, _title text, _body text, _link text, _skip uuid default null
) returns void language sql security definer set search_path = public
as $$
  insert into public.notifications (user_id, type, title, body, link, company_id)
  select distinct r.user_id, _type, _title, _body, _link, _company
    from public.user_roles r
   where r.company_id = _company
     and r.role = 'company_admin'::public.app_role
     and r.user_id is distinct from _skip;
$$;

-- --------------------------------------------------------------- routing ----

-- Put a request in front of its supervisors, or the admins if it has none.
-- Called when a time-off request is made and when a trade is accepted.
create or replace function public.route_request(_type text, _request uuid)
returns text language plpgsql security definer set search_path = public
as $$
declare
  cid uuid;
  stage text;
  summary text;
  link text := case when _type = 'time_off' then '/time-off' else '/trades' end;
begin
  select p.company_id into cid from public.request_parties(_type, _request) p limit 1;
  if cid is null then raise exception 'request not found'; end if;

  insert into public.request_approvals (company_id, request_type, request_id, approver_id, stage)
  select distinct cid, _type, _request, s.sup, 'supervisor'
    from public.request_parties(_type, _request) p
    cross join lateral public.request_supervisors(p.company_id, p.employee_id) as s(sup)
   where s.sup not in (select p2.employee_id from public.request_parties(_type, _request) p2)
  on conflict do nothing;

  stage := case when exists (select 1 from public.outstanding_supervisors(_type, _request))
                then 'supervisors' else 'admin' end;

  if _type = 'time_off' then
    update public.time_off_requests set approval_stage = stage where id = _request;
  else
    update public.shift_trades set approval_stage = stage where id = _request;
  end if;

  summary := public.request_summary(_type, _request);
  if stage = 'supervisors' then
    insert into public.notifications (user_id, type, title, body, link, company_id)
    select o, 'approval_needed', 'Approval needed',
           summary || ' needs your approval.', link, cid
      from public.outstanding_supervisors(_type, _request) as o;
  else
    perform public.notify_company_admins(cid, 'approval_needed', 'Final approval needed',
                                         summary || ' is ready for your final approval.', link);
  end if;
  return stage;
end; $$;

-- A request whose remaining supervisors no longer supervise anyone in it moves
-- on to the admin. Run after anything that can take a supervisor away.
create or replace function public.advance_stalled_requests(_company uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  rid uuid;
begin
  for rid in select r.id from public.time_off_requests r
              where r.company_id = _company and r.status = 'pending'
                and r.approval_stage = 'supervisors'
  loop
    if not exists (select 1 from public.outstanding_supervisors('time_off', rid)) then
      update public.time_off_requests set approval_stage = 'admin' where id = rid;
      perform public.notify_company_admins(_company, 'approval_needed', 'Final approval needed',
        public.request_summary('time_off', rid) || ' is ready for your final approval.', '/time-off');
    end if;
  end loop;

  for rid in select t.id from public.shift_trades t
              where t.company_id = _company and t.status = 'pending_supervisor'
                and t.approval_stage = 'supervisors'
  loop
    if not exists (select 1 from public.outstanding_supervisors('shift_trade', rid)) then
      update public.shift_trades set approval_stage = 'admin' where id = rid;
      perform public.notify_company_admins(_company, 'approval_needed', 'Final approval needed',
        public.request_summary('shift_trade', rid) || ' is ready for your final approval.', '/trades');
    end if;
  end loop;
end; $$;

create or replace function public.advance_stalled_requests_trigger()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  perform public.advance_stalled_requests(coalesce(old.company_id, new.company_id));
  return null;
end; $$;

drop trigger if exists advance_requests_on_assignment on public.supervisor_assignments;
create trigger advance_requests_on_assignment
  after update or delete on public.supervisor_assignments
  for each row execute function public.advance_stalled_requests_trigger();

drop trigger if exists advance_requests_on_role on public.user_roles;
create trigger advance_requests_on_role
  after update or delete on public.user_roles
  for each row execute function public.advance_stalled_requests_trigger();

drop trigger if exists advance_requests_on_membership on public.company_memberships;
create trigger advance_requests_on_membership
  after update of department_id, status or delete on public.company_memberships
  for each row execute function public.advance_stalled_requests_trigger();

-- A new time-off request goes to its supervisors as soon as it is made.
create or replace function public.time_off_route_on_insert()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'pending' then
    perform public.route_request('time_off', new.id);
  end if;
  return null;
end; $$;

drop trigger if exists time_off_route_on_insert on public.time_off_requests;
create trigger time_off_route_on_insert
  after insert on public.time_off_requests
  for each row execute function public.time_off_route_on_insert();

-- --------------------------------------------------------------- guards ----
--
-- Not security definer, so current_user is whoever is writing. Writes from the
-- app run as 'authenticated'; the functions in this file and the rest of the
-- RPCs run as their owner and pass straight through.

create or replace function public.time_off_requests_guard()
returns trigger language plpgsql set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.approval_stage := null;
    return new;
  end if;
  if new.status is distinct from old.status
     or new.approval_stage is distinct from old.approval_stage
     or new.employee_id is distinct from old.employee_id
     or new.company_id is distinct from old.company_id
     or new.start_date is distinct from old.start_date
     or new.end_date is distinct from old.end_date then
    raise exception 'time-off requests are answered with the Approve and Deny buttons';
  end if;
  return new;
end; $$;

drop trigger if exists time_off_requests_guard on public.time_off_requests;
create trigger time_off_requests_guard
  before insert or update on public.time_off_requests
  for each row execute function public.time_off_requests_guard();

create or replace function public.shift_trades_guard()
returns trigger language plpgsql set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'pending_employee';
    new.approval_stage := null;
    return new;
  end if;
  if new.shift_id is distinct from old.shift_id
     or new.to_shift_id is distinct from old.to_shift_id
     or new.from_employee_id is distinct from old.from_employee_id
     or new.to_employee_id is distinct from old.to_employee_id
     or new.company_id is distinct from old.company_id
     or new.approval_stage is distinct from old.approval_stage then
    raise exception 'a trade cannot be changed once proposed; cancel it and propose a new one';
  end if;
  if new.status is distinct from old.status then
    -- The one change made from the app: the proposer withdrawing it.
    if not (new.status = 'cancelled'
            and old.status in ('pending_employee', 'pending_supervisor')
            and old.from_employee_id = auth.uid()) then
      raise exception 'trades are answered with the Accept, Approve and Deny buttons';
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists shift_trades_guard on public.shift_trades;
create trigger shift_trades_guard
  before insert or update on public.shift_trades
  for each row execute function public.shift_trades_guard();

-- ------------------------------------------------- supervisor decision ----

create or replace function public.supervisor_decide(
  _type text, _request uuid, _approve boolean, _comment text default null
) returns text
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid;
  status_now text;
  stage_now text;
  summary text;
  note text := nullif(trim(coalesce(_comment, '')), '');
  link text := case when _type = 'time_off' then '/time-off' else '/trades' end;
  result text;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _type not in ('time_off', 'shift_trade') then raise exception 'unknown request type'; end if;

  if _type = 'time_off' then
    select company_id, status, approval_stage into cid, status_now, stage_now
      from public.time_off_requests where id = _request for update;
    if not found then raise exception 'request not found'; end if;
    if status_now <> 'pending' then raise exception 'this request has already been answered'; end if;
  else
    select company_id, status, approval_stage into cid, status_now, stage_now
      from public.shift_trades where id = _request for update;
    if not found then raise exception 'trade not found'; end if;
    if status_now <> 'pending_supervisor' then raise exception 'this trade is not waiting for a supervisor'; end if;
    perform public.require_capability(cid, 'shift_trades', 'Shift trades');
  end if;
  if cid <> public.current_company_id() then raise exception 'switch to that company first'; end if;
  if stage_now is distinct from 'supervisors' then
    raise exception 'this request has moved on to an admin';
  end if;

  if not exists (select 1 from public.request_approvals a
                  where a.request_type = _type and a.request_id = _request
                    and a.approver_id = caller and a.stage = 'supervisor') then
    raise exception 'you are not an approver on this request';
  end if;
  if exists (select 1 from public.request_approvals a
              where a.request_type = _type and a.request_id = _request
                and a.approver_id = caller and a.stage = 'supervisor'
                and a.decision is not null) then
    raise exception 'you have already answered this request';
  end if;
  if not public.still_approves(_type, _request, caller) then
    raise exception 'you no longer supervise anyone in this request';
  end if;

  update public.request_approvals
     set decision = case when _approve then 'approved' else 'denied' end,
         comment = note,
         decided_at = now()
   where request_type = _type and request_id = _request
     and approver_id = caller and stage = 'supervisor';

  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, after)
  values (cid, caller,
          _type || '.supervisor_' || case when _approve then 'approved' else 'denied' end,
          _type, _request, jsonb_build_object('comment', note));

  summary := public.request_summary(_type, _request);

  if not _approve then
    if _type = 'time_off' then
      update public.time_off_requests set status = 'denied', approval_stage = null where id = _request;
    else
      update public.shift_trades set status = 'denied', approval_stage = null where id = _request;
    end if;
    -- The people in it, and the other supervisors who no longer need to act.
    insert into public.notifications (user_id, type, title, body, link, company_id)
    select u, case when _type = 'time_off' then 'time_off_denied' else 'trade_denied' end,
           case when _type = 'time_off' then 'Time off denied' else 'Shift trade denied' end,
           summary || ' was denied by ' || public.member_name(caller)
             || coalesce(': "' || note || '"', '.'),
           link, cid
      from (select p.employee_id as u from public.request_parties(_type, _request) p
            union
            select a.approver_id from public.request_approvals a
             where a.request_type = _type and a.request_id = _request
               and a.approver_id <> caller) x;
    return 'denied';
  end if;

  if exists (select 1 from public.outstanding_supervisors(_type, _request)) then
    result := 'supervisors';
  else
    result := 'admin';
    if _type = 'time_off' then
      update public.time_off_requests set approval_stage = 'admin' where id = _request;
    else
      update public.shift_trades set approval_stage = 'admin' where id = _request;
    end if;
    perform public.notify_company_admins(cid, 'approval_needed', 'Final approval needed',
      summary || ' was approved by its supervisors and is ready for your final approval.', link);
  end if;
  return result;
end; $$;

-- Writes the admin's decision row and tells everyone involved. Shared by the
-- two final-decision functions below.
create or replace function public.record_admin_decision(
  _type text, _request uuid, _company uuid, _approve boolean, _comment text
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  summary text := public.request_summary(_type, _request);
  link text := case when _type = 'time_off' then '/time-off' else '/trades' end;
  word text := case when _approve then 'approved' else 'denied' end;
begin
  insert into public.request_approvals
    (company_id, request_type, request_id, approver_id, stage, decision, comment, decided_at)
  values (_company, _type, _request, caller, 'admin', word, _comment, now())
  on conflict (request_type, request_id, approver_id, stage)
  do update set decision = excluded.decision, comment = excluded.comment, decided_at = excluded.decided_at;

  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, after)
  values (_company, caller, _type || '.admin_' || word, _type, _request,
          jsonb_build_object('comment', _comment));

  -- The people in it and every supervisor on it. Supervisors who never got to
  -- answer (an admin denied first) are told too.
  insert into public.notifications (user_id, type, title, body, link, company_id)
  select u,
         case when _type = 'time_off' then 'time_off_' else 'trade_' end || word,
         case when _type = 'time_off' then 'Time off ' else 'Shift trade ' end || word,
         summary || ' was ' || word || ' by ' || public.member_name(caller)
           || coalesce(': "' || _comment || '"', '.'),
         link, _company
    from (select p.employee_id as u from public.request_parties(_type, _request) p
          union
          select a.approver_id from public.request_approvals a
           where a.request_type = _type and a.request_id = _request
             and a.stage = 'supervisor') x
   where u <> caller;
end; $$;

-- ------------------------------------------------ admin: time off final ----

drop function if exists public.decide_time_off(uuid, boolean);

create or replace function public.decide_time_off(
  _request uuid, _approve boolean, _comment text default null
) returns int
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  r public.time_off_requests;
  tz text;
  opened int := 0;
  waiting text;
  note text := nullif(trim(coalesce(_comment, '')), '');
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select * into r from public.time_off_requests where id = _request for update;
  if not found then raise exception 'request not found'; end if;
  if not public.is_company_manager(caller, r.company_id) then
    raise exception 'only a company admin gives the final answer';
  end if;
  if r.status <> 'pending' then raise exception 'this request has already been answered'; end if;

  if _approve then
    select string_agg(public.member_name(o), ', ') into waiting
      from public.outstanding_supervisors('time_off', _request) o;
    if waiting is not null then
      raise exception 'still waiting on supervisor approval from %', waiting;
    end if;
  end if;

  update public.time_off_requests
     set status = case when _approve then 'approved' else 'denied' end,
         approval_stage = null
   where id = _request;

  if _approve then
    select coalesce(c.timezone, 'UTC') into tz from public.companies c where c.id = r.company_id;

    update public.shifts sh
       set employee_id = null
     where sh.employee_id = r.employee_id
       and sh.company_id = r.company_id
       and sh.ends_at > now()
       and (sh.starts_at at time zone tz)::date <= r.end_date
       and (sh.ends_at   at time zone tz)::date >= r.start_date;
    get diagnostics opened = row_count;
  end if;

  perform public.record_admin_decision('time_off', _request, r.company_id, _approve, note);
  return opened;
end; $$;

-- ---------------------------------------------------- admin: trade final ----

drop function if exists public.approve_trade(uuid, boolean);

create or replace function public.approve_trade(
  _trade uuid, _approve boolean, _comment text default null
) returns public.shift_trades
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  t public.shift_trades;
  from_shift public.shifts;
  to_shift public.shifts;
  blocker text;
  waiting text;
  note text := nullif(trim(coalesce(_comment, '')), '');
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select * into t from public.shift_trades where id = _trade for update;
  if not found then raise exception 'trade not found'; end if;
  if not public.is_company_manager(caller, t.company_id) then
    raise exception 'only a company admin gives the final answer';
  end if;
  if t.status <> 'pending_supervisor' then
    raise exception 'this trade is not waiting for approval';
  end if;

  perform public.require_capability(t.company_id, 'shift_trades', 'Shift trades');

  if not _approve then
    update public.shift_trades set status = 'denied', approval_stage = null
     where id = _trade returning * into t;
    perform public.record_admin_decision('shift_trade', _trade, t.company_id, false, note);
    return t;
  end if;

  select string_agg(public.member_name(o), ', ') into waiting
    from public.outstanding_supervisors('shift_trade', _trade) o;
  if waiting is not null then
    raise exception 'still waiting on supervisor approval from %', waiting;
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

  if not public.is_member(t.to_employee_id, t.company_id) then
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

  update public.shift_trades set status = 'approved', approval_stage = null
   where id = _trade returning * into t;

  insert into public.audit_logs (company_id, actor_id, action, entity_type, entity_id, after)
  values (t.company_id, caller, 'shift_trade.approved', 'shift_trade', t.id,
          jsonb_build_object('shift_id', t.shift_id, 'to_shift_id', t.to_shift_id,
                             'from_employee', t.from_employee_id, 'to_employee', t.to_employee_id));

  perform public.record_admin_decision('shift_trade', _trade, t.company_id, true, note);
  return t;
end; $$;

-- ------------------------------------------------ teammate's answer ----

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

  if not _accept then
    update public.shift_trades set status = 'declined' where id = _trade returning * into t;
    insert into public.notifications (user_id, type, title, body, link, company_id)
    values (t.from_employee_id, 'trade_declined', 'Shift trade declined',
            public.member_name(caller) || ' declined your shift trade.', '/trades', t.company_id);
    return t;
  end if;

  update public.shift_trades set status = 'pending_supervisor' where id = _trade;
  perform public.route_request('shift_trade', _trade);
  select * into t from public.shift_trades where id = _trade;
  return t;
end; $$;

-- ---------------------------------------------------------------- grants ----

revoke all on function public.request_supervisors(uuid, uuid) from public, anon;
revoke all on function public.request_parties(text, uuid) from public, anon;
revoke all on function public.still_approves(text, uuid, uuid) from public, anon;
revoke all on function public.outstanding_supervisors(text, uuid) from public, anon;
revoke all on function public.can_see_request(text, uuid, uuid) from public, anon;
revoke all on function public.member_name(uuid) from public, anon, authenticated;
revoke all on function public.request_summary(text, uuid) from public, anon, authenticated;
revoke all on function public.notify_company_admins(uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.route_request(text, uuid) from public, anon, authenticated;
revoke all on function public.advance_stalled_requests(uuid) from public, anon, authenticated;
revoke all on function public.advance_stalled_requests_trigger() from public, anon, authenticated;
revoke all on function public.time_off_route_on_insert() from public, anon, authenticated;
revoke all on function public.record_admin_decision(text, uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.supervisor_decide(text, uuid, boolean, text) from public, anon;
revoke all on function public.decide_time_off(uuid, boolean, text) from public, anon;
revoke all on function public.approve_trade(uuid, boolean, text) from public, anon;
revoke all on function public.respond_to_trade(uuid, boolean) from public, anon;

-- RLS on request_approvals calls can_see_request, so the querying role needs it.
grant execute on function public.request_parties(text, uuid) to authenticated;
grant execute on function public.request_supervisors(uuid, uuid) to authenticated;
grant execute on function public.still_approves(text, uuid, uuid) to authenticated;
grant execute on function public.outstanding_supervisors(text, uuid) to authenticated;
grant execute on function public.can_see_request(text, uuid, uuid) to authenticated;
grant execute on function public.supervisor_decide(text, uuid, boolean, text) to authenticated;
grant execute on function public.decide_time_off(uuid, boolean, text) to authenticated;
grant execute on function public.approve_trade(uuid, boolean, text) to authenticated;
grant execute on function public.respond_to_trade(uuid, boolean) to authenticated;

commit;

notify pgrst, 'reload schema';
