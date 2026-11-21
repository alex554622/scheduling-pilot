-- Admins record absences straight onto someone's time card.
--
-- Someone calls in sick, goes on family leave or takes vacation, and the
-- admin marks it from the Timecards page. It is an ordinary time_off_requests
-- row, so it shows on the Time off page, in the reports and on the schedule as
-- well as on the time card. It goes in already approved (the admin is the one
-- who would approve it), and it frees the person's upcoming shifts on those
-- days just as approving a request does.
--
-- "family_leave" joins vacation / sick / personal / other as a kind. The
-- column has no check constraint, so the existing rows and the employee's own
-- request form need no change here.
--
-- Re-runnable; applied by hand in Studio.

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
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _kind not in ('vacation', 'sick', 'family_leave', 'personal', 'other') then
    raise exception 'unknown absence type: %', _kind;
  end if;
  if _start is null or _end is null or _end < _start then
    raise exception 'the last day cannot be before the first';
  end if;
  if _end - _start > 366 then raise exception 'an absence can run at most a year'; end if;

  select p.company_id into cid from public.profiles p where p.id = _employee;
  if cid is null then raise exception 'that person is not in a company'; end if;
  if not public.is_company_manager(caller, cid) then raise exception 'not authorized'; end if;

  insert into public.time_off_requests (company_id, employee_id, kind, start_date, end_date, status, note)
  values (cid, _employee, _kind, _start, _end, 'approved', nullif(trim(coalesce(_note, '')), ''))
  returning id into new_id;

  -- Same as decide_time_off: their shifts still ahead on those days become
  -- open shifts. Worked shifts are history and stay theirs.
  select coalesce(c.timezone, 'UTC') into tz from public.companies c where c.id = cid;
  update public.shifts sh
     set employee_id = null
   where sh.employee_id = _employee
     and sh.company_id = cid
     and sh.ends_at > now()
     and (sh.starts_at at time zone tz)::date <= _end
     and (sh.ends_at   at time zone tz)::date >= _start;

  return new_id;
end;
$$;

-- Taking an absence back off the card. The row is kept, marked cancelled, so
-- the reports still show it was entered and withdrawn. Shifts it freed stay
-- open: someone may already have picked them up.
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
  if not public.is_company_manager(caller, r.company_id) then raise exception 'not authorized'; end if;
  if r.status not in ('approved', 'pending') then raise exception 'this absence is already withdrawn'; end if;
  update public.time_off_requests set status = 'cancelled' where id = _request;
end;
$$;

revoke all on function public.manager_record_absence(uuid, text, date, date, text) from public, anon;
revoke all on function public.manager_remove_absence(uuid) from public, anon;
grant execute on function public.manager_record_absence(uuid, text, date, date, text) to authenticated;
grant execute on function public.manager_remove_absence(uuid) to authenticated;

notify pgrst, 'reload schema';
