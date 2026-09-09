create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

create policy "settings_read_authenticated"
  on public.app_settings for select
  to authenticated
  using (true);

create policy "settings_super_admin_write"
  on public.app_settings for all
  to authenticated
  using (public.has_role(auth.uid(), 'super_admin'::app_role))
  with check (public.has_role(auth.uid(), 'super_admin'::app_role));

insert into public.app_settings (key, value)
values ('payments_enabled', 'false'::jsonb)
on conflict (key) do nothing;

alter publication supabase_realtime add table public.app_settings;
alter table public.app_settings replica identity full;