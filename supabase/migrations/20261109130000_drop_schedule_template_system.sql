-- Remove the schedule template system (20260911190000_schedule_template_system.sql).
--
-- The rotation templates, their teams, the built-in "Patrol 3-4-4-3" rotation
-- and the columns a schedule used to remember which template it came from are
-- all dropped. The feature is being rebuilt from scratch later.
--
-- Not touched: shift_templates and shifts.template_id. Those belong to the
-- older shift-template feature (Organization → Shift templates and the
-- schedule generator), which is unrelated.
--
-- Schedules made from a template stay as they are: they are ordinary
-- schedules, and only the snapshot columns below are removed from them. No app
-- code reads those columns.
--
-- Re-runnable: everything uses `if exists`.

-- A schedule's link and snapshots of the template it was built from.
alter table if exists public.schedules
  drop column if exists source_template_id,
  drop column if exists pattern_snapshot,
  drop column if exists teams_snapshot,
  drop column if exists work_week_start,
  drop column if exists anchor_date,
  drop column if exists schedule_year;

-- Policies go with their tables, but are dropped by name first so the script
-- also cleans up if a table was already dropped some other way.
do $$
begin
  if to_regclass('public.schedule_template_teams') is not null then
    drop policy if exists schedule_template_teams_read on public.schedule_template_teams;
    drop policy if exists schedule_template_teams_write on public.schedule_template_teams;
  end if;
  if to_regclass('public.schedule_templates') is not null then
    drop policy if exists schedule_templates_read on public.schedule_templates;
    drop policy if exists schedule_templates_insert on public.schedule_templates;
    drop policy if exists schedule_templates_update on public.schedule_templates;
    drop policy if exists schedule_templates_delete on public.schedule_templates;
    drop trigger if exists trg_touch_schedule_template on public.schedule_templates;
  end if;
end $$;

drop table if exists public.schedule_template_teams;
drop table if exists public.schedule_templates;

drop function if exists public.can_edit_schedule_template(uuid);
drop function if exists public.touch_schedule_template();
