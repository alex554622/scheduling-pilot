-- Publishing was two client-side statements: update the schedule row, then
-- update its shifts. If the second never ran (network drop, closed tab, or any
-- caller that only updates the schedule), the schedule showed as "published"
-- while every one of its shifts stayed unpublished and invisible to employees.
--
-- Releasing the shifts belongs in the same transaction as the status change, so
-- the two can never disagree. The client now only sets the status.
create or replace function public.publish_schedule_shifts()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    update public.shifts set published = true
     where schedule_id = new.id and published = false;
  end if;
  return new;
end;
$$;
revoke all on function public.publish_schedule_shifts() from public, anon, authenticated;

create trigger trg_publish_schedule_shifts
after update of status on public.schedules
for each row execute function public.publish_schedule_shifts();
