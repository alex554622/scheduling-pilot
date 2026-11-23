-- Face clock-in: switch to the newer face model (Human / faceres, 1024 numbers).
--
-- HOW TO APPLY: open Studio (supabase.schedulingpilot.com) -> SQL editor,
-- paste this whole file and press Run. Run it AFTER
-- 20261129120000_face_clock_in.sql and
-- 20261130120000_face_self_enroll_and_custom_pins.sql. It is safe to run again.
-- Do not use the supabase CLI or MCP tools; they point at the old project.
--
-- IMPORTANT: this deletes every saved face (approved and waiting). Faces saved
-- with the old model (128 numbers) can't be compared with the new one, so
-- everyone has to add their face again. PINs are not touched.
--
-- Limits, for unit-length 1024-number descriptors (distance 0 to 2). Measured
-- on 40 photos of 8 people: same person on different photos, median 0.81;
-- different people, never under 0.88. Scans from one camera in one session
-- are much closer than either.
--   kiosk match:            closest sample <= 0.80, and 0.06 closer than anyone else
--   one face, one person:   refuse a new face within 0.80 of someone else's
--   scans of one person:    all within 0.90 of each other
--   "looks like current":   within 0.85 (shown to the admin when approving)

-- --------------------------------------------------------- clear old faces --

delete from public.kiosk_face_tickets;
delete from public.employee_face_requests;
delete from public.employee_faces;

alter table public.employee_faces drop constraint if exists employee_faces_shape;
alter table public.employee_faces add constraint employee_faces_shape check (
  array_ndims(descriptors) = 2
  and array_length(descriptors, 1) between 3 and 10
  and array_length(descriptors, 2) = 1024
);
alter table public.employee_face_requests drop constraint if exists employee_face_requests_shape;
alter table public.employee_face_requests add constraint employee_face_requests_shape check (
  array_ndims(descriptors) = 2
  and array_length(descriptors, 1) between 3 and 10
  and array_length(descriptors, 2) = 1024
);

-- ----------------------------------------------------------------- helpers --

create or replace function public.face_distance(_samples double precision[], _i integer, _probe double precision[])
returns double precision
language sql immutable parallel safe set search_path = public
as $$
  select sqrt(sum((x - y) * (x - y)))
    from unnest(_samples[_i:_i][1:1024], _probe) as t(x, y);
$$;
revoke all on function public.face_distance(double precision[], integer, double precision[]) from public, anon, authenticated;

create or replace function public.face_row(_samples double precision[], _i integer)
returns double precision[]
language sql immutable parallel safe set search_path = public
as $$
  select array_agg(x order by o)
    from unnest(_samples[_i:_i][1:1024]) with ordinality as u(x, o);
$$;
revoke all on function public.face_row(double precision[], integer) from public, anon, authenticated;

-- JSON [[1024 numbers], ...] -> n x 1024 array; null if it isn't that shape.
create or replace function public.face_matrix(_j jsonb)
returns double precision[]
language plpgsql immutable set search_path = public
as $$
declare
  r double precision[];
begin
  if _j is null or jsonb_typeof(_j) <> 'array' or jsonb_array_length(_j) = 0 then return null; end if;
  if exists (select 1 from jsonb_array_elements(_j) e
              where jsonb_typeof(e) <> 'array' or jsonb_array_length(e) <> 1024
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

create or replace function public.face_check_samples(_descriptors double precision[], _user uuid, _cid uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
declare
  n int;
  i int;
  j int;
  probe double precision[];
  clash record;
begin
  if _descriptors is null or array_ndims(_descriptors) <> 2
     or array_length(_descriptors, 1) not between 3 and 10
     or array_length(_descriptors, 2) <> 1024
     or not public.face_values_ok(_descriptors) then
    raise exception 'invalid face data';
  end if;

  n := array_length(_descriptors, 1);
  for i in 1..n loop
    probe := public.face_row(_descriptors, i);
    for j in i + 1..n loop
      if public.face_distance(_descriptors, j, probe) > 0.9 then
        raise exception 'the face scans do not match each other - scan again';
      end if;
    end loop;
  end loop;

  for i in 1..n loop
    probe := public.face_row(_descriptors, i);
    select f.user_id, pr.full_name as name into clash
      from public.employee_faces f
      join public.profiles pr on pr.id = f.user_id
     where f.company_id = _cid and f.user_id <> _user
       and exists (
         select 1 from generate_series(1, array_length(f.descriptors, 1)) a
          where public.face_distance(f.descriptors, a, probe) < 0.8
       )
     limit 1;
    if clash.user_id is not null then
      raise exception 'this face is too similar to % (already enrolled)', coalesce(clash.name, 'another person');
    end if;
  end loop;
end; $$;
revoke all on function public.face_check_samples(double precision[], uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ admin side --

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
                else public.face_set_distance(f.descriptors, r.descriptors) < 0.85 end
      from (select * from public.employee_faces where company_id = cid) f
      full join (select * from public.employee_face_requests where company_id = cid) r
        on r.user_id = f.user_id;
end; $$;
revoke all on function public.face_enrollment_status() from public, anon;
grant execute on function public.face_enrollment_status() to authenticated;

-- ----------------------------------------------------------- device side --

create or replace function public.kiosk_face_match(_token text, _descriptor double precision[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  d record;
  best record;
  second_dist double precision;
  tk uuid;
  -- See the limits at the top of this file. A refused face can use the PIN.
  max_dist constant double precision := 0.80;
  min_margin constant double precision := 0.06;
begin
  select * into d from public.kiosk_devices where token = _token and revoked_at is null;
  if d.id is null then
    return jsonb_build_object('ok', false, 'message', 'This device link is no longer valid. Ask an admin for a new one.');
  end if;
  if d.face_locked_until is not null and d.face_locked_until > now() then
    return jsonb_build_object('ok', false, 'message', 'Too many faces not recognised. Use your PIN or try again in a minute.');
  end if;
  if _descriptor is null or array_ndims(_descriptor) <> 1 or array_length(_descriptor, 1) <> 1024
     or not public.face_values_ok(_descriptor) then
    return jsonb_build_object('ok', false, 'message', 'Face not recognised. Try again or use your PIN.');
  end if;

  delete from public.kiosk_face_tickets where expires_at < now();

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
revoke all on function public.kiosk_face_match(text, double precision[]) from public;
grant execute on function public.kiosk_face_match(text, double precision[]) to anon, authenticated;
