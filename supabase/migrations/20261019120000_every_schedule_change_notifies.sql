-- Every change to someone's posted schedule tells them.
--
-- The shift triggers (20260920120000, reworded in 20260930120000) covered a
-- published shift moving, changing hands or being deleted. Three changes still
-- reached the employee's schedule in silence:
--
--   * A shift inserted already published: a copy, a template run or anything
--     else that writes `published = true` straight away. Only UPDATEs were
--     watched, so nobody heard about it.
--   * A published shift taken back to draft. It vanishes from the employee's
--     schedule (drafts never leave the builder) exactly as if it had been
--     deleted, so it is announced the same way.
--   * A published shift whose break, notes, location, department or position
--     changed but whose times did not. Only times and the position name were
--     compared.
--
-- And one that was said twice: a draft reassigned and published in the same
-- UPDATE got both "New schedule published" and "A shift was added".
--
-- Each of these is a `notifications` row, so `trg_push_for_notification`
-- (20260922120000) queues it for the phone like every other one.
--
-- Re-runnable; applied by hand in Studio.

create or replace function public.notify_shift_changes()
returns trigger language plpgsql security definer set search_path = public
as $fn$
begin
  -- Newly published, whoever it belongs to.
  insert into public.notifications (user_id, type, title, body, link)
  select s.employee_id, 'schedule_published', 'New schedule published',
         case when count(*) = 1
              then 'Your shift: ' || public.shift_when(min(s.starts_at), min(s.ends_at), min(s.tz))
              else count(*) || ' shifts: '
                   || string_agg(public.shift_day(s.starts_at, s.tz), ', ' order by s.starts_at)
         end,
         '/schedule'
    from (select n.employee_id, n.starts_at, n.ends_at, c.timezone as tz
            from newrows n join oldrows o on o.id = n.id
            left join public.companies c on c.id = n.company_id
           where n.published and not o.published
             and n.employee_id is not null
             and public.wants_notification(n.employee_id, 'schedule_published')) s
   group by s.employee_id;

  -- A published shift of theirs changed, on whatever day and in whatever way.
  -- A draft being rearranged is the builder's business and says nothing to
  -- anybody.
  insert into public.notifications (user_id, type, title, body, link)
  select s.employee_id, 'schedule_changed',
         case when count(*) = 1 then 'Your shift changed'
              else count(*) || ' of your shifts changed' end,
         case when count(*) = 1 then
                public.shift_when(min(s.starts_at), min(s.ends_at), min(s.tz))
                || case
                     when min(s.old_starts) = min(s.starts_at) and min(s.old_ends) = min(s.ends_at)
                       then case when bool_or(s.position_changed)
                                 then coalesce(' · now ' || nullif(min(s.position), ''), ' · details updated')
                                 else ' · details updated' end
                     when public.shift_day(min(s.old_starts), min(s.tz))
                          = public.shift_day(min(s.starts_at), min(s.tz))
                       then ' (was ' || public.shift_hours(min(s.old_starts), min(s.old_ends), min(s.tz)) || ')'
                     else ' (was ' || public.shift_when(min(s.old_starts), min(s.old_ends), min(s.tz)) || ')'
                   end
              else string_agg(public.shift_day(s.starts_at, s.tz), ', ' order by s.starts_at)
         end,
         '/schedule'
    from (select n.employee_id, n.starts_at, n.ends_at, n.position,
                 o.starts_at as old_starts, o.ends_at as old_ends, c.timezone as tz,
                 (n.position is distinct from o.position
                  or n.position_id is distinct from o.position_id) as position_changed
            from newrows n join oldrows o on o.id = n.id
            left join public.companies c on c.id = n.company_id
           where n.published and o.published
             and n.employee_id is not null
             and n.employee_id is not distinct from o.employee_id
             and (n.starts_at <> o.starts_at
                  or n.ends_at <> o.ends_at
                  or n.position is distinct from o.position
                  or n.position_id is distinct from o.position_id
                  or n.break_minutes is distinct from o.break_minutes
                  or n.notes is distinct from o.notes
                  or n.location_id is distinct from o.location_id
                  or n.department_id is distinct from o.department_id)
             and public.wants_notification(n.employee_id, 'schedule_changed')) s
   group by s.employee_id;

  -- Handed to somebody else: the person losing it needs to know first.
  insert into public.notifications (user_id, type, title, body, link)
  select s.employee_id, 'schedule_changed',
         case when count(*) = 1 then 'A shift came off your schedule'
              else count(*) || ' shifts came off your schedule' end,
         case when count(*) = 1
              then public.shift_when(min(s.starts_at), min(s.ends_at), min(s.tz)) || ' is no longer yours.'
              else string_agg(public.shift_day(s.starts_at, s.tz), ', ' order by s.starts_at)
         end,
         '/schedule'
    from (select o.employee_id, o.starts_at, o.ends_at, c.timezone as tz
            from newrows n join oldrows o on o.id = n.id
            left join public.companies c on c.id = o.company_id
           where o.published
             and o.employee_id is not null
             and n.employee_id is distinct from o.employee_id
             and public.wants_notification(o.employee_id, 'schedule_changed')) s
   group by s.employee_id;

  -- …and the person picking it up. Only a shift that was already posted: a
  -- draft handed over and published in the same UPDATE is the publish notice
  -- above, and used to arrive twice.
  insert into public.notifications (user_id, type, title, body, link)
  select s.employee_id, 'schedule_changed',
         case when count(*) = 1 then 'A shift was added to your schedule'
              else count(*) || ' shifts were added to your schedule' end,
         case when count(*) = 1
              then public.shift_when(min(s.starts_at), min(s.ends_at), min(s.tz))
              else string_agg(public.shift_day(s.starts_at, s.tz), ', ' order by s.starts_at)
         end,
         '/schedule'
    from (select n.employee_id, n.starts_at, n.ends_at, c.timezone as tz
            from newrows n join oldrows o on o.id = n.id
            left join public.companies c on c.id = n.company_id
           where n.published and o.published
             and n.employee_id is not null
             and n.employee_id is distinct from o.employee_id
             and public.wants_notification(n.employee_id, 'schedule_changed')) s
   group by s.employee_id;

  -- Taken back to draft: gone from their schedule, same as a delete. Someone
  -- who also lost it to another person above has already been told.
  insert into public.notifications (user_id, type, title, body, link)
  select s.employee_id, 'schedule_changed',
         case when count(*) = 1 then 'A shift was removed'
              else count(*) || ' shifts were removed' end,
         case when count(*) = 1
              then public.shift_when(min(s.starts_at), min(s.ends_at), min(s.tz)) || ' is off your schedule.'
              else string_agg(public.shift_day(s.starts_at, s.tz), ', ' order by s.starts_at)
         end,
         '/schedule'
    from (select o.employee_id, o.starts_at, o.ends_at, c.timezone as tz
            from newrows n join oldrows o on o.id = n.id
            left join public.companies c on c.id = o.company_id
           where o.published and not n.published
             and o.employee_id is not null
             and n.employee_id is not distinct from o.employee_id
             and public.wants_notification(o.employee_id, 'schedule_changed')) s
   group by s.employee_id;

  return null;
