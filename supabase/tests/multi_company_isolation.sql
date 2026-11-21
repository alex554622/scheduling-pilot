-- Multi-company isolation checks. Read-only in effect: everything runs in one
-- transaction that is rolled back at the end, so it is safe to paste into the
-- Studio SQL editor on production after the migrations are applied.
--
-- It makes three throwaway companies and five throwaway accounts, acts as each
-- of them the way PostgREST would (JWT claims + the x-company-id header), and
-- fails with "assertion failed: <what>" on the first check that does not hold.
-- The last line printed is "multi-company checks passed" when all of them do.
--
-- Cast:
--   admA  admin of A
--   admB  admin of B
--   admC  admin of C
--   emp   employee of A and of B (the person with two companies)
--   out   no company yet; asks to join C by its code

begin;

-- ---------------------------------------------------------------- helpers
create function pg_temp.act(_uid uuid, _company uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated')::text, true),
         set_config('request.headers',
           case when _company is null then '{}' else json_build_object('x-company-id', _company)::text end, true);
$$;
grant execute on function pg_temp.act(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email, raw_user_meta_data, aud, role)
values
  ('00000000-0000-4000-a000-00000000000a', 'mc-test-adma@example.invalid', '{"full_name":"Test AdminA"}', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-00000000000b', 'mc-test-admb@example.invalid', '{"full_name":"Test AdminB"}', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-00000000000c', 'mc-test-admc@example.invalid', '{"full_name":"Test AdminC"}', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-0000000000e1', 'mc-test-emp@example.invalid',  '{"full_name":"Test Employee"}', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-0000000000f1', 'mc-test-out@example.invalid',  '{"full_name":"Test Outsider"}', 'authenticated', 'authenticated');

insert into public.companies (id, name, status, join_code)
values
  ('00000000-0000-4000-b000-00000000000a', 'MC Test A', 'active', 'MCTESTA1'),
  ('00000000-0000-4000-b000-00000000000b', 'MC Test B', 'active', 'MCTESTB1'),
  ('00000000-0000-4000-b000-00000000000c', 'MC Test C', 'active', 'MCTESTC1');

insert into public.company_memberships (user_id, company_id)
values
  ('00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-b000-00000000000a'),
  ('00000000-0000-4000-a000-00000000000b', '00000000-0000-4000-b000-00000000000b'),
  ('00000000-0000-4000-a000-00000000000c', '00000000-0000-4000-b000-00000000000c'),
  ('00000000-0000-4000-a000-0000000000e1', '00000000-0000-4000-b000-00000000000a'),
  ('00000000-0000-4000-a000-0000000000e1', '00000000-0000-4000-b000-00000000000b');

update public.profiles set company_id = '00000000-0000-4000-b000-00000000000a'
 where id in ('00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-0000000000e1');
update public.profiles set company_id = '00000000-0000-4000-b000-00000000000b'
 where id = '00000000-0000-4000-a000-00000000000b';
update public.profiles set company_id = '00000000-0000-4000-b000-00000000000c'
 where id = '00000000-0000-4000-a000-00000000000c';

insert into public.user_roles (user_id, company_id, role)
values
  ('00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-b000-00000000000a', 'company_admin'),
  ('00000000-0000-4000-a000-00000000000b', '00000000-0000-4000-b000-00000000000b', 'company_admin'),
  ('00000000-0000-4000-a000-00000000000c', '00000000-0000-4000-b000-00000000000c', 'company_admin'),
  ('00000000-0000-4000-a000-0000000000e1', '00000000-0000-4000-b000-00000000000a', 'employee'),
  ('00000000-0000-4000-a000-0000000000e1', '00000000-0000-4000-b000-00000000000b', 'employee');

insert into public.shifts (id, company_id, employee_id, starts_at, ends_at)
values
  ('00000000-0000-4000-c000-00000000000a', '00000000-0000-4000-b000-00000000000a',
   '00000000-0000-4000-a000-0000000000e1', now() + interval '1 day', now() + interval '1 day 8 hours'),
  ('00000000-0000-4000-c000-00000000000b', '00000000-0000-4000-b000-00000000000b',
   '00000000-0000-4000-a000-0000000000e1', now() + interval '2 days', now() + interval '2 days 8 hours');

insert into public.notifications (user_id, type, title, company_id)
values ('00000000-0000-4000-a000-0000000000e1', 'shift_published', 'MC test: A only',
        '00000000-0000-4000-b000-00000000000a');

-- ------------------------------------------- 1. one person, two companies
select pg_temp.act('00000000-0000-4000-a000-0000000000e1', '00000000-0000-4000-b000-00000000000a');
set local role authenticated;
do $$ begin
  assert public.current_company_id() = '00000000-0000-4000-b000-00000000000a', '1a emp in A resolves to A';
  assert exists (select 1 from public.shifts where id = '00000000-0000-4000-c000-00000000000a'), '1b emp sees the A shift in A';
  assert not exists (select 1 from public.shifts where id = '00000000-0000-4000-c000-00000000000b'), '1c emp does not see the B shift while in A';
  assert exists (select 1 from public.notifications where title = 'MC test: A only'), '1d emp sees the A notification in A';
  assert not public.has_role(auth.uid(), 'company_admin', '00000000-0000-4000-b000-00000000000a'), '1e emp is not an admin of A';
  assert (select count(*) from public.my_companies()) = 2, '1f my_companies lists both companies';
end $$;
reset role;

select pg_temp.act('00000000-0000-4000-a000-0000000000e1', '00000000-0000-4000-b000-00000000000b');
set local role authenticated;
do $$ begin
  assert public.current_company_id() = '00000000-0000-4000-b000-00000000000b', '1g emp in B resolves to B';
  assert exists (select 1 from public.shifts where id = '00000000-0000-4000-c000-00000000000b'), '1h emp sees the B shift in B';
  assert not exists (select 1 from public.shifts where id = '00000000-0000-4000-c000-00000000000a'), '1i emp does not see the A shift while in B';
  assert not exists (select 1 from public.notifications where title = 'MC test: A only'), '1j A notification hidden while in B';
  assert not exists (select 1 from public.company_members where company_id = '00000000-0000-4000-b000-00000000000a'),
    '1k company_members shows only the selected company';
end $$;
reset role;

-- A header for a company the person is not in gives no company at all, never
-- a silent fallback to another one.
select pg_temp.act('00000000-0000-4000-a000-0000000000e1', '00000000-0000-4000-b000-00000000000c');
set local role authenticated;
do $$ begin
  assert public.current_company_id() is null, '1l a foreign header resolves to no company';
  assert not exists (select 1 from public.shifts where id in ('00000000-0000-4000-c000-00000000000a', '00000000-0000-4000-c000-00000000000b')),
    '1m a foreign header sees no shifts at all';
  begin
    perform public.switch_company('00000000-0000-4000-b000-00000000000c');
    raise exception 'EXPECTED_FAIL';
  exception when others then
    if sqlerrm = 'EXPECTED_FAIL' then raise exception '1n switching to a company you are not in must fail'; end if;
  end;
end $$;
reset role;

-- --------------------------------------------- 2. an admin stays in their lane
select pg_temp.act('00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-b000-00000000000a');
set local role authenticated;
do $$
declare n int;
begin
  assert public.has_role(auth.uid(), 'company_admin', '00000000-0000-4000-b000-00000000000a'), '2a admA is admin of A';
  assert not exists (select 1 from public.shifts where company_id = '00000000-0000-4000-b000-00000000000b'), '2b admA sees nothing of B';
  update public.companies set name = 'hijacked' where id = '00000000-0000-4000-b000-00000000000b';
  get diagnostics n = row_count;
  assert n = 0, '2c admA cannot rename B';
  update public.shifts set notes = 'hijacked' where id = '00000000-0000-4000-c000-00000000000b';
  get diagnostics n = row_count;
  assert n = 0, '2d admA cannot edit the B shift of a shared employee';
  begin
    perform public.suspend_membership('00000000-0000-4000-a000-00000000000b');
    raise exception 'EXPECTED_FAIL';
  exception when others then
    if sqlerrm = 'EXPECTED_FAIL' then raise exception '2e admA must not suspend someone outside A'; end if;
  end;
  begin
    perform public.leave_company('00000000-0000-4000-b000-00000000000a');
    raise exception 'EXPECTED_FAIL';
  exception when others then
    if sqlerrm = 'EXPECTED_FAIL' then raise exception '2f the last admin must not be able to leave'; end if;
  end;
end $$;
reset role;

-- ------------------------------------------------ 3. no self-promotion
select pg_temp.act('00000000-0000-4000-a000-0000000000e1', '00000000-0000-4000-b000-00000000000a');
set local role authenticated;
do $$ begin
  begin
    insert into public.user_roles (user_id, company_id, role)
    values (auth.uid(), '00000000-0000-4000-b000-00000000000a', 'company_admin');
    raise exception 'EXPECTED_FAIL';
  exception when others then
    if sqlerrm = 'EXPECTED_FAIL' then raise exception '3a an employee must not grant themself admin'; end if;
  end;
  begin
    perform public.set_member_role(auth.uid(), 'company_admin');
    raise exception 'EXPECTED_FAIL';
  exception when others then
    if sqlerrm = 'EXPECTED_FAIL' then raise exception '3b set_member_role must refuse a non-admin'; end if;
  end;
  update public.profiles set department_id = null, max_weekly_hours = 99 where id = auth.uid();
  assert (select max_weekly_hours from public.company_memberships
           where user_id = auth.uid() and company_id = '00000000-0000-4000-b000-00000000000a') <> 99,
    '3c an employee cannot change their own hours limit through the profile';
end $$;
reset role;

-- ------------------------------------ 4. join by code, admin approves
select pg_temp.act('00000000-0000-4000-a000-0000000000f1', null);
set local role authenticated;
do $$
declare r jsonb;
begin
  assert public.current_company_id() is null, '4a out has no company';
  assert not exists (select 1 from public.shifts), '4b out sees no shifts';
  r := public.lookup_company_code('mctestc1');
  assert (r->>'ok')::boolean and r->>'name' = 'MC Test C', '4c lookup finds C (case-insensitive)';
  r := public.request_to_join('MCTESTC1', 'test request');
  assert (r->>'ok')::boolean, '4d request_to_join succeeds';
  assert exists (select 1 from public.my_join_requests() where status = 'pending' and company_id = '00000000-0000-4000-b000-00000000000c'),
    '4e the request shows as pending';
  assert not public.is_member(auth.uid(), '00000000-0000-4000-b000-00000000000c'), '4f a request alone gives no access';
end $$;
reset role;

-- admA must not see or answer C's requests.
select pg_temp.act('00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-b000-00000000000a');
set local role authenticated;
do $$
declare rid uuid;
begin
  assert not exists (select 1 from public.company_join_requests where company_id = '00000000-0000-4000-b000-00000000000c'),
    '4g admA cannot see C requests';
end $$;
reset role;
do $$
declare rid uuid := (select id from public.company_join_requests
                      where company_id = '00000000-0000-4000-b000-00000000000c' and status = 'pending');
begin
  perform pg_temp.act('00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-b000-00000000000a');
  perform set_config('mc.rid', rid::text, true);
end $$;
set local role authenticated;
do $$ begin
  begin
    perform public.decide_join_request(current_setting('mc.rid')::uuid, true);
    raise exception 'EXPECTED_FAIL';
  exception when others then
    if sqlerrm = 'EXPECTED_FAIL' then raise exception '4h admA must not approve a C request'; end if;
  end;
end $$;
reset role;

select pg_temp.act('00000000-0000-4000-a000-00000000000c', '00000000-0000-4000-b000-00000000000c');
set local role authenticated;
do $$ begin
  assert exists (select 1 from public.company_join_requests where id = current_setting('mc.rid')::uuid), '4i admC sees the request';
  perform public.decide_join_request(current_setting('mc.rid')::uuid, true, 'employee');
  assert exists (select 1 from public.company_members where id = '00000000-0000-4000-a000-0000000000f1'), '4j out is now on the C roster';
end $$;
reset role;
do $$ begin
  assert exists (select 1 from public.audit_logs where company_id = '00000000-0000-4000-b000-00000000000c'
                   and entity_id = '00000000-0000-4000-a000-0000000000f1'), '4k the approval is in the audit log';
  assert exists (select 1 from public.notifications where user_id = '00000000-0000-4000-a000-0000000000f1'
                   and type like 'membership%'), '4l out was notified';
end $$;

select pg_temp.act('00000000-0000-4000-a000-0000000000f1', '00000000-0000-4000-b000-00000000000c');
set local role authenticated;
do $$ begin
  assert public.current_company_id() = '00000000-0000-4000-b000-00000000000c', '4m out can now work in C';
  assert public.has_role(auth.uid(), 'employee', '00000000-0000-4000-b000-00000000000c'), '4n with the employee role';
  assert not public.has_role(auth.uid(), 'company_admin', '00000000-0000-4000-b000-00000000000c'), '4o and nothing more';
end $$;
reset role;

-- ------------------------------ 5. suspend: access ends on the next request
select pg_temp.act('00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-b000-00000000000a');
set local role authenticated;
select public.suspend_membership('00000000-0000-4000-a000-0000000000e1', 'test');
reset role;

select pg_temp.act('00000000-0000-4000-a000-0000000000e1', '00000000-0000-4000-b000-00000000000a');
set local role authenticated;
do $$ begin
  assert public.current_company_id() is null, '5a suspended: A no longer resolves';
  assert not exists (select 1 from public.shifts where id = '00000000-0000-4000-c000-00000000000a'), '5b suspended: the A shift is gone';
  assert not public.has_role(auth.uid(), 'employee', '00000000-0000-4000-b000-00000000000a'), '5c suspended: no role in A';
  assert (select membership_status from public.my_companies() where company_id = '00000000-0000-4000-b000-00000000000a') = 'suspended',
    '5d my_companies says suspended';
end $$;
reset role;

select pg_temp.act('00000000-0000-4000-a000-0000000000e1', '00000000-0000-4000-b000-00000000000b');
set local role authenticated;
do $$ begin
  assert exists (select 1 from public.shifts where id = '00000000-0000-4000-c000-00000000000b'), '5e B is unaffected by the A suspension';
end $$;
reset role;

select pg_temp.act('00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-b000-00000000000a');
set local role authenticated;
select public.reinstate_membership('00000000-0000-4000-a000-0000000000e1');
reset role;

select pg_temp.act('00000000-0000-4000-a000-0000000000e1', '00000000-0000-4000-b000-00000000000a');
set local role authenticated;
do $$ begin
  assert exists (select 1 from public.shifts where id = '00000000-0000-4000-c000-00000000000a'), '5f reinstated: A is back';
end $$;
reset role;

-- --------------------------- 6. remove: access ends, the account stays
select pg_temp.act('00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-b000-00000000000a');
set local role authenticated;
select public.remove_company_member('00000000-0000-4000-a000-0000000000e1', 'other', 'test');
reset role;

select pg_temp.act('00000000-0000-4000-a000-0000000000e1', '00000000-0000-4000-b000-00000000000a');
set local role authenticated;
do $$ begin
  assert public.current_company_id() is null, '6a removed: A no longer resolves';
  assert not exists (select 1 from public.shifts where company_id = '00000000-0000-4000-b000-00000000000a'), '6b removed: nothing of A';
  assert (select count(*) from public.my_companies()) = 1, '6c removed: only B is left';
end $$;
reset role;
do $$ begin
  assert exists (select 1 from auth.users where id = '00000000-0000-4000-a000-0000000000e1'), '6d the account still exists';
  assert exists (select 1 from public.profiles where id = '00000000-0000-4000-a000-0000000000e1'), '6e the profile still exists';
  assert (select status from public.company_memberships where user_id = '00000000-0000-4000-a000-0000000000e1'
           and company_id = '00000000-0000-4000-b000-00000000000a') = 'revoked', '6f the membership is kept as revoked';
  assert (select company_id from public.profiles where id = '00000000-0000-4000-a000-0000000000e1')
           = '00000000-0000-4000-b000-00000000000b', '6g the account moved on to its remaining company';
end $$;

-- --------------------------------------------- 7. code guessing is limited
select pg_temp.act('00000000-0000-4000-a000-0000000000f1', null);
set local role authenticated;
do $$
declare r jsonb; i int;
begin
  for i in 1..12 loop
    r := public.lookup_company_code('NOPE' || i);
  end loop;
  assert not (r->>'ok')::boolean and r->>'message' ilike '%too many%', '7a repeated lookups are rate limited';
  r := public.lookup_company_code('MCTESTA1');
  assert not (r->>'ok')::boolean, '7b even a right code is refused while limited';
end $$;
reset role;

select 'multi-company checks passed' as result;
rollback;
