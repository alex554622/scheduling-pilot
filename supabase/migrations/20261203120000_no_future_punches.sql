-- A punch can't be in the future.
--
-- Every clock (phone, shared tablet, break buttons) decides in/out from the
-- person's latest punch by time. A punch typed into a timecard with a future
-- date (an "out" on Dec 12 entered in November) stays "latest" until that date
-- arrives, so the person reads as clocked out and can only ever clock in again:
-- each code on the shared clock-in added another clock-in and no clock-out or
-- break was ever offered.
--
-- The clocks themselves stamp now(); only manager_insert_punch and
-- manager_update_punch take a chosen time, so this only refuses a mistyped
-- correction. Five minutes of slack covers a device clock that runs a little
-- ahead.
--
-- Punches already in the future are not touched here: list them with
--   select user_id, kind, at from public.time_punches where at > now();
-- and remove them from Timecards (audited) or delete them by hand.

begin;

create or replace function public.reject_future_punch()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.at is not distinct from old.at then
    return new;
  end if;
  if new.at > now() + interval '5 minutes' then
    raise exception 'A punch can''t be in the future. Check the date and time.';
  end if;
  return new;
end; $$;
revoke all on function public.reject_future_punch() from public, anon, authenticated;

drop trigger if exists trg_reject_future_punch on public.time_punches;
create trigger trg_reject_future_punch
before insert or update of at on public.time_punches
for each row execute function public.reject_future_punch();

commit;

notify pgrst, 'reload schema';
