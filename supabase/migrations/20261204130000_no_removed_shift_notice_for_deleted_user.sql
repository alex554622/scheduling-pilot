-- Deleting an account failed with
--   insert or update on table "notifications" violates foreign key
--   constraint "notifications_user_id_fkey"
--
-- Removing the login cascades to the person's shifts, and the shifts'
-- delete trigger then tried to tell that same person "A shift was removed"
-- — a notification for a user who no longer exists. Skip anyone whose
-- account is gone.

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
             -- The account itself is being deleted: no one to tell.
             and exists (select 1 from auth.users u where u.id = o.employee_id)
             and public.wants_notification(o.employee_id, 'schedule_changed')) s
   group by s.employee_id;
  return null;
end;
$fn$;
revoke all on function public.notify_shifts_removed() from public, anon, authenticated;
