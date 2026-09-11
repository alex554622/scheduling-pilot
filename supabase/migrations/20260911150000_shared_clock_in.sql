-- Shared clock-in device (a tablet by the door) and the 4-digit codes staff
-- use on it.
--
-- The device belongs to no account. It holds one long random token and can
-- only call the kiosk_* functions below, so nothing on that device reaches the
-- app's account area even if someone types a URL.
--
-- Codes live in their own table rather than on profiles: every member of a
-- company can read their colleagues' profile rows, and a clock-in code is a
-- credential, not a roster field.
--
-- Wrong-code attempts are counted on the device row, so the kiosk functions
-- report failures in their return value instead of raising: a raised exception
-- would roll that counter back with the rest of the transaction.
--
-- Re-runnable; applied by hand in Studio.

create table if not exists public.kiosk_devices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  label text not null default 'Shared clock-in',
  token text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  -- The token is secret, but a code is only four digits.
  failed_attempts integer not null default 0,
  locked_until timestamptz
);
create index if not exists kiosk_devices_company_idx on public.kiosk_devices(company_id);
alter table public.kiosk_devices enable row level security;

create table if not exists public.employee_clock_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null check (code ~ '^[0-9]{4}$'),
  updated_at timestamptz not null default now(),
  unique (company_id, code)
);
alter table public.employee_clock_codes enable row level security;

-- Only the company's own admins (and platform super admins) see or change
-- either table. The kiosk functions below are SECURITY DEFINER, so they are
-- not bound by these policies.
drop policy if exists kiosk_devices_admin_all on public.kiosk_devices;
create policy kiosk_devices_admin_all on public.kiosk_devices for all to authenticated
using (
  exists (select 1 from public.user_roles r
           where r.user_id = auth.uid() and r.role = 'company_admin'::public.app_role
             and r.company_id = kiosk_devices.company_id)
  or exists (select 1 from public.user_roles r
              where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role)
)
with check (
  exists (select 1 from public.user_roles r
           where r.user_id = auth.uid() and r.role = 'company_admin'::public.app_role
             and r.company_id = kiosk_devices.company_id)
  or exists (select 1 from public.user_roles r
              where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role)
);

drop policy if exists employee_clock_codes_admin_all on public.employee_clock_codes;
create policy employee_clock_codes_admin_all on public.employee_clock_codes for all to authenticated
using (
  exists (select 1 from public.user_roles r
           where r.user_id = auth.uid() and r.role = 'company_admin'::public.app_role
             and r.company_id = employee_clock_codes.company_id)
  or exists (select 1 from public.user_roles r
              where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role)
)
with check (
  exists (select 1 from public.user_roles r
           where r.user_id = auth.uid() and r.role = 'company_admin'::public.app_role
             and r.company_id = employee_clock_codes.company_id)
  or exists (select 1 from public.user_roles r
              where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role)
);

grant select on public.kiosk_devices to authenticated;
grant select on public.employee_clock_codes to authenticated;
grant all on public.kiosk_devices to service_role;
grant all on public.employee_clock_codes to service_role;

-- ---- admin side ----

create or replace function public.create_kiosk_device(_label text default 'Shared clock-in')
returns public.kiosk_devices
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  row public.kiosk_devices;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select company_id into cid from public.profiles where id = uid;
  if cid is null then raise exception 'you must be a member of a company'; end if;
  if not exists (select 1 from public.user_roles r
                  where r.user_id = uid and r.company_id = cid
                    and r.role = 'company_admin'::public.app_role) then
    raise exception 'only a company admin can set up a shared clock-in device';
  end if;

  insert into public.kiosk_devices (company_id, label, token, created_by)
  values (
    cid,
    coalesce(nullif(trim(_label), ''), 'Shared clock-in'),
    -- 64 hex characters from two v4 UUIDs, so this needs no pgcrypto.
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
    uid
  )
  returning * into row;
  return row;
end; $$;

