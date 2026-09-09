-- Enforce plan capabilities in the database, not just the interface.
--
-- Hiding a nav item stops an honest user; it does nothing against someone who
-- calls `clock_punch` directly with a fetch. These guards sit on the tables
-- rather than inside the RPCs, so every route in — the RPCs, a direct insert
-- through PostgREST, a future function nobody has written yet — hits the same
-- check, and the RPC bodies stay untouched.

create or replace function public.require_capability(_company uuid, _key text, _label text)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.company_has_capability(_company, _key) then
    raise exception '% is not included in your plan. Ask an administrator to upgrade the subscription.', _label
      using errcode = 'check_violation';
  end if;
end;
$$;

revoke all on function public.require_capability(uuid, text, text) from public, anon;
grant execute on function public.require_capability(uuid, text, text) to authenticated;

-- ---- time clock ----

create or replace function public.enforce_time_clock_capability()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_capability(NEW.company_id, 'time_clock', 'The time clock');
  return NEW;
end;
$$;

drop trigger if exists trg_enforce_time_clock on public.time_punches;
create trigger trg_enforce_time_clock
before insert on public.time_punches
for each row execute function public.enforce_time_clock_capability();

-- ---- schedule building ----

create or replace function public.enforce_schedule_capability()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Releasing a schedule is a separate grant from drawing one, so a plan can
  -- include the builder without the ability to publish.
  if TG_OP = 'UPDATE' and NEW.published and not coalesce(OLD.published, false) then
    perform public.require_capability(NEW.company_id, 'schedule_publish', 'Posting schedules');
  else
    perform public.require_capability(NEW.company_id, 'schedule_design', 'The schedule builder');
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_enforce_schedule on public.shifts;
create trigger trg_enforce_schedule
before insert or update on public.shifts
for each row execute function public.enforce_schedule_capability();

notify pgrst, 'reload schema';
