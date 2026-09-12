-- How long a company keeps its schedule and timecard history.
--
-- A platform super admin sets the window per company — six months, a year, or
-- keep everything — and can see how much history each one is holding. Nothing
-- is deleted on a timer: the purge is an explicit action, so a company's
-- records never disappear because a background job decided they should.
--
-- `data_retention_months` null means unlimited.
--
-- Re-runnable; applied by hand in Studio.

alter table public.companies
  add column if not exists data_retention_months integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'companies_retention_check') then
    alter table public.companies
      add constraint companies_retention_check
      check (data_retention_months is null or data_retention_months between 1 and 120);
  end if;
end $$;

/** True when the caller runs the platform, which is the only role these two answer to. */
create or replace function public.is_platform_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
     where user_id = auth.uid() and role = 'super_admin'::public.app_role
  );
$$;

-- What a company is holding, and how much of it sits beyond its window.
create or replace function public.company_history_stats(_company uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  months integer;
  cutoff timestamptz;
begin
  if not public.is_platform_admin() then raise exception 'not authorized'; end if;

  select data_retention_months into months from public.companies where id = _company;
  cutoff := case when months is null then null else now() - make_interval(months => months) end;

  return jsonb_build_object(
    'retention_months', months,
    'cutoff', cutoff,
    'punches', (select count(*) from public.time_punches where company_id = _company),
    'shifts', (select count(*) from public.shifts where company_id = _company),
    'oldest_punch', (select min(at) from public.time_punches where company_id = _company),
    'oldest_shift', (select min(starts_at) from public.shifts where company_id = _company),
    'punches_past_window',
      (select count(*) from public.time_punches
        where company_id = _company and cutoff is not null and at < cutoff),
    'shifts_past_window',
      (select count(*) from public.shifts
        where company_id = _company and cutoff is not null and starts_at < cutoff)
  );
end; $$;

-- Delete everything older than the company's window. Refuses when the window
-- is unlimited, so "keep everything" cannot be purged by a stray click.
create or replace function public.purge_company_history(_company uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  months integer;
  cutoff timestamptz;
  punches_deleted integer := 0;
  shifts_deleted integer := 0;
begin
  if not public.is_platform_admin() then raise exception 'not authorized'; end if;

  select data_retention_months into months from public.companies where id = _company;
  if months is null then
    raise exception 'This company keeps its history indefinitely. Set a retention window first.';
  end if;
  cutoff := now() - make_interval(months => months);

  delete from public.time_punches where company_id = _company and at < cutoff;
  get diagnostics punches_deleted = row_count;

  delete from public.shifts where company_id = _company and starts_at < cutoff;
  get diagnostics shifts_deleted = row_count;

  return jsonb_build_object(
    'cutoff', cutoff,
    'punches_deleted', punches_deleted,
    'shifts_deleted', shifts_deleted
  );
end; $$;

revoke all on function public.is_platform_admin() from public, anon;
revoke all on function public.company_history_stats(uuid) from public, anon;
revoke all on function public.purge_company_history(uuid) from public, anon;
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.company_history_stats(uuid) to authenticated;
grant execute on function public.purge_company_history(uuid) to authenticated;
