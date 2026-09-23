-- The louder break alert, switched on per company by a platform admin.
--
-- The recorded alert is not a general notification sound. It is for one
-- notification — "two minutes left on your break" — because that is the one
-- somebody needs to hear across a yard or over traffic, and a sound used for
-- everything is a sound nobody looks up for. Every other pop-up keeps the
-- quiet synthesised chime.
--
-- It is also not the company's own switch to throw. A company is approved for
-- it, and only a platform admin can do the approving, so this is a column with
-- a guard rather than another key in `companies.settings`: `company_admin_update`
-- lets a company admin write that whole jsonb blob, which would make an
-- approval something the applicant grants themselves.
--
-- Re-runnable; applied by hand in Studio.

alter table public.companies
  add column if not exists break_alert_sound boolean not null default false;

comment on column public.companies.break_alert_sound is
  'Approved by a platform admin: this company''s break reminder plays the '
  'recorded alert instead of the standard chime. See guard_break_alert_sound.';

-- Row-level security cannot protect one column, so the rule lives in a trigger.
--
-- `auth.uid() is null` is the service role or a hand-run statement in Studio —
-- there is no end user to check, and the migration below is one such statement.
create or replace function public.guard_break_alert_sound()
returns trigger language plpgsql security definer set search_path = public
as $fn$
begin
  if new.break_alert_sound is distinct from old.break_alert_sound
     and auth.uid() is not null
     and not public.has_role(auth.uid(), 'super_admin'::public.app_role) then
    raise exception 'Only a platform admin can change the break alert sound.';
  end if;
  return new;
end;
$fn$;
revoke all on function public.guard_break_alert_sound() from public, anon, authenticated;

drop trigger if exists trg_guard_break_alert_sound on public.companies;
create trigger trg_guard_break_alert_sound
before update on public.companies
for each row execute function public.guard_break_alert_sound();

-- ------------------------------------------------------------ the first one
-- Calexico Police Parking/Traffic Enf. is approved; nobody else is yet. Matched
-- on a prefix because the suffix is abbreviated and easy to mistype, and
-- reported either way — a silent no-op here looks exactly like success.
do $$
declare
  hits int;
begin
  update public.companies
     set break_alert_sound = true
   where name ilike 'Calexico Police%';
  get diagnostics hits = row_count;
  if hits = 0 then
    raise notice 'No company matched "Calexico Police%%" — approve it from Companies instead.';
  else
    raise notice 'Break alert sound approved for % company(ies).', hits;
  end if;
end $$;
