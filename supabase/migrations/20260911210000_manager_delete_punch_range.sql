-- Clearing a stretch of timecard in one go.
--
-- `authenticated` has select and insert on time_punches and nothing else, so a
-- correction always goes through a manager_* function: it checks the caller
-- really manages that company, demands a reason, and writes an audit row for
-- every punch it removes. Deleting a week or a month is the same operation
-- repeated, so it gets the same treatment rather than a direct delete.
--
-- `_user` null means everyone in the company.
--
-- Re-runnable; applied by hand in Studio.

create or replace function public.manager_delete_punch_range(
  _company uuid,
  _user uuid,
  _from timestamptz,
  _to timestamptz,
  _reason text
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  deleted integer := 0;
  r public.time_punches;
begin
  if caller is null then raise exception 'not authenticated'; end if;
  if _reason is null or length(trim(_reason)) < 3 then
    raise exception 'a reason (min 3 chars) is required';
  end if;
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
      r.id, r.company_id, r.user_id, caller, 'delete', trim(_reason), to_jsonb(r), null
    );
    deleted := deleted + 1;
  end loop;

  return deleted;
end; $$;

revoke all on function public.manager_delete_punch_range(uuid, uuid, timestamptz, timestamptz, text)
  from public, anon;
grant execute on function public.manager_delete_punch_range(uuid, uuid, timestamptz, timestamptz, text)
  to authenticated;