end;
$fn$;
revoke all on function public.notify_shift_changes() from public, anon, authenticated;

-- --------------------------------------------------------- published on insert
-- One statement, one notification per person, like publishing a week.
create or replace function public.notify_shifts_added()
returns trigger language plpgsql security definer set search_path = public
as $fn$
begin
  insert into public.notifications (user_id, type, title, body, link)
  select s.employee_id, 'schedule_changed',
         case when count(*) = 1 then 'A shift was added to your schedule'
              else count(*) || ' shifts were added to your schedule' end,
         case when count(*) = 1
              then public.shift_when(min(s.starts_at), min(s.ends_at), min(s.tz))
              else string_agg(public.shift_day(s.starts_at, s.tz), ', ' order by s.starts_at)
         end,
         '/schedule'
    from (select n.employee_id, n.starts_at, n.ends_at, c.timezone as tz
            from newrows n
            left join public.companies c on c.id = n.company_id
           where n.published
             and n.employee_id is not null
             and public.wants_notification(n.employee_id, 'schedule_changed')) s
   group by s.employee_id;
  return null;
end;
$fn$;
revoke all on function public.notify_shifts_added() from public, anon, authenticated;

drop trigger if exists trg_notify_shifts_added on public.shifts;
create trigger trg_notify_shifts_added
after insert on public.shifts
referencing new table as newrows
for each statement execute function public.notify_shifts_added();
