-- Schedule templates: a reusable rotation engine.
--
-- A template is a repeating pattern of work and off days — 3 on / 4 off / 4 on
-- / 3 off, 4 on / 4 off, Monday to Friday, anything — plus the teams that run
-- it and their hours. It is one way to build a schedule, never the only one:
-- the existing builder still works exactly as before, and a schedule made from
-- a template is an ordinary schedule the moment it exists.
--
-- Ownership follows the app's own model. "Organization" in the spec is this
-- app's company, so a template belongs to a company_id, with owner_id noting
-- which admin made it:
--
--   system template : company_id null, is_system_template true, is_editable false
--   custom template : company_id set,  is_system_template false, is_editable true
--
-- A system template can be applied by anyone and edited by no one. Customising
-- copies it into the company first, so the shared original never changes.
--
-- Re-runnable, and safe over the earlier draft of this table: the columns are
-- added if missing rather than assumed.

create table if not exists public.schedule_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.schedule_templates
  add column if not exists owner_id uuid references auth.users(id) on delete set null,
  add column if not exists company_id uuid references public.companies(id) on delete cascade,
  add column if not exists is_system_template boolean not null default false,
  add column if not exists is_editable boolean not null default true,
  add column if not exists schedule_view_type text not null default 'monthly',
  add column if not exists pattern jsonb not null default '[]'::jsonb,
  add column if not exists pattern_length integer not null default 14,
  add column if not exists default_work_week_start integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'schedule_templates_view_type_check') then
    alter table public.schedule_templates
      add constraint schedule_templates_view_type_check
      check (schedule_view_type in ('monthly', 'biweekly', 'weekly'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'schedule_templates_week_start_check') then
    alter table public.schedule_templates
      add constraint schedule_templates_week_start_check
      check (default_work_week_start between 0 and 6);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'schedule_templates_length_check') then
    alter table public.schedule_templates
      add constraint schedule_templates_length_check
      check (pattern_length between 1 and 366);
  end if;
end $$;

create index if not exists schedule_templates_company_idx on public.schedule_templates(company_id);
alter table public.schedule_templates enable row level security;

-- The teams that run a template's pattern. Each may start at a different point
-- of the same cycle, which is what pattern_offset records.
create table if not exists public.schedule_template_teams (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.schedule_templates(id) on delete cascade,
  name text not null,
  shift_start time not null default '08:00',
  shift_end time not null default '17:00',
  pattern_offset integer not null default 0,
  sort_order integer not null default 0
);
create index if not exists schedule_template_teams_template_idx
  on public.schedule_template_teams(template_id, sort_order);
alter table public.schedule_template_teams enable row level security;

-- ---- who may see and change what ----

create or replace function public.can_edit_schedule_template(_template_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
      from public.schedule_templates t
      join public.user_roles r
        on r.user_id = auth.uid()
       and r.company_id = t.company_id
       and r.role = 'company_admin'::public.app_role
     where t.id = _template_id
       and t.is_system_template = false
  )
  or exists (
    select 1 from public.user_roles r
     where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role
  );
$$;

drop policy if exists schedule_templates_read on public.schedule_templates;
create policy schedule_templates_read on public.schedule_templates for select to authenticated
using (
  -- Built-ins are shared with every account…
  is_system_template
  -- …a company's own templates stay inside that company…
  or exists (select 1 from public.user_roles r
              where r.user_id = auth.uid() and r.company_id = schedule_templates.company_id)
  -- …and a platform admin sees everything.
  or exists (select 1 from public.user_roles r
              where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role)
);

drop policy if exists schedule_templates_insert on public.schedule_templates;
create policy schedule_templates_insert on public.schedule_templates for insert to authenticated
with check (
  (is_system_template = false
   and company_id is not null
   and exists (select 1 from public.user_roles r
                where r.user_id = auth.uid() and r.company_id = schedule_templates.company_id
                  and r.role = 'company_admin'::public.app_role))
  or exists (select 1 from public.user_roles r
              where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role)
);

drop policy if exists schedule_templates_update on public.schedule_templates;
create policy schedule_templates_update on public.schedule_templates for update to authenticated
using (
  (is_system_template = false
   and exists (select 1 from public.user_roles r
                where r.user_id = auth.uid() and r.company_id = schedule_templates.company_id
                  and r.role = 'company_admin'::public.app_role))
  or exists (select 1 from public.user_roles r
              where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role)
)
with check (
  (is_system_template = false
   and exists (select 1 from public.user_roles r
                where r.user_id = auth.uid() and r.company_id = schedule_templates.company_id
                  and r.role = 'company_admin'::public.app_role))
  or exists (select 1 from public.user_roles r
              where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role)
);

