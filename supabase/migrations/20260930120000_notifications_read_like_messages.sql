-- Notifications that say what happened, the way a chat app's do.
--
-- A push lands on a lock screen, and a lock screen is read in a glance. "A
-- published shift of yours has been changed. Open your schedule to check the
-- times." makes the person unlock the phone and go looking; "Tue Oct 1,
-- 9:00 AM – 5:00 PM (was 8:00 AM – 4:00 PM)" is the answer itself. Board
-- messages likewise now read as sender and words, not "X posted a message".
--
-- Only the wording changes. Which events notify, who hears about them and the
-- preference checks are exactly as in 20260920120000 and 20260922120000, and
-- the triggers themselves are untouched: `create or replace` swaps the bodies
-- in under the same names.
--
-- Re-runnable; applied by hand in Studio.

-- ------------------------------------------------------------------ wording
-- "Tue Oct 1, 9:00 AM – 5:00 PM" in the company's own time.
--
-- This runs inside the trigger that saves a shift, so it must never be the
-- reason a shift fails to save. A timezone Postgres does not recognise falls
-- back to UTC instead of raising.
create or replace function public.shift_when(_start timestamptz, _end timestamptz, _tz text)
returns text language plpgsql stable set search_path = public
as $fn$
declare
  tz text := coalesce(nullif(_tz, ''), 'UTC');
begin
  begin
    perform _start at time zone tz;
  exception when others then
    tz := 'UTC';
  end;
  return to_char(_start at time zone tz, 'Dy Mon FMDD') || ', '
      || to_char(_start at time zone tz, 'FMHH12:MI AM') || ' – '
      || to_char(_end at time zone tz, 'FMHH12:MI AM');
end;
$fn$;

-- Just the time span, for "(was …)" when the day has not moved.
create or replace function public.shift_hours(_start timestamptz, _end timestamptz, _tz text)
returns text language sql stable set search_path = public
as $fn$
  select split_part(public.shift_when(_start, _end, _tz), ', ', 2);
$fn$;

-- The day alone, for listing several shifts in one line.
create or replace function public.shift_day(_start timestamptz, _tz text)
returns text language sql stable set search_path = public
as $fn$
  select split_part(public.shift_when(_start, _start, _tz), ', ', 1);
$fn$;

-- ----------------------------------------------------------- shift changes
-- Still one notification per person per statement: publishing a week is one
-- UPDATE over hundreds of rows. One shift gets its day and hours; several get
-- the list of days.
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

  -- A published shift of theirs moved, on whatever day. A draft being
  -- rearranged is the builder's business and says nothing to anybody.
  insert into public.notifications (user_id, type, title, body, link)
  select s.employee_id, 'schedule_changed',
         case when count(*) = 1 then 'Your shift changed'
              else count(*) || ' of your shifts changed' end,
         case when count(*) = 1 then
                public.shift_when(min(s.starts_at), min(s.ends_at), min(s.tz))
                || case
                     when min(s.old_starts) = min(s.starts_at) and min(s.old_ends) = min(s.ends_at)
                       then coalesce(' · now ' || nullif(min(s.position), ''), '')
                     when public.shift_day(min(s.old_starts), min(s.tz))
                          = public.shift_day(min(s.starts_at), min(s.tz))
                       then ' (was ' || public.shift_hours(min(s.old_starts), min(s.old_ends), min(s.tz)) || ')'
                     else ' (was ' || public.shift_when(min(s.old_starts), min(s.old_ends), min(s.tz)) || ')'
                   end
              else string_agg(public.shift_day(s.starts_at, s.tz), ', ' order by s.starts_at)
         end,
         '/schedule'
    from (select n.employee_id, n.starts_at, n.ends_at, n.position,
                 o.starts_at as old_starts, o.ends_at as old_ends, c.timezone as tz
            from newrows n join oldrows o on o.id = n.id
            left join public.companies c on c.id = n.company_id
           where n.published and o.published
             and n.employee_id is not null
             and n.employee_id is not distinct from o.employee_id
             and (n.starts_at <> o.starts_at
                  or n.ends_at <> o.ends_at
                  or n.position is distinct from o.position)
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

  -- …and the person picking it up.
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
           where n.published
             and n.employee_id is not null
             and n.employee_id is distinct from o.employee_id
             and public.wants_notification(n.employee_id, 'schedule_changed')) s
   group by s.employee_id;

  return null;
end;
$fn$;
revoke all on function public.notify_shift_changes() from public, anon, authenticated;

create or replace function public.notify_shifts_removed()
returns trigger language plpgsql security definer set search_path = public
as $fn$
begin
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
            from oldrows o
            left join public.companies c on c.id = o.company_id
           where o.published
             and o.employee_id is not null
             and public.wants_notification(o.employee_id, 'schedule_changed')) s
   group by s.employee_id;
  return null;
end;
$fn$;
revoke all on function public.notify_shifts_removed() from public, anon, authenticated;

-- ------------------------------------------------------------ board messages
-- Sender as the title, their words as the body.
create or replace function public.push_for_message()
returns trigger language plpgsql security definer set search_path = public
as $fn$
declare
  who text;
  preview text;
  member record;
begin
  if new.is_announcement then
    return null;
  end if;

  select nullif(full_name, '') into who from public.profiles where id = new.author_id;
  preview := left(new.body, 140) || case when char_length(new.body) > 140 then '…' else '' end;

  for member in
    select id from public.profiles
     where company_id = new.company_id and id <> new.author_id
  loop
    perform public.enqueue_push(
      member.id, 'board_message',
      coalesce(who, 'New message'),
      preview, '/messages', 'msg-' || new.id::text, now()
    );
  end loop;

  return null;
end;
$fn$;
revoke all on function public.push_for_message() from public, anon, authenticated;
