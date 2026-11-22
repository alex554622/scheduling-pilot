-- Acts as the supervisor "test a" and reports what the database lets them do.
-- Safe to run on the live database: every write it attempts is rolled back
-- straight away, whether it was allowed or not. Prints one row.

select set_config('request.jwt.claims',
  '{"sub":"65032633-4597-4f0c-853a-6fbe7d7028cb","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '65032633-4597-4f0c-853a-6fbe7d7028cb', true);
set local role authenticated;

do $$
declare n int;
begin
  -- 1. Can the supervisor widen their own reach?
  begin
    insert into public.supervisor_assignments (company_id, supervisor_id, department_id)
    values ('c0a1e400-0000-4000-8000-000000000001',
            '65032633-4597-4f0c-853a-6fbe7d7028cb',
            'e1c81c39-f2a2-4705-b34e-3da26fa8f02e');
    raise exception 'ALLOWED';
  exception when others then
    perform set_config('t.self_grant', case when sqlerrm = 'ALLOWED' then 'ALLOWED (bad)' else 'blocked' end, true);
  end;

  -- 2. Can they write a note on someone outside their department (Arleth Parra)?
  begin
    insert into public.timecard_notes (company_id, user_id, note_date, note)
    values ('c0a1e400-0000-4000-8000-000000000001',
            '7411c901-a87a-4124-91fa-deb01bf85fc5', current_date, 'scope test');
    raise exception 'ALLOWED';
  exception when others then
    perform set_config('t.note_outside', case when sqlerrm = 'ALLOWED' then 'ALLOWED (bad)' else 'blocked' end, true);
  end;

  -- 3. ...and on someone inside it (Alan Prieto)? This one should be allowed.
  begin
    insert into public.timecard_notes (company_id, user_id, note_date, note)
    values ('c0a1e400-0000-4000-8000-000000000001',
            '70001aa4-c762-43d2-a3d2-4ab0b0140167', current_date, 'scope test');
    raise exception 'ALLOWED';
  exception when others then
    perform set_config('t.note_inside', case when sqlerrm = 'ALLOWED' then 'allowed' else 'blocked: ' || sqlerrm end, true);
  end;

  -- 4. Can they change company settings?
  begin
    update public.companies set name = name where id = 'c0a1e400-0000-4000-8000-000000000001';
    get diagnostics n = row_count;
    if n > 0 then raise exception 'ALLOWED'; end if;
    perform set_config('t.company_edit', 'blocked', true);
  exception when others then
    perform set_config('t.company_edit', case when sqlerrm = 'ALLOWED' then 'ALLOWED (bad)' else 'blocked' end, true);
  end;

  -- 5. Can they create a department?
  begin
    insert into public.departments (company_id, name)
    values ('c0a1e400-0000-4000-8000-000000000001', 'scope test');
    raise exception 'ALLOWED';
  exception when others then
    perform set_config('t.new_dept', case when sqlerrm = 'ALLOWED' then 'ALLOWED (bad)' else 'blocked' end, true);
  end;
end $$;

select
  (select count(*) from public.managed_employee_ids())                        as people_in_scope,
  (select count(*) from public.profiles
    where department_id = 'e1c81c39-f2a2-4705-b34e-3da26fa8f02e')            as people_in_parking_enf,
  (select count(distinct user_id) from public.time_punches
    where user_id <> '65032633-4597-4f0c-853a-6fbe7d7028cb'
      and user_id not in (select id from public.profiles
                           where department_id = 'e1c81c39-f2a2-4705-b34e-3da26fa8f02e')) as punch_people_outside_seen,
  (select count(distinct user_id) from public.time_punches
    where user_id in (select id from public.profiles
                       where department_id = 'e1c81c39-f2a2-4705-b34e-3da26fa8f02e')) as punch_people_inside_seen,
  public.is_company_manager(auth.uid(), 'c0a1e400-0000-4000-8000-000000000001') as counts_as_admin,
  current_setting('t.self_grant')   as grant_self_more,
  current_setting('t.note_outside') as note_outside_dept,
  current_setting('t.note_inside')  as note_inside_dept,
  current_setting('t.company_edit') as edit_company,
  current_setting('t.new_dept')     as create_department;