drop policy if exists schedule_templates_delete on public.schedule_templates;
create policy schedule_templates_delete on public.schedule_templates for delete to authenticated
using (
  (is_system_template = false
   and exists (select 1 from public.user_roles r
                where r.user_id = auth.uid() and r.company_id = schedule_templates.company_id
                  and r.role = 'company_admin'::public.app_role))
  or exists (select 1 from public.user_roles r
              where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role)
);

drop policy if exists schedule_template_teams_read on public.schedule_template_teams;
create policy schedule_template_teams_read on public.schedule_template_teams for select to authenticated
using (
  exists (select 1 from public.schedule_templates t
           where t.id = schedule_template_teams.template_id
             and (t.is_system_template
                  or exists (select 1 from public.user_roles r
                              where r.user_id = auth.uid() and r.company_id = t.company_id)
                  or exists (select 1 from public.user_roles r
                              where r.user_id = auth.uid() and r.role = 'super_admin'::public.app_role)))
);

drop policy if exists schedule_template_teams_write on public.schedule_template_teams;
create policy schedule_template_teams_write on public.schedule_template_teams for all to authenticated
using (public.can_edit_schedule_template(template_id))
with check (public.can_edit_schedule_template(template_id));

grant select, insert, update, delete on public.schedule_templates to authenticated;
grant select, insert, update, delete on public.schedule_template_teams to authenticated;
grant all on public.schedule_templates to service_role;
grant all on public.schedule_template_teams to service_role;
revoke all on function public.can_edit_schedule_template(uuid) from public, anon;
grant execute on function public.can_edit_schedule_template(uuid) to authenticated;

create or replace function public.touch_schedule_template()
returns trigger language plpgsql set search_path = public
as $$
begin
  NEW.updated_at := now();
  return NEW;
end; $$;

drop trigger if exists trg_touch_schedule_template on public.schedule_templates;
create trigger trg_touch_schedule_template
before update on public.schedule_templates
for each row execute function public.touch_schedule_template();

-- ---- a schedule remembers the settings it was built from ----
--
-- Editing a template later must not rewrite history, so the pattern, the teams
-- and the anchor are copied onto the schedule when it is created. The link
-- back to the template is kept for reference only.
alter table public.schedules
  add column if not exists source_template_id uuid references public.schedule_templates(id) on delete set null,
  add column if not exists pattern_snapshot jsonb,
  add column if not exists teams_snapshot jsonb,
  add column if not exists work_week_start integer,
  add column if not exists anchor_date date,
  add column if not exists schedule_year integer;

-- ---- the built-in patrol rotation ----
--
-- 14 days: 3 work, 4 off, 4 work, 3 off. Teams 1 and 3 run nights, 2 and 4
-- days; 3 and 4 start half a cycle later. These are defaults — an admin who
-- wants different hours or offsets customises their own copy.
delete from public.schedule_templates
 where is_system_template = true
   and name = 'Police patrol — 12-hour, 4 teams';  -- the earlier draft, if it was ever applied

insert into public.schedule_templates (
  name, description, owner_id, company_id, is_system_template, is_editable,
  schedule_view_type, pattern, pattern_length, default_work_week_start
)
select
  'Patrol 3-4-4-3',
  '14-day rotating schedule consisting of 3 work days, 4 off days, 4 work days, 3 off days.',
  null, null, true, false,
  'monthly',
  '[true, true, true, false, false, false, false, true, true, true, true, false, false, false]'::jsonb,
  14,
  0
where not exists (
  select 1 from public.schedule_templates where is_system_template = true and name = 'Patrol 3-4-4-3'
);

insert into public.schedule_template_teams (template_id, name, shift_start, shift_end, pattern_offset, sort_order)
select t.id, v.name, v.shift_start::time, v.shift_end::time, v.pattern_offset, v.sort_order
from public.schedule_templates t
cross join (values
  ('Team 1', '19:00', '07:00', 0, 1),
  ('Team 2', '07:00', '19:00', 0, 2),
  ('Team 3', '19:00', '07:00', 7, 3),
  ('Team 4', '07:00', '19:00', 7, 4)
) as v(name, shift_start, shift_end, pattern_offset, sort_order)
where t.is_system_template = true
  and t.name = 'Patrol 3-4-4-3'
  and not exists (select 1 from public.schedule_template_teams x where x.template_id = t.id);
