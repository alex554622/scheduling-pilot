-- Lock-screen notifications for the Android and iOS apps.
--
-- The website reaches a closed browser through Web Push: `push_subscriptions`
-- holds an endpoint and the keys to encrypt to it. The apps' web view has no
-- Push API, so they register with the phone's own push service instead and get
-- back a single opaque token — an FCM registration token on Android, an APNs
-- device token on iOS. That is a different shape of thing (no endpoint, no
-- keys, a platform that decides who to send it to), so it gets its own table
-- rather than nullable columns on the web one. `push_subscriptions`, and every
-- website that reads it, is left exactly as it was.
--
-- Nothing about *what* gets sent changes: the same triggers fill the same
-- `push_queue`, and the dispatcher on the website's server now delivers each
-- row to the person's web subscriptions and their app devices alike.
--
-- Additive only, so app versions already in people's hands and the website
-- keep working whether or not this has been applied. Re-runnable; applied by
-- hand in Studio.

create table if not exists public.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Which push service the token belongs to: FCM for android, APNs for ios.
  platform text not null check (platform in ('android', 'ios')),
  -- The token *is* the device, the way an endpoint is for web push: unique, so
  -- a phone that re-registers on every start-up updates its row instead of
  -- collecting duplicates that would each get the notification.
  token text not null unique,
  -- Only for support conversations ("which version is on your phone?").
  app_version text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists push_devices_user_idx on public.push_devices (user_id);

alter table public.push_devices enable row level security;
grant select, delete on public.push_devices to authenticated;
grant all on public.push_devices to service_role;

-- Your own devices, and nobody else's. Reading and removing go straight
-- through RLS; writing goes through `register_push_device` below.
drop policy if exists push_devices_own on public.push_devices;
create policy push_devices_own on public.push_devices
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- File this phone's token under whoever is signed in on it now.
--
-- A function rather than a plain upsert because of shared phones and tablets.
-- If the last person to use the device could not be signed out cleanly (no
-- signal, app force-closed) their row still holds the token, RLS will not let
-- the next person overwrite it, and the device would keep receiving the
-- previous person's notifications. Web push gets round that by asking the
-- browser for a fresh endpoint; a phone's push token cannot be re-rolled from
-- the app. So the token moves to the caller. Only the device holding the token
-- ever learns it, so the caller is that device.
create or replace function public.register_push_device(
  _token text,
  _platform text,
  _app_version text default null
) returns void
language plpgsql security definer set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if _platform not in ('android', 'ios') then
    raise exception 'unknown platform %', _platform;
  end if;
  if _token is null or length(_token) < 32 or length(_token) > 4096 then
    raise exception 'not a push token';
  end if;

  insert into public.push_devices (user_id, platform, token, app_version)
  values (auth.uid(), _platform, _token, left(_app_version, 50))
  on conflict (token) do update
     set user_id = excluded.user_id,
         platform = excluded.platform,
         app_version = excluded.app_version,
         last_seen_at = now();
end;
$fn$;
revoke all on function public.register_push_device(text, text, text) from public, anon;
grant execute on function public.register_push_device(text, text, text) to authenticated;
