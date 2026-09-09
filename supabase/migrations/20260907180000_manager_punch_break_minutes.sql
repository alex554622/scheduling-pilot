-- Let a manager correct a break's LENGTH, not just its timestamps.
--
-- `break_minutes` is what marks a break paid (10) or unpaid (30 / 60), so every
-- hours total on a timecard depends on it — but the two manager RPCs never took
-- it, which left the one field that changes the maths uneditable. Both gain an
-- optional `_minutes`.
--
-- These are replaced rather than overloaded: two candidates differing only by a
-- defaulted trailing argument make a PostgREST call with four arguments
-- ambiguous, and the four-argument form is what the punch-corrections page
-- sends today.

drop function if exists public.manager_update_punch(uuid, timestamptz, text, text);

create function public.manager_update_punch(
  _id uuid,
  _at timestamptz,
  _kind text,
  _reason text,
  _minutes int default null
) returns public.time_punches
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  old_row public.time_punches;
  new_row public.time_punches;
  next_minutes int;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _reason is null or length(trim(_reason)) < 3 then
    raise exception 'a reason (min 3 chars) is required';
  end if;
  if _kind not in ('in','out','break_start','break_end') then
    raise exception 'invalid kind';
  end if;
  if _minutes is not null and _minutes not in (10, 30, 60) then
    raise exception 'break length must be 10, 30 or 60 minutes';
  end if;

  select * into old_row from public.time_punches where id = _id for update;
  if not found then raise exception 'punch not found'; end if;
  if not public.is_company_manager(caller, old_row.company_id) then
    raise exception 'not authorized';
  end if;

  -- Only a break carries a length. Retyping a punch to 'in' or 'out' clears it
  -- so a stale 10 can't keep counting the time as a paid break.
  if _kind in ('break_start','break_end') then
    next_minutes := coalesce(_minutes, old_row.break_minutes);
  else
    next_minutes := null;
  end if;

  update public.time_punches
    set at = coalesce(_at, at),
        kind = _kind,
        break_minutes = next_minutes
    where id = _id
    returning * into new_row;

  insert into public.time_punch_audit (punch_id, company_id, user_id, actor_id, action, reason, before, after)
  values (_id, old_row.company_id, old_row.user_id, caller, 'update', trim(_reason),
          to_jsonb(old_row), to_jsonb(new_row));

  return new_row;
end;
$$;

revoke all on function public.manager_update_punch(uuid, timestamptz, text, text, int) from public, anon;
grant execute on function public.manager_update_punch(uuid, timestamptz, text, text, int) to authenticated;

drop function if exists public.manager_insert_punch(uuid, timestamptz, text, text);

create function public.manager_insert_punch(
  _user_id uuid,
  _at timestamptz,
  _kind text,
  _reason text,
  _minutes int default null
) returns public.time_punches
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid;
  new_row public.time_punches;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _reason is null or length(trim(_reason)) < 3 then
    raise exception 'a reason (min 3 chars) is required';
  end if;
  if _kind not in ('in','out','break_start','break_end') then
    raise exception 'invalid kind';
  end if;
  if _at is null then raise exception 'time required'; end if;
  if _minutes is not null and _minutes not in (10, 30, 60) then
    raise exception 'break length must be 10, 30 or 60 minutes';
  end if;

  select company_id into cid from public.profiles where id = _user_id;
  if cid is null then raise exception 'employee has no company'; end if;
  if not public.is_company_manager(caller, cid) then
    raise exception 'not authorized';
  end if;

  insert into public.time_punches (user_id, company_id, kind, at, within_geofence, break_minutes)
  values (
    _user_id, cid, _kind, _at, true,
    case when _kind in ('break_start','break_end') then _minutes else null end
  )
  returning * into new_row;

  insert into public.time_punch_audit (punch_id, company_id, user_id, actor_id, action, reason, before, after)
  values (new_row.id, cid, _user_id, caller, 'create', trim(_reason), null, to_jsonb(new_row));

  return new_row;
end;
$$;

revoke all on function public.manager_insert_punch(uuid, timestamptz, text, text, int) from public, anon;
grant execute on function public.manager_insert_punch(uuid, timestamptz, text, text, int) to authenticated;

-- PostgREST caches the function signatures it exposes.
notify pgrst, 'reload schema';
