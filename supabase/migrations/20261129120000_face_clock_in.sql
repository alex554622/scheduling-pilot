-- Face clock-in on the shared clock-in device (/clock/<token>).
--
-- HOW TO APPLY: open Studio (supabase.schedulingpilot.com) -> SQL editor,
-- paste this whole file and press Run. Run it AFTER
-- 20261128120000_team_rules.sql. It is safe to run again.
-- Do not use the supabase CLI or MCP tools; they point at the old project.
--
-- What it stores
--   employee_faces: per person and company, 3 to 10 face descriptors. A
--   descriptor is 128 numbers that face-api.js computes in the browser from a
--   camera frame. No photo is ever uploaded or stored, and a descriptor can't
--   be turned back into a picture. The table has RLS on and NO policies, and
--   anon/authenticated have no table grants: only the SECURITY DEFINER
--   functions below can read or write it. Not even admins can read the numbers;
--   they see "enrolled: yes/no" through face_enrollment_status().
--
-- How a face punch works
--   1. The device sends one descriptor (the average of several frames) to
--      kiosk_face_match(token, descriptor). Matching happens HERE, on the
--      server, so the device never holds anyone's face data or PIN.
--   2. A match needs: distance to the person's closest sample <= 0.45 AND at
--      least 0.08 closer than anyone else. Ambiguous faces are refused, so a
--      look-alike gets "not recognised", never someone else's account.
--   3. On a match the device gets a ticket "face:<uuid>", valid 90 seconds,
--      for that device only. It passes the ticket wherever it would pass the
--      4-digit code. kiosk_resolve() accepts it, so kiosk_state and kiosk_punch
--      are unchanged and every rule they apply (team rules, allow_kiosk, GPS,
--      breaks, lateness, early clock-in) applies to face punches too.
--   4. 10 failed face matches in a row lock face matching on that device for
--      1 minute. The PIN keypad has its own, separate lockout.

-- ------------------------------------------------------------------ tables --

create table if not exists public.employee_faces (
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  -- n x 128, n between 3 and 10.
  descriptors double precision[] not null,
  -- The admin confirmed the person agreed to face clock-in.
  consent_at timestamptz not null,
  enrolled_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, company_id),
  constraint employee_faces_shape check (
    array_ndims(descriptors) = 2
    and array_length(descriptors, 1) between 3 and 10
    and array_length(descriptors, 2) = 128
  )
);
create index if not exists employee_faces_company_idx on public.employee_faces(company_id);
alter table public.employee_faces enable row level security;
-- Deliberately no policies: biometric data is reachable only through the
-- functions below.
revoke all on public.employee_faces from public, anon, authenticated;
grant all on public.employee_faces to service_role;

