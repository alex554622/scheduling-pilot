-- Employees enroll their own face, an admin approves it, and admins choose PINs.
--
-- HOW TO APPLY: open Studio (supabase.schedulingpilot.com) -> SQL editor,
-- paste this whole file and press Run. Run it AFTER
-- 20261129120000_face_clock_in.sql. It is safe to run again.
-- Do not use the supabase CLI or MCP tools; they point at the old project.
--
-- 1. Self-enrollment with approval
--   An employee scans their own face from Settings -> My account. The scan
--   goes into employee_face_requests, NOT employee_faces, so the shared
--   clock-in can't use it yet. An admin approves it on the Shared clock-in
--   page, which moves it into employee_faces, or rejects it, which deletes it.
--   This applies to the first face and to every later change. While a change
--   waits, the person's old approved face keeps working.
--   To help the admin decide, face_enrollment_status() says whether the new
--   scan looks like the person's current approved face. No photo is kept, so
--   this is the only comparison possible.
--   A face the admin enrolls directly is approved straight away, as before.
--   An employee can remove their own face (approved and waiting) at any time.
--
-- 2. Admin-chosen PINs
--   set_employee_clock_code(_user, _code) takes an optional 4-digit code. With
--   no code it picks a random free one, as before. Two people in one company
--   can't have the same code. The admin can change it at any time; the old
--   code stops working straight away.

-- ------------------------------------------------------------------ table --

create table if not exists public.employee_face_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  descriptors double precision[] not null,
  -- The employee ticked that they agree to face clock-in.
  consent_at timestamptz not null,
  submitted_at timestamptz not null default now(),
  primary key (user_id, company_id),
  constraint employee_face_requests_shape check (
    array_ndims(descriptors) = 2
    and array_length(descriptors, 1) between 3 and 10
    and array_length(descriptors, 2) = 128
  )
);
create index if not exists employee_face_requests_company_idx on public.employee_face_requests(company_id);
alter table public.employee_face_requests enable row level security;
-- Deliberately no policies, like employee_faces: only the functions below.
revoke all on public.employee_face_requests from public, anon, authenticated;
grant all on public.employee_face_requests to service_role;

-- ----------------------------------------------------------------- helper --

