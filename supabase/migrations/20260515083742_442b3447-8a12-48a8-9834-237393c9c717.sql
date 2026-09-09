drop policy if exists "settings_read_authenticated" on public.app_settings;
create policy "settings_read_public"
  on public.app_settings for select
  to anon, authenticated
  using (true);