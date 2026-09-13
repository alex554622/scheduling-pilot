-- A correction no longer has to be explained before it can be made.
--
-- Demanding three characters before a manager could fix an obvious typo bought
-- nothing: the field filled up with "fix", "typo" and "asdf", which is worse
-- than an empty one because it reads like a real explanation. What the audit
-- trail is actually for — who changed what, from what, to what, and when — was
-- never coming from that box; it comes from actor_id, before and after, which
-- are still written on every single change.
--
-- The reason is now optional and stored as '' when it is not given.
-- time_punch_audit.reason stays NOT NULL: no audit row loses its column, and
-- nothing that reads the log has to cope with a null.
--
-- Every other check is untouched — the caller must still be authenticated, must
-- still manage that company, and a punch must still exist to be changed.
--
-- Re-runnable; applied by hand in Studio.

-- ---------------------------------------------------------------- update ----

drop function if exists public.manager_update_punch(uuid, timestamptz, text, text);

create or replace function public.manager_update_punch(
  _id uuid,
  _at timestamptz,
  _kind text,
  _reason text default null,
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
  values (_id, old_row.company_id, old_row.user_id, caller, 'update', coalesce(trim(_reason), ''),
          to_jsonb(old_row), to_jsonb(new_row));

  return new_row;
end;
$$;

revoke all on function public.manager_update_punch(uuid, timestamptz, text, text, int) from public, anon;
grant execute on function public.manager_update_punch(uuid, timestamptz, text, text, int) to authenticated;

-- ---------------------------------------------------------------- insert ----

drop function if exists public.manager_insert_punch(uuid, timestamptz, text, text);

create or replace function public.manager_insert_punch(
  _user_id uuid,
  _at timestamptz,
  _kind text,
  _reason text default null,
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
  values (new_row.id, cid, _user_id, caller, 'create', coalesce(trim(_reason), ''), null, to_jsonb(new_row));

  return new_row;
end;
$$;

revoke all on function public.manager_insert_punch(uuid, timestamptz, text, text, int) from public, anon;
grant execute on function public.manager_insert_punch(uuid, timestamptz, text, text, int) to authenticated;

-- ---------------------------------------------------------------- delete ----

create or replace function public.manager_delete_punch(
  _id uuid,
  _reason text default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  old_row public.time_punches;
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select * into old_row from public.time_punches where id = _id for update;
  if not found then raise exception 'punch not found'; end if;
  if not public.is_company_manager(caller, old_row.company_id) then
    raise exception 'not authorized';
  end if;

  delete from public.time_punches where id = _id;

  insert into public.time_punch_audit (punch_id, company_id, user_id, actor_id, action, reason, before, after)
  values (_id, old_row.company_id, old_row.user_id, caller, 'delete', coalesce(trim(_reason), ''),
          to_jsonb(old_row), null);
end;
$$;

revoke all on function public.manager_delete_punch(uuid, text) from public, anon;
grant execute on function public.manager_delete_punch(uuid, text) to authenticated;

-- ----------------------------------------------------------- delete range ----
--
-- Clearing a stretch of timecard in one go. `_user` null means everyone in the
-- company. The double confirmation in the app is what guards this, not a typed
-- reason, and every removed punch still lands in the audit log.

create or replace function public.manager_delete_punch_range(
  _company uuid,
  _user uuid,
  _from timestamptz,
  _to timestamptz,
  _reason text default null
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  deleted integer := 0;
  r public.time_punches;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _to <= _from then
    raise exception 'the end of the range must come after its start';
  end if;
  if not (public.is_company_manager(caller, _company)
          or public.has_role(caller, 'super_admin'::public.app_role)) then
    raise exception 'not authorized';
  end if;
  if _user is not null and not exists (
    select 1 from public.profiles where id = _user and company_id = _company
  ) then
    raise exception 'that person is not in that company';
  end if;

  for r in
    select * from public.time_punches
     where company_id = _company
       and at >= _from
       and at < _to
       and (_user is null or user_id = _user)
     for update
  loop
    delete from public.time_punches where id = r.id;
    insert into public.time_punch_audit (
      punch_id, company_id, user_id, actor_id, action, reason, before, after
    ) values (
      r.id, r.company_id, r.user_id, caller, 'delete', coalesce(trim(_reason), ''), to_jsonb(r), null
    );
    deleted := deleted + 1;
  end loop;

  return deleted;
end; $$;

revoke all on function public.manager_delete_punch_range(uuid, uuid, timestamptz, timestamptz, text)
  from public, anon;
grant execute on function public.manager_delete_punch_range(uuid, uuid, timestamptz, timestamptz, text)
  to authenticated;

-- PostgREST caches the function signatures it exposes.
notify pgrst, 'reload schema';