-- Checks a set of samples for _user in _cid, raising a readable error if they
-- can't be used: wrong shape, scans of different people, or a face already
-- approved for someone else in the company.
create or replace function public.face_check_samples(_descriptors double precision[], _user uuid, _cid uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
declare
  n int;
  i int;
  j int;
  clash record;
begin
  if _descriptors is null or array_ndims(_descriptors) <> 2
     or array_length(_descriptors, 1) not between 3 and 10
     or array_length(_descriptors, 2) <> 128
     or not public.face_values_ok(_descriptors) then
    raise exception 'invalid face data';
  end if;

  n := array_length(_descriptors, 1);
  for i in 1..n loop
    for j in i + 1..n loop
      if public.face_distance(_descriptors, i, public.face_row(_descriptors, j)) > 0.5 then
        raise exception 'the face scans do not match each other - scan again';
      end if;
    end loop;
  end loop;

  select f.user_id, pr.full_name as name into clash
    from public.employee_faces f
    join public.profiles pr on pr.id = f.user_id
   where f.company_id = _cid and f.user_id <> _user
     and exists (
       select 1
         from generate_series(1, array_length(f.descriptors, 1)) a,
              generate_series(1, n) b
        where public.face_distance(f.descriptors, a, public.face_row(_descriptors, b)) < 0.5
     )
   limit 1;
  if clash.user_id is not null then
    raise exception 'this face is too similar to % (already enrolled)', coalesce(clash.name, 'another person');
  end if;
end; $$;
revoke all on function public.face_check_samples(double precision[], uuid, uuid) from public, anon, authenticated;

-- Smallest distance between any sample of _a and any sample of _b.
create or replace function public.face_set_distance(_a double precision[], _b double precision[])
returns double precision
language sql immutable set search_path = public
as $$
  select min(public.face_distance(_a, i, public.face_row(_b, j)))
    from generate_series(1, array_length(_a, 1)) i,
         generate_series(1, array_length(_b, 1)) j;
$$;
revoke all on function public.face_set_distance(double precision[], double precision[]) from public, anon, authenticated;

-- ------------------------------------------------------------ admin side --

-- As in 20261129120000_face_clock_in.sql, plus: it clears any waiting
-- request, since the admin's own scan replaces it.
create or replace function public.enroll_employee_face(_user uuid, _samples jsonb, _consent boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  _descriptors double precision[] := public.face_matrix(_samples);
begin
  if uid is null then raise exception 'not authenticated'; end if;
  cid := public.member_company(_user);
  if cid is null then raise exception 'that person is not in a company'; end if;
  if not public.has_role(uid, 'company_admin'::public.app_role, cid) then
    raise exception 'only a company admin can enroll faces';
  end if;
  if not coalesce(_consent, false) then
    raise exception 'the employee must agree to face clock-in first';
  end if;
  perform public.face_check_samples(_descriptors, _user, cid);

  insert into public.employee_faces (user_id, company_id, descriptors, consent_at, enrolled_by, updated_at)
  values (_user, cid, _descriptors, now(), uid, now())
  on conflict (user_id, company_id) do update
    set descriptors = excluded.descriptors,
        consent_at = excluded.consent_at,
        enrolled_by = excluded.enrolled_by,
        updated_at = now();
  delete from public.employee_face_requests where user_id = _user and company_id = cid;
end; $$;

-- Removes the approved face and any waiting request.
create or replace function public.clear_employee_face(_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  delete from public.employee_faces f
   where f.user_id = _user
     and public.has_role(uid, 'company_admin'::public.app_role, f.company_id);
  delete from public.employee_face_requests r
   where r.user_id = _user
     and public.has_role(uid, 'company_admin'::public.app_role, r.company_id);
  delete from public.kiosk_face_tickets t
   where t.user_id = _user
     and public.has_role(uid, 'company_admin'::public.app_role, t.company_id);
end; $$;

-- Moves a waiting face into use. The checks run again, in case someone else
-- with that face was approved in the meantime.
create or replace function public.approve_employee_face(_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid := public.current_company_id();
  req record;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if cid is null or not public.has_role(uid, 'company_admin'::public.app_role, cid) then
    raise exception 'only a company admin can approve faces';
  end if;
  select * into req from public.employee_face_requests
   where user_id = _user and company_id = cid
   for update;
  if req.user_id is null then raise exception 'there is no face waiting for approval'; end if;
  if not exists (select 1 from public.company_memberships m
                  where m.user_id = _user and m.company_id = cid and m.status = 'active') then
    raise exception 'that person is not in a company';
  end if;
  perform public.face_check_samples(req.descriptors, _user, cid);

  insert into public.employee_faces (user_id, company_id, descriptors, consent_at, enrolled_by, updated_at)
  values (_user, cid, req.descriptors, req.consent_at, uid, now())
  on conflict (user_id, company_id) do update
    set descriptors = excluded.descriptors,
        consent_at = excluded.consent_at,
        enrolled_by = excluded.enrolled_by,
        updated_at = now();
  delete from public.employee_face_requests where user_id = _user and company_id = cid;
end; $$;

-- Throws a waiting face away. An approved face, if any, keeps working.
create or replace function public.reject_employee_face(_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid := public.current_company_id();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if cid is null or not public.has_role(uid, 'company_admin'::public.app_role, cid) then
    raise exception 'only a company admin can reject faces';
  end if;
  delete from public.employee_face_requests where user_id = _user and company_id = cid;
end; $$;

-- Who has a face approved or waiting, in the admin's current company.
-- matches_current: for a waiting change, whether it looks like the approved
-- face (null when there is no approved face). Never any face data.
drop function if exists public.face_enrollment_status();
create function public.face_enrollment_status()
returns table (
  user_id uuid,
  approved boolean,
  samples integer,
  updated_at timestamptz,
  pending_at timestamptz,
  matches_current boolean
)
language plpgsql stable security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid := public.current_company_id();
begin
  if uid is null or cid is null
     or not public.has_role(uid, 'company_admin'::public.app_role, cid) then
    return;
  end if;
  return query
    select coalesce(f.user_id, r.user_id),
           f.user_id is not null,
           array_length(f.descriptors, 1),
           f.updated_at,
           r.submitted_at,
           case when f.user_id is null or r.user_id is null then null
                else public.face_set_distance(f.descriptors, r.descriptors) < 0.5 end
      from (select * from public.employee_faces where company_id = cid) f
      full join (select * from public.employee_face_requests where company_id = cid) r
        on r.user_id = f.user_id;
end; $$;

-- --------------------------------------------------------- employee side --

-- The signed-in person sends their own face for approval, in their current
-- company. It replaces any earlier request of theirs that is still waiting.
create or replace function public.submit_my_face(_samples jsonb, _consent boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  _descriptors double precision[] := public.face_matrix(_samples);
begin
  if uid is null then raise exception 'not authenticated'; end if;
  cid := public.member_company(uid);
  if cid is null then raise exception 'you are not in a company'; end if;
  if not coalesce(_consent, false) then
    raise exception 'you must agree to face clock-in first';
  end if;
  begin
    perform public.face_check_samples(_descriptors, uid, cid);
  exception when raise_exception then
    -- Don't tell an employee whose face theirs resembles.
    if sqlerrm like 'this face is too similar%' then
      raise exception 'this face is already enrolled for someone else';
    end if;
    raise;
  end;

  insert into public.employee_face_requests (user_id, company_id, descriptors, consent_at, submitted_at)
  values (uid, cid, _descriptors, now(), now())
  on conflict (user_id, company_id) do update
    set descriptors = excluded.descriptors,
        consent_at = excluded.consent_at,
        submitted_at = now();
end; $$;

-- The signed-in person's own face status in their current company.
create or replace function public.my_face_status()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  f timestamptz;
  r timestamptz;
begin
  if uid is null then return null; end if;
  cid := public.member_company(uid);
  if cid is null then return null; end if;
  select updated_at into f from public.employee_faces where user_id = uid and company_id = cid;
  select submitted_at into r from public.employee_face_requests where user_id = uid and company_id = cid;
  return jsonb_build_object(
    'approved', f is not null,
    'approved_at', f,
    'pending', r is not null,
    'submitted_at', r
  );
end; $$;

-- The signed-in person removes their face (approved and waiting) from their
-- current company. They can still clock in with their PIN.
create or replace function public.remove_my_face()
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  cid := public.member_company(uid);
  if cid is null then return; end if;
  delete from public.employee_faces where user_id = uid and company_id = cid;
  delete from public.employee_face_requests where user_id = uid and company_id = cid;
  delete from public.kiosk_face_tickets where user_id = uid and company_id = cid;
end; $$;

-- ------------------------------------------------------------------- PINs --

-- Was set_employee_clock_code(_user). The one-argument call from older app
-- versions still works: _code defaults to null, which picks a random code.
drop function if exists public.set_employee_clock_code(uuid);
create or replace function public.set_employee_clock_code(_user uuid, _code text default null)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  candidate text;
  tries int := 0;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  cid := public.member_company(_user);
  if cid is null then raise exception 'that person is not in a company'; end if;
  if not public.has_role(uid, 'company_admin'::public.app_role, cid) then
    raise exception 'only a company admin can issue clock-in codes';
  end if;

  if _code is not null and btrim(_code) <> '' then
    candidate := btrim(_code);
    if candidate !~ '^[0-9]{4}$' then
      raise exception 'the code must be exactly 4 digits';
    end if;
    if exists (select 1 from public.employee_clock_codes
                where company_id = cid and code = candidate and user_id <> _user) then
      raise exception 'that code is already used by someone else';
    end if;
  else
    loop
      tries := tries + 1;
      candidate := lpad((floor(random() * 10000))::int::text, 4, '0');
      exit when not exists (
        select 1 from public.employee_clock_codes
         where company_id = cid and code = candidate and user_id <> _user
      );
      if tries > 200 then raise exception 'could not find a free code - clear some old ones first'; end if;
    end loop;
  end if;

  insert into public.employee_clock_codes (user_id, company_id, code)
  values (_user, cid, candidate)
  on conflict (user_id, company_id) do update
    set code = excluded.code, updated_at = now();

  return candidate;
end; $$;

-- ----------------------------------------------------------------- grants --

revoke all on function public.enroll_employee_face(uuid, jsonb, boolean) from public, anon;
revoke all on function public.clear_employee_face(uuid) from public, anon;
revoke all on function public.approve_employee_face(uuid) from public, anon;
revoke all on function public.reject_employee_face(uuid) from public, anon;
revoke all on function public.face_enrollment_status() from public, anon;
revoke all on function public.submit_my_face(jsonb, boolean) from public, anon;
revoke all on function public.my_face_status() from public, anon;
revoke all on function public.remove_my_face() from public, anon;
revoke all on function public.set_employee_clock_code(uuid, text) from public, anon;
grant execute on function public.enroll_employee_face(uuid, jsonb, boolean) to authenticated;
grant execute on function public.clear_employee_face(uuid) to authenticated;
grant execute on function public.approve_employee_face(uuid) to authenticated;
grant execute on function public.reject_employee_face(uuid) to authenticated;
grant execute on function public.face_enrollment_status() to authenticated;
grant execute on function public.submit_my_face(jsonb, boolean) to authenticated;
grant execute on function public.my_face_status() to authenticated;
grant execute on function public.remove_my_face() to authenticated;
grant execute on function public.set_employee_clock_code(uuid, text) to authenticated;
