-- Pay rules on the position: paid meal breaks and a shift differential, set
-- by a company admin on a position ("Police officer", "Dispatcher") and
-- followed by everyone whose position it is. A position with neither turned
-- on changes nothing: its people follow the company's App rules.
--
-- * paid_meal_breaks — 30- and 60-minute breaks stay in the hours, as the
--   10-minute break always has.
-- * a differential window (diff_start → diff_end, wall-clock times; an end
--   earlier than the start runs past midnight). Hours actually worked inside
--   it are marked on the time card under diff_label. Hours, not money: the app
--   keeps no pay rates, payroll applies the rate.
--
-- Read from the positions a person holds (employee_positions): the primary one
-- when marked, otherwise the first of them that has rules. Worked out
-- when a card is read (src/lib/pay-rules.ts), never stored, so editing a
-- position's rules changes the cards of everyone in it.
--
-- Positions are already editable by company admins only ("positions_admin_manage")
-- and readable by the company, which is what these rules need.
--
-- An earlier draft kept these rules in separate pay_rule_groups /
-- pay_rule_assignments tables. Those were applied on one database and only
-- ever held test rows; they are dropped here.

alter table public.positions
  add column if not exists paid_meal_breaks boolean not null default false,
  add column if not exists diff_enabled boolean not null default false,
  add column if not exists diff_label text not null default 'Night differential',
  add column if not exists diff_start time not null default '18:00',
  add column if not exists diff_end time not null default '06:00';

alter table public.positions drop constraint if exists positions_diff_label_not_blank;
alter table public.positions
  add constraint positions_diff_label_not_blank check (length(trim(diff_label)) > 0);

drop table if exists public.pay_rule_assignments;
drop table if exists public.pay_rule_groups;

-- Have the API pick up the new columns without a restart.
notify pgrst, 'reload schema';
