-- Shared clock-in: display mode and slideshow.
--
-- Apply after 20261122130000_multi_company_supervisor_scope.sql. Safe to run
-- more than once.
--
-- * kiosk_settings: one row per company. display_mode 'simple' (the keypad,
--   as before; also what a company with no row gets) or 'slideshow' (slides
--   play while nobody is using the clock). idle_seconds is how long the
--   keypad stays up after the last touch before the slideshow comes back.
-- * kiosk_slides: the company's slides. A picture (image_path in the
--   kiosk-slides bucket) or a message (title and body). Each has its own
--   display time, an order and an on/off switch.
-- * kiosk_display(_token): what the anonymous clock-in device reads. It
--   authenticates by the device token, like the other kiosk_* functions.
-- * Storage bucket kiosk-slides: public read (the device has no account, and
--   the pictures are meant for a screen anyone walking by sees), writes only
--   by an admin of the company named by the first folder of the path:
--   <company_id>/<file>.

-- ---------------------------------------------------------------------------
-- Settings

create table if not exists public.kiosk_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  display_mode text not null default 'simple'
    check (display_mode in ('simple', 'slideshow')),
  idle_seconds integer not null default 30
    check (idle_seconds between 5 and 3600),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.kiosk_settings enable row level security;

drop trigger if exists kiosk_settings_touch on public.kiosk_settings;
create trigger kiosk_settings_touch before update on public.kiosk_settings
for each row execute function public.touch_updated_at();

drop policy if exists kiosk_settings_admin_all on public.kiosk_settings;
create policy kiosk_settings_admin_all on public.kiosk_settings for all to authenticated
  using (public.has_role(auth.uid(), 'company_admin'::public.app_role, company_id)
         or public.has_role(auth.uid(), 'super_admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'company_admin'::public.app_role, company_id)
              or public.has_role(auth.uid(), 'super_admin'::public.app_role));

grant select, insert, update, delete on public.kiosk_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Slides

create table if not exists public.kiosk_slides (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('image', 'message')),
  title text check (title is null or char_length(title) <= 120),
  body text check (body is null or char_length(body) <= 1000),
  image_path text,
  duration_seconds integer not null default 8
    check (duration_seconds between 2 and 300),
  position integer not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  constraint kiosk_slides_has_content check (
    (kind = 'image' and image_path is not null
       and split_part(image_path, '/', 1) = company_id::text)
    or (kind = 'message' and coalesce(nullif(trim(title), ''), nullif(trim(body), '')) is not null)
  )
);

create index if not exists kiosk_slides_company_position
  on public.kiosk_slides (company_id, position);

alter table public.kiosk_slides enable row level security;

drop trigger if exists kiosk_slides_touch on public.kiosk_slides;
create trigger kiosk_slides_touch before update on public.kiosk_slides
for each row execute function public.touch_updated_at();

drop policy if exists kiosk_slides_admin_all on public.kiosk_slides;
create policy kiosk_slides_admin_all on public.kiosk_slides for all to authenticated
  using (public.has_role(auth.uid(), 'company_admin'::public.app_role, company_id)
         or public.has_role(auth.uid(), 'super_admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'company_admin'::public.app_role, company_id)
              or public.has_role(auth.uid(), 'super_admin'::public.app_role));

grant select, insert, update, delete on public.kiosk_slides to authenticated;

-- Put the selected company's slides in the given order, in one go.
create or replace function public.reorder_kiosk_slides(_ids uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  cid := public.current_company_id();
  if cid is null or not (public.has_role(uid, 'company_admin'::public.app_role, cid)
                         or public.has_role(uid, 'super_admin'::public.app_role)) then
    raise exception 'only a company admin can change the slideshow';
  end if;

  update public.kiosk_slides s
     set position = o.ord
    from unnest(_ids) with ordinality as o(id, ord)
   where s.id = o.id and s.company_id = cid;
end; $$;

revoke all on function public.reorder_kiosk_slides(uuid[]) from public, anon;
grant execute on function public.reorder_kiosk_slides(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- What the clock-in device shows. Anonymous: authenticated by the device
-- token. A revoked or unknown token gets ok:false; the device then stays on
-- the keypad, which reports the bad link itself.

create or replace function public.kiosk_display(_token text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  d record;
  st record;
  slides jsonb;
begin
  select id, company_id into d
    from public.kiosk_devices
   where token = _token and revoked_at is null;
  if d.id is null then
    return jsonb_build_object('ok', false);
  end if;

  select display_mode, idle_seconds into st
    from public.kiosk_settings where company_id = d.company_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'kind', s.kind,
           'title', s.title,
           'body', s.body,
           'image_path', s.image_path,
           'duration_seconds', s.duration_seconds
         ) order by s.position, s.created_at), '[]'::jsonb)
    into slides
    from public.kiosk_slides s
   where s.company_id = d.company_id and s.enabled;

  return jsonb_build_object(
    'ok', true,
    'mode', coalesce(st.display_mode, 'simple'),
    'idle_seconds', coalesce(st.idle_seconds, 30),
    'slides', slides
  );
end; $$;

revoke all on function public.kiosk_display(text) from public;
grant execute on function public.kiosk_display(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'kiosk-slides', 'kiosk-slides', true, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Storage requests do not carry the x-company-id header, so this cannot use
-- has_role()'s "selected company" rule. It checks the company named in the
-- path directly: an active admin there, or a super admin.
create or replace function public.can_manage_kiosk_slide_object(_name text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  folder text := split_part(coalesce(_name, ''), '/', 1);
  cid uuid;
begin
  if uid is null then return false; end if;
  if folder !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  cid := folder::uuid;
  return exists (
           select 1
             from public.user_roles r
             join public.company_memberships m
               on m.user_id = r.user_id and m.company_id = r.company_id and m.status = 'active'
            where r.user_id = uid
              and r.company_id = cid
              and r.role = 'company_admin'::public.app_role
         )
      or exists (
           select 1 from public.user_roles r
            where r.user_id = uid and r.role = 'super_admin'::public.app_role
         );
end; $$;

revoke all on function public.can_manage_kiosk_slide_object(text) from public, anon;
grant execute on function public.can_manage_kiosk_slide_object(text) to authenticated;

drop policy if exists kiosk_slides_objects_read on storage.objects;
create policy kiosk_slides_objects_read on storage.objects for select to authenticated
  using (bucket_id = 'kiosk-slides' and public.can_manage_kiosk_slide_object(name));

drop policy if exists kiosk_slides_objects_insert on storage.objects;
create policy kiosk_slides_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'kiosk-slides' and public.can_manage_kiosk_slide_object(name));

drop policy if exists kiosk_slides_objects_update on storage.objects;
create policy kiosk_slides_objects_update on storage.objects for update to authenticated
  using (bucket_id = 'kiosk-slides' and public.can_manage_kiosk_slide_object(name))
  with check (bucket_id = 'kiosk-slides' and public.can_manage_kiosk_slide_object(name));

drop policy if exists kiosk_slides_objects_delete on storage.objects;
create policy kiosk_slides_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'kiosk-slides' and public.can_manage_kiosk_slide_object(name));
