-- Make an approved day off actually take the person off the schedule.
--
-- Three things were wrong with time off:
--
--   1. Approving a request only flipped its status. Any shift the employee was
--      already rostered for on those days stayed theirs, so the schedule still
--      expected them in on their vacation.
--   2. An employee could not withdraw their own pending request — only a
--      manager can update the row, and there was no cancel path at all.
--   3. Nobody was told the outcome; the employee had to keep checking the page.
--
-- Decisions and cancellations now go through these functions. Approval turns
-- the employee's upcoming shifts on those dates into open shifts in the same
-- transaction, so the gap shows up on the schedule for someone to pick up.

create or replace function public.decide_time_off(_request uuid, _approve boolean)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  r public.time_off_requests;
  tz text;
  opened int := 0;
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select * into r from public.time_off_requests where id = _request for update;
  if not found then raise exception 'request not found'; end if;
  if not public.is_company_manager(caller, r.company_id) then raise exception 'not authorized'; end if;
  if r.status <> 'pending' then raise exception 'this request has already been answered'; end if;

  update public.time_off_requests
     set status = case when _approve then 'approved' else 'denied' end
   where id = _request;

  if _approve then
    select coalesce(c.timezone, 'UTC') into tz from public.companies c where c.id = r.company_id;

    -- Only shifts still ahead; worked shifts are history and stay attributed.
    update public.shifts sh
       set employee_id = null
     where sh.employee_id = r.employee_id
       and sh.company_id = r.company_id
       and sh.ends_at > now()
       and (sh.starts_at at time zone tz)::date <= r.end_date
       and (sh.ends_at   at time zone tz)::date >= r.start_date;
    get diagnostics opened = row_count;
  end if;

  insert into public.notifications (user_id, type, title, body, link)
  values (
    r.employee_id,
    'time_off_' || case when _approve then 'approved' else 'denied' end,
    'Time off ' || case when _approve then 'approved' else 'denied' end,
    'Your ' || r.kind || ' request for '
      || to_char(r.start_date, 'Mon FMDD')
      || case when r.end_date <> r.start_date then ' – ' || to_char(r.end_date, 'Mon FMDD') else '' end
      || ' was ' || case when _approve then 'approved.' else 'denied.' end,
    '/time-off'
  );

  return opened;
end;
$$;

create or replace function public.cancel_time_off(_request uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  r public.time_off_requests;
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select * into r from public.time_off_requests where id = _request for update;
  if not found then raise exception 'request not found'; end if;
  if r.employee_id <> caller then raise exception 'you can only cancel your own request'; end if;
  if r.status <> 'pending' then raise exception 'only a pending request can be cancelled'; end if;

  update public.time_off_requests set status = 'cancelled' where id = _request;
end;
$$;

revoke all on function public.decide_time_off(uuid, boolean) from public, anon;
revoke all on function public.cancel_time_off(uuid) from public, anon;
grant execute on function public.decide_time_off(uuid, boolean) to authenticated;
grant execute on function public.cancel_time_off(uuid) to authenticated;

notify pgrst, 'reload schema';
