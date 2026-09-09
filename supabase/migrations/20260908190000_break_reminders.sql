-- Break reminders: let an admin silence one employee's break alert.
--
-- The alert itself is derived, not stored — an employee who has been working
-- longer than the company's rule without a break is flagged, and taking a break
-- clears it on its own. This table only records "I've seen this one".
--
-- A dismissal is pinned to the stretch it was made in (`stretch_start`, the
-- moment the employee last came back from a break, or clocked in). The next
-- break moves that moment forward, so the old dismissal stops applying and a
-- fresh violation raises the flag again — the auto-clear falls out of the data
-- rather than needing a job to tidy up.

create table if not exists public.break_reminder_dismissals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 'break' for the short paid one, 'lunch' for a proper meal break.
  kind text not null check (kind in ('break', 'lunch')),
  stretch_start timestamptz not null,
  dismissed_by uuid references auth.users(id) on delete set null,
  dismissed_at timestamptz not null default now(),
  unique (user_id, kind)
);

create index if not exists break_reminder_dismissals_company_idx
  on public.break_reminder_dismissals (company_id);

alter table public.break_reminder_dismissals enable row level security;

-- Only the managers of that company; employees never see or set these.
drop policy if exists break_dismissals_manage on public.break_reminder_dismissals;
create policy break_dismissals_manage on public.break_reminder_dismissals
  for all to authenticated
  using (public.is_company_manager(auth.uid(), company_id))
  with check (public.is_company_manager(auth.uid(), company_id));

revoke all on public.break_reminder_dismissals from anon;
grant select, insert, update, delete on public.break_reminder_dismissals to authenticated;

/**
 * Silence one employee's alert for the stretch they are currently in. Re-running
 * it for the same employee and kind just moves the marker, so a manager can
 * dismiss again after a later violation.
 */
create or replace function public.dismiss_break_reminder(
  _user uuid,
  _kind text,
  _stretch_start timestamptz
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  caller uuid := auth.uid();
  cid uuid;
begin
  if _kind not in ('break', 'lunch') then raise exception 'invalid reminder kind'; end if;

  select company_id into cid from public.profiles where id = _user;
  if cid is null then raise exception 'employee has no company'; end if;
  if not public.is_company_manager(caller, cid) then raise exception 'not authorized'; end if;

  insert into public.break_reminder_dismissals (company_id, user_id, kind, stretch_start, dismissed_by, dismissed_at)
  values (cid, _user, _kind, _stretch_start, caller, now())
  on conflict (user_id, kind) do update
    set stretch_start = excluded.stretch_start,
        dismissed_by = excluded.dismissed_by,
        dismissed_at = excluded.dismissed_at,
        company_id = excluded.company_id;
end;
$$;

revoke all on function public.dismiss_break_reminder(uuid, text, timestamptz) from public, anon;
grant execute on function public.dismiss_break_reminder(uuid, text, timestamptz) to authenticated;

notify pgrst, 'reload schema';