create table if not exists public.kiosk_face_tickets (
  ticket uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.kiosk_devices(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists kiosk_face_tickets_expires_idx on public.kiosk_face_tickets(expires_at);
alter table public.kiosk_face_tickets enable row level security;
revoke all on public.kiosk_face_tickets from public, anon, authenticated;
grant all on public.kiosk_face_tickets to service_role;

alter table public.kiosk_devices add column if not exists face_failed_attempts integer not null default 0;
alter table public.kiosk_devices add column if not exists face_locked_until timestamptz;

-- ----------------------------------------------------------------- helpers --

-- Euclidean distance between row _i of an n x 128 array and a 128 vector.
create or replace function public.face_distance(_samples double precision[], _i integer, _probe double precision[])
returns double precision
language sql immutable parallel safe set search_path = public
as $$
  select sqrt(sum((x - y) * (x - y)))
    from unnest(_samples[_i:_i][1:128], _probe) as t(x, y);
$$;
revoke all on function public.face_distance(double precision[], integer, double precision[]) from public, anon, authenticated;

-- Row _i of an n x 128 array, as a plain 128 vector.
create or replace function public.face_row(_samples double precision[], _i integer)
returns double precision[]
language sql immutable parallel safe set search_path = public
as $$
  select array_agg(x order by o)
    from unnest(_samples[_i:_i][1:128]) with ordinality as u(x, o);
$$;
revoke all on function public.face_row(double precision[], integer) from public, anon, authenticated;

-- JSON [[128 numbers], ...] -> n x 128 array; null if it isn't that shape.
create or replace function public.face_matrix(_j jsonb)
returns double precision[]
language plpgsql immutable set search_path = public
as $$
declare
  r double precision[];
begin
  if _j is null or jsonb_typeof(_j) <> 'array' or jsonb_array_length(_j) = 0 then return null; end if;
  if exists (select 1 from jsonb_array_elements(_j) e
              where jsonb_typeof(e) <> 'array' or jsonb_array_length(e) <> 128
                 or exists (select 1 from jsonb_array_elements(e) v where jsonb_typeof(v) <> 'number')) then
    return null;
  end if;
  select array(
           select array(select (v #>> '{}')::double precision
                          from jsonb_array_elements(e) with ordinality as w(v, k) order by k)
             from jsonb_array_elements(_j) with ordinality as q(e, o) order by o)
    into r;
  return r;
end; $$;
revoke all on function public.face_matrix(jsonb) from public, anon, authenticated;

-- True when every value is a finite number (no NaN / Infinity / null).
create or replace function public.face_values_ok(_a double precision[])
returns boolean
language sql immutable set search_path = public
as $$
  select coalesce(bool_and(v is not null and v = v and v < 'Infinity'::float8 and v > '-Infinity'::float8 and abs(v) < 10), false)
    from unnest(_a) as t(v);
$$;
revoke all on function public.face_values_ok(double precision[]) from public, anon, authenticated;

-- ------------------------------------------------------------ admin side --

-- Save (or replace) a person's face. _samples is JSON [[128 numbers], ...]
-- (3 to 10 rows) from the enrollment dialog. _consent must be true.
create or replace function public.enroll_employee_face(_user uuid, _samples jsonb, _consent boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  _descriptors double precision[] := public.face_matrix(_samples);
  n int;
  i int;
  j int;
  clash record;
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
  if _descriptors is null or array_ndims(_descriptors) <> 2
     or array_length(_descriptors, 1) not between 3 and 10
     or array_length(_descriptors, 2) <> 128
     or not public.face_values_ok(_descriptors) then
    raise exception 'invalid face data';
  end if;

  -- The samples must all be the same face.
  n := array_length(_descriptors, 1);
  for i in 1..n loop
    for j in i + 1..n loop
      if public.face_distance(_descriptors, i, public.face_row(_descriptors, j)) > 0.5 then
        raise exception 'the face scans do not match each other - scan again';
      end if;
    end loop;
  end loop;

  -- One face, one person: refuse a face that is already enrolled for someone
  -- else in this company.
  select f.user_id, pr.full_name as name into clash
    from public.employee_faces f
    join public.profiles pr on pr.id = f.user_id
   where f.company_id = cid and f.user_id <> _user
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

  insert into public.employee_faces (user_id, company_id, descriptors, consent_at, enrolled_by, updated_at)
  values (_user, cid, _descriptors, now(), uid, now())
  on conflict (user_id, company_id) do update
    set descriptors = excluded.descriptors,
        consent_at = excluded.consent_at,
        enrolled_by = excluded.enrolled_by,
        updated_at = now();
end; $$;

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
  delete from public.kiosk_face_tickets t
   where t.user_id = _user
     and public.has_role(uid, 'company_admin'::public.app_role, t.company_id);
end; $$;

-- Who has a face enrolled in the admin's current company. No face data.
create or replace function public.face_enrollment_status()
returns table (user_id uuid, samples integer, updated_at timestamptz)
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
    select f.user_id, array_length(f.descriptors, 1), f.updated_at
      from public.employee_faces f
     where f.company_id = cid;
end; $$;

revoke all on function public.enroll_employee_face(uuid, jsonb, boolean) from public, anon;
revoke all on function public.clear_employee_face(uuid) from public, anon;
revoke all on function public.face_enrollment_status() from public, anon;
grant execute on function public.enroll_employee_face(uuid, jsonb, boolean) to authenticated;
grant execute on function public.clear_employee_face(uuid) to authenticated;
grant execute on function public.face_enrollment_status() to authenticated;

-- ----------------------------------------------------------- device side --

-- Whether the device should offer face clock-in (someone is enrolled).
create or replace function public.kiosk_face_info(_token text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  d record;
  n int;
begin
  select * into d from public.kiosk_devices where token = _token and revoked_at is null;
  if d.id is null then
    return jsonb_build_object('ok', false, 'message', 'This device link is no longer valid. Ask an admin for a new one.');
  end if;
  select count(*) into n
    from public.employee_faces f
    join public.company_memberships m
      on m.user_id = f.user_id and m.company_id = f.company_id and m.status = 'active'
   where f.company_id = d.company_id;
  return jsonb_build_object('ok', true, 'enrolled', n);
end; $$;

create or replace function public.kiosk_face_match(_token text, _descriptor double precision[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  d record;
  best record;
  second_dist double precision;
  tk uuid;
  -- Same person usually scores 0.25-0.40 with this model; different people
  -- 0.55+. Both limits are deliberately strict: a refused face can use the PIN.
  max_dist constant double precision := 0.45;
  min_margin constant double precision := 0.08;
begin
  select * into d from public.kiosk_devices where token = _token and revoked_at is null;
  if d.id is null then
    return jsonb_build_object('ok', false, 'message', 'This device link is no longer valid. Ask an admin for a new one.');
  end if;
  if d.face_locked_until is not null and d.face_locked_until > now() then
    return jsonb_build_object('ok', false, 'message', 'Too many faces not recognised. Use your PIN or try again in a minute.');
  end if;
  if _descriptor is null or array_ndims(_descriptor) <> 1 or array_length(_descriptor, 1) <> 128
     or not public.face_values_ok(_descriptor) then
    return jsonb_build_object('ok', false, 'message', 'Face not recognised. Try again or use your PIN.');
  end if;

  delete from public.kiosk_face_tickets where expires_at < now();

  -- Closest sample per person, active members of this device's company only.
  with per_person as (
    select f.user_id,
           (select min(public.face_distance(f.descriptors, i, _descriptor))
              from generate_series(1, array_length(f.descriptors, 1)) i) as dist
      from public.employee_faces f
      join public.company_memberships m
        on m.user_id = f.user_id and m.company_id = f.company_id and m.status = 'active'
     where f.company_id = d.company_id
  ), ranked as (
    select user_id, dist, row_number() over (order by dist) as rn from per_person
  )
  select (select user_id from ranked where rn = 1) as user_id,
         (select dist from ranked where rn = 1) as dist,
         (select dist from ranked where rn = 2) as next_dist
    into best;

  second_dist := coalesce(best.next_dist, 'Infinity'::float8);

  if best.user_id is null or best.dist > max_dist or second_dist - best.dist < min_margin then
    update public.kiosk_devices
       set face_failed_attempts = face_failed_attempts + 1,
           face_locked_until = case when face_failed_attempts + 1 >= 10
                                    then now() + interval '1 minute' else face_locked_until end
     where id = d.id;
    return jsonb_build_object('ok', false, 'message', 'Face not recognised. Try again or use your PIN.');
  end if;

  update public.kiosk_devices
     set face_failed_attempts = 0, face_locked_until = null, last_used_at = now()
   where id = d.id;

  insert into public.kiosk_face_tickets (device_id, company_id, user_id, expires_at)
  values (d.id, d.company_id, best.user_id, now() + interval '90 seconds')
  returning ticket into tk;

  return jsonb_build_object('ok', true, 'ticket', 'face:' || tk::text);
end; $$;

-- kiosk_resolve: as in 20261122120000_multi_company_memberships.sql, plus
-- "face:<uuid>" tickets from kiosk_face_match. kiosk_state and kiosk_punch
-- call this, so they accept tickets without being redefined.
create or replace function public.kiosk_resolve(_token text, _code text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  d record;
  p record;
  tk uuid;
begin
  select * into d from public.kiosk_devices where token = _token and revoked_at is null;
  if d.id is null then
    return jsonb_build_object('ok', false, 'message', 'This device link is no longer valid. Ask an admin for a new one.');
  end if;

  -- A face ticket: issued to this device by kiosk_face_match, still fresh.
  if _code is not null and _code like 'face:%' then
    if substr(_code, 6) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('ok', false, 'message', 'Face scan expired. Scan again.');
    end if;
    tk := substr(_code, 6)::uuid;
    select t.user_id as uid, pr.full_name as name into p
      from public.kiosk_face_tickets t
      join public.profiles pr on pr.id = t.user_id
      join public.company_memberships m
        on m.user_id = t.user_id and m.company_id = t.company_id and m.status = 'active'
     where t.ticket = tk and t.device_id = d.id and t.company_id = d.company_id
       and t.expires_at > now();
    if p.uid is null then
      return jsonb_build_object('ok', false, 'message', 'Face scan expired. Scan again.');
    end if;
    return jsonb_build_object('ok', true, 'company_id', d.company_id, 'user_id', p.uid, 'name', p.name);
  end if;

  if d.locked_until is not null and d.locked_until > now() then
    return jsonb_build_object('ok', false, 'message', 'Too many wrong codes. Try again in a minute.');
  end if;
  if _code is null or _code !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'message', 'Enter your 4-digit code.');
  end if;

  select c.user_id as uid, pr.full_name as name into p
  from public.employee_clock_codes c
  join public.profiles pr on pr.id = c.user_id
  join public.company_memberships m on m.user_id = c.user_id and m.company_id = c.company_id and m.status = 'active'
  where c.company_id = d.company_id and c.code = _code;

  if p.uid is null then
    update public.kiosk_devices
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5 then now() + interval '1 minute' else locked_until end
     where id = d.id;
    return jsonb_build_object('ok', false, 'message', 'That code was not recognised.');
  end if;

  update public.kiosk_devices
     set failed_attempts = 0, locked_until = null, last_used_at = now()
   where id = d.id;

  return jsonb_build_object('ok', true, 'company_id', d.company_id, 'user_id', p.uid, 'name', p.name);
end; $$;

revoke all on function public.kiosk_resolve(text, text) from public, anon, authenticated;
revoke all on function public.kiosk_face_info(text) from public;
revoke all on function public.kiosk_face_match(text, double precision[]) from public;
grant execute on function public.kiosk_face_info(text) to anon, authenticated;
grant execute on function public.kiosk_face_match(text, double precision[]) to anon, authenticated;
