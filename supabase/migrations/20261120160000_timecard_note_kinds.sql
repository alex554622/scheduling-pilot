-- Tell a day's comment apart from the period's notes and OT slips.
--
-- One table holds three kinds of writing on a time card:
--
--   day      a supervisor's comment on one day; prints on that day's line
--   note     a note for the period (training, a correction, anything)
--   ot_slip  an overtime slip: the day it was worked, the hours, the reason
--
-- Notes and OT slips print in the Notes section at the foot of the detailed
-- card; day comments do not, they are already on their day.
--
-- Rows written before this are day comments, which is how they were shown.
--
-- Re-runnable; applied by hand in Studio.

alter table public.timecard_notes
  add column if not exists kind text not null default 'day';
alter table public.timecard_notes
  add column if not exists hours numeric(5, 2);

alter table public.timecard_notes drop constraint if exists timecard_notes_kind_check;
alter table public.timecard_notes
  add constraint timecard_notes_kind_check check (kind in ('day', 'note', 'ot_slip'));

alter table public.timecard_notes drop constraint if exists timecard_notes_hours_check;
alter table public.timecard_notes
  add constraint timecard_notes_hours_check check (hours is null or (hours > 0 and hours <= 24));

-- created_by is "on delete set null", so it has to allow null: otherwise
-- deleting the author's account fails.
alter table public.timecard_notes alter column created_by drop not null;

notify pgrst, 'reload schema';
