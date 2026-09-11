-- "Delete permanently" for a former employee.
--
-- remove_company_member keeps a separation record so the person stays in the
-- Former employees list and can be rehired in one click, with their old
-- department, position and roles restored. Sometimes that is not wanted: a
-- test account, a mistake, or someone who is never coming back.
--
-- This drops the record. The account itself is untouched: it belongs to the
-- person, not to the company, and they keep it with no tie to this company.
-- If they ever come back they join with the company code like anyone new.
--
-- Re-runnable; applied by hand in Studio.

create or replace function public.forget_former_member(_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid;
begin
  if caller is null then raise exception 'not authenticated'; end if;

  select s.company_id into cid
    from public.employment_separations s
   where s.user_id = _user
     and (public.has_role(caller, 'company_admin'::public.app_role, s.company_id)
          or public.has_role(caller, 'super_admin'::public.app_role))
   order by s.separated_at desc
   limit 1;

  if cid is null then
    raise exception 'No former employee record here that you can delete.';
  end if;

  -- A current member is not a former one; they are removed first, which is the
  -- step that records the reason and snapshots their details.
  if exists (select 1 from public.profiles p where p.id = _user and p.company_id = cid) then
    raise exception 'That person works here right now. Remove them from the company first.';
  end if;

  delete from public.employment_separations where user_id = _user and company_id = cid;

  -- Their shared clock-in code was this company's to hand out; free it so the
  -- four digits can be reused. Guarded because the shared clock-in tables are
  -- a separate migration that may not have been applied yet.
  if to_regclass('public.employee_clock_codes') is not null then
    execute 'delete from public.employee_clock_codes where user_id = $1 and company_id = $2'
      using _user, cid;
  end if;
end; $$;

revoke all on function public.forget_former_member(uuid) from public, anon;
grant execute on function public.forget_former_member(uuid) to authenticated;