create or replace function public.revoke_kiosk_device(_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  update public.kiosk_devices d
     set revoked_at = now()
   where d.id = _id
     and exists (select 1 from public.user_roles r
                  where r.user_id = uid and r.company_id = d.company_id
                    and r.role = 'company_admin'::public.app_role);
  if not found then raise exception 'device not found'; end if;
end; $$;

create or replace function public.set_employee_clock_code(_user uuid)
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
  select company_id into cid from public.profiles where id = _user;
  if cid is null then raise exception 'that person is not in a company'; end if;
  if not exists (select 1 from public.user_roles r
                  where r.user_id = uid and r.company_id = cid
                    and r.role = 'company_admin'::public.app_role) then
    raise exception 'only a company admin can issue clock-in codes';
  end if;

  loop
    tries := tries + 1;
    candidate := lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (
      select 1 from public.employee_clock_codes
       where company_id = cid and code = candidate and user_id <> _user
    );
    if tries > 200 then raise exception 'could not find a free code - clear some old ones first'; end if;
  end loop;

  insert into public.employee_clock_codes (user_id, company_id, code)
  values (_user, cid, candidate)
  on conflict (user_id) do update
    set code = excluded.code, company_id = excluded.company_id, updated_at = now();

  return candidate;
end; $$;

create or replace function public.clear_employee_clock_code(_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  delete from public.employee_clock_codes c
   where c.user_id = _user
     and exists (select 1 from public.user_roles r
                  where r.user_id = uid and r.company_id = c.company_id
                    and r.role = 'company_admin'::public.app_role);
end; $$;

revoke all on function public.create_kiosk_device(text) from public, anon;
revoke all on function public.revoke_kiosk_device(uuid) from public, anon;
revoke all on function public.set_employee_clock_code(uuid) from public, anon;
revoke all on function public.clear_employee_clock_code(uuid) from public, anon;
grant execute on function public.create_kiosk_device(text) to authenticated;
grant execute on function public.revoke_kiosk_device(uuid) to authenticated;
grant execute on function public.set_employee_clock_code(uuid) to authenticated;
grant execute on function public.clear_employee_clock_code(uuid) to authenticated;

-- ---- the device side ----

-- Shared by the two device functions below, and granted to nobody: it is only
-- reachable through them.
create or replace function public.kiosk_resolve(_token text, _code text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  d record;
  p record;
begin
  select * into d from public.kiosk_devices where token = _token and revoked_at is null;
  if d.id is null then
    return jsonb_build_object('ok', false, 'message', 'This device link is no longer valid. Ask an admin for a new one.');
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

create or replace function public.kiosk_device_info(_token text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  d record;
  cname text;
begin
  select * into d from public.kiosk_devices where token = _token and revoked_at is null;
  if d.id is null then
    return jsonb_build_object('ok', false, 'message', 'This device link is no longer valid. Ask an admin for a new one.');
  end if;
  select name into cname from public.companies where id = d.company_id;
  return jsonb_build_object('ok', true, 'company', cname, 'label', d.label);
end; $$;

-- What the screen should offer next for this code.
create or replace function public.kiosk_state(_token text, _code text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
  last_kind text;
  s jsonb;
begin
  r := public.kiosk_resolve(_token, _code);
  if not (r->>'ok')::boolean then return r; end if;

  select kind into last_kind from public.time_punches
   where user_id = (r->>'user_id')::uuid
   order by at desc, created_at desc, id desc
   limit 1;

  select coalesce(settings, '{}'::jsonb) into s from public.companies where id = (r->>'company_id')::uuid;

  return jsonb_build_object(
    'ok', true,
    'name', r->>'name',
    'state', case
               when last_kind is null or last_kind = 'out' then 'out'
               when last_kind = 'break_start' then 'on_break'
               else 'in'
             end,
    'breaks', jsonb_build_object(
      '10', coalesce((s->>'allow_break_10')::boolean, true),
      '30', coalesce((s->>'allow_break_30')::boolean, true),
      '60', coalesce((s->>'allow_break_60')::boolean, true)
    )
  );
end; $$;

-- One punch from the device. `_action` is 'clock' or 'break'; the direction
-- comes from the last punch, exactly as clock_punch and break_punch decide it.
--
-- No geofence check: the shared device is fixed at the worksite, unlike the
-- phone in a pocket that the personal time clock has to verify. The company's
-- own coordinates are recorded so the punch still carries a place.
create or replace function public.kiosk_punch(_token text, _code text, _action text, _minutes integer default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
  uid uuid;
  cid uuid;
  c record;
  s jsonb;
  last_kind text;
  last_break_minutes int;
  next_kind text;
  bmin int;
  row public.time_punches;
begin
  r := public.kiosk_resolve(_token, _code);
  if not (r->>'ok')::boolean then return r; end if;
  uid := (r->>'user_id')::uuid;
  cid := (r->>'company_id')::uuid;

  select latitude, longitude, coalesce(settings, '{}'::jsonb) as settings into c
    from public.companies where id = cid;
  s := c.settings;

  select kind, break_minutes into last_kind, last_break_minutes
    from public.time_punches
   where user_id = uid
   order by at desc, created_at desc, id desc
   limit 1;

  if _action = 'clock' then
    next_kind := case when last_kind is null or last_kind = 'out' then 'in' else 'out' end;
    bmin := null;
  elsif _action = 'break' then
    if last_kind is null or last_kind = 'out' then
      return jsonb_build_object('ok', false, 'message', 'Clock in before starting a break.');
    end if;
    next_kind := case when last_kind = 'break_start' then 'break_end' else 'break_start' end;
    if next_kind = 'break_start' then
      if _minutes is null or _minutes not in (10, 30, 60) then
        return jsonb_build_object('ok', false, 'message', 'Pick a break length: 10, 30 or 60 minutes.');
      end if;
      if (_minutes = 10 and not coalesce((s->>'allow_break_10')::boolean, true))
         or (_minutes = 30 and not coalesce((s->>'allow_break_30')::boolean, true))
         or (_minutes = 60 and not coalesce((s->>'allow_break_60')::boolean, true)) then
        return jsonb_build_object('ok', false, 'message', 'That break length is turned off in your App rules.');
      end if;
      bmin := _minutes;
    else
      bmin := last_break_minutes;
    end if;
  else
    return jsonb_build_object('ok', false, 'message', 'Unknown action.');
  end if;

  insert into public.time_punches (user_id, company_id, kind, latitude, longitude, distance_m, within_geofence, break_minutes)
  values (uid, cid, next_kind, c.latitude, c.longitude,
          case when c.latitude is not null then 0 else null end, true, bmin)
  returning * into row;

  return jsonb_build_object('ok', true, 'name', r->>'name', 'kind', row.kind, 'at', row.at);
end; $$;

revoke all on function public.kiosk_resolve(text, text) from public, anon, authenticated;
revoke all on function public.kiosk_device_info(text) from public;
revoke all on function public.kiosk_state(text, text) from public;
revoke all on function public.kiosk_punch(text, text, text, integer) from public;
grant execute on function public.kiosk_device_info(text) to anon, authenticated;
grant execute on function public.kiosk_state(text, text) to anon, authenticated;
grant execute on function public.kiosk_punch(text, text, text, integer) to anon, authenticated;
