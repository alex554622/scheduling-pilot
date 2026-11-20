-- Notes on a timecard, for the "Detailed time card" format.
--
-- A manager writes a dated note on someone's card ("Training: annual
-- conference Nov 2–5", "Called in sick, approved"), and the detailed
-- bi-weekly card prints every note dated inside its period in a Notes
-- section under the hours, with who wrote it and when.
--
-- The employee can read the notes on their own card; only a company admin
-- (or a super admin) can write or remove them. The writer's name is kept on
-- the row as it was when they wrote it, so the card still reads correctly
-- after they leave the company.
--
-- Re-runnable; applied by hand in Studio.

create table if not exists public.timecard_notes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  note_date date not null,
  note text not null check (length(trim(note)) between 1 and 1000),
  created_by uuid not null default auth.uid() references auth.users(id) on delete set null,
  author_name text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists timecard_notes_user_day_idx on public.timecard_notes(user_id, note_date);
create index if not exists timecard_notes_company_idx on public.timecard_notes(company_id);
alter table public.timecard_notes enable row level security;

drop policy if exists timecard_notes_view on public.timecard_notes;
create policy timecard_notes_view on public.timecard_notes for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'company_admin', company_id)
  );

drop policy if exists timecard_notes_manage on public.timecard_notes;
create policy timecard_notes_manage on public.timecard_notes for all to authenticated
  using (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id))
  with check (public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'company_admin', company_id));

grant select, insert, update, delete on public.timecard_notes to authenticated;
grant all on public.timecard_notes to service_role;
