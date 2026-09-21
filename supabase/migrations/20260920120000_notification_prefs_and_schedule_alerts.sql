-- Notifications people can switch off, and the schedule alerts that were never
-- being sent.
--
-- Two gaps this closes:
--
--  * Publishing from the schedule builder updates `shifts.published` directly
--    and never touches the `schedules` table, so `notify_schedule_published`
--    — which watches that table — never fired. A published week reached the
--    employee's screen and told them nothing.
--  * Nobody could turn a notification off.
--
-- `authenticated` still has no INSERT on `notifications` and does not get one
-- here: rows are only ever written by a definer function, as before.

-- ---------------------------------------------------------------- preferences
alter table public.profiles
  add column if not exists notification_prefs jsonb not null default '{}'::jsonb;

comment on column public.profiles.notification_prefs is
  'Per-user notification switches. Anything unsaid is on: {"enabled": false} '
  'mutes the lot, {"types": {"schedule_changed": false}} mutes one kind.';

-- Does this person want to hear about `_type`?
--
-- Anything unsaid is a yes, so a company that never opens the screen keeps the
-- behaviour it had before this column existed.
create or replace function public.wants_notification(_user uuid, _type text)
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select coalesce((p.notification_prefs ->> 'enabled')::boolean, true)
        and coalesce((p.notification_prefs -> 'types' ->> _type)::boolean, true)
       from public.profiles p where p.id = _user),
    true
  );
$$;
revoke all on function public.wants_notification(uuid, text) from public, anon;
grant execute on function public.wants_notification(uuid, text) to authenticated;

-- ------------------------------------------------------------ shift changes
-- Statement-level with transition tables, not row-level: publishing a week is
-- one UPDATE over hundreds of rows, and an employee wants one notification
-- about their schedule, not one per shift.
create or replace function public.notify_shift_changes()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  -- Newly published, whoever it belongs to.
  insert into public.notifications (user_id, type, title, body, link)
  select distinct n.employee_id, 'schedule_published', 'New schedule published',
         'Your shifts have been published. Open your schedule to see them.', '/schedule'
    from newrows n join oldrows o on o.id = n.id
   where n.published and not o.published
     and n.employee_id is not null
     and public.wants_notification(n.employee_id, 'schedule_published');

  -- A published shift of theirs moved. A draft being rearranged is the
  -- builder's business and says nothing to anybody.
  insert into public.notifications (user_id, type, title, body, link)
  select distinct n.employee_id, 'schedule_changed', 'Your schedule changed',
         'A published shift of yours has been changed. Open your schedule to check the times.',
         '/schedule'
    from newrows n join oldrows o on o.id = n.id
   where n.published and o.published
     and n.employee_id is not null
     and n.employee_id is not distinct from o.employee_id
     and (n.starts_at <> o.starts_at
          or n.ends_at <> o.ends_at
          or n.position is distinct from o.position)
     and public.wants_notification(n.employee_id, 'schedule_changed');

  -- Handed to somebody else: the person losing it needs to know first.
  insert into public.notifications (user_id, type, title, body, link)
  select distinct o.employee_id, 'schedule_changed', 'A shift came off your schedule',
         'A published shift is no longer yours. Open your schedule to see what is left.',
         '/schedule'
    from newrows n join oldrows o on o.id = n.id
   where o.published
     and o.employee_id is not null
     and n.employee_id is distinct from o.employee_id
     and public.wants_notification(o.employee_id, 'schedule_changed');

  -- …and the person picking it up.
  insert into public.notifications (user_id, type, title, body, link)
  select distinct n.employee_id, 'schedule_changed', 'A shift was added to your schedule',
         'A published shift has been assigned to you. Open your schedule to see it.',
         '/schedule'
    from newrows n join oldrows o on o.id = n.id
   where n.published
     and n.employee_id is not null
     and n.employee_id is distinct from o.employee_id
     and public.wants_notification(n.employee_id, 'schedule_changed');

  return null;
end;
$$;
revoke all on function public.notify_shift_changes() from public, anon, authenticated;

drop trigger if exists trg_notify_shift_changes on public.shifts;
create trigger trg_notify_shift_changes
after update on public.shifts
referencing old table as oldrows new table as newrows
for each statement execute function public.notify_shift_changes();

-- A published shift that is deleted is a change like any other. Clearing a row
-- or erasing a run of days is one DELETE, so this stays one notification.
create or replace function public.notify_shifts_removed()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.notifications (user_id, type, title, body, link)
  select distinct o.employee_id, 'schedule_changed', 'A shift was removed',
         'A published shift of yours has been removed. Open your schedule to check the week.',
         '/schedule'
    from oldrows o
   where o.published
     and o.employee_id is not null
     and public.wants_notification(o.employee_id, 'schedule_changed');
  return null;
end;
$$;
revoke all on function public.notify_shifts_removed() from public, anon, authenticated;

drop trigger if exists trg_notify_shifts_removed on public.shifts;
create trigger trg_notify_shifts_removed
after delete on public.shifts
referencing old table as oldrows
for each statement execute function public.notify_shifts_removed();

-- The schedules-table trigger now double-announces: publishing a schedule row
-- releases its shifts (see 20260831003418), and that UPDATE is what the trigger
-- above answers. One publish, one notification — so the older one stands down.
-- Its link was '/today', a route that does not exist, which is the other reason
-- it is no loss.
drop trigger if exists trg_notify_schedule_published on public.schedules;
