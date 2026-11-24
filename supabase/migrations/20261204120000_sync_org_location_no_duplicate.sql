-- Saving "Edit member" could fail with
--   duplicate key value violates unique constraint
--   "employee_locations_employee_id_location_id_key"
--
-- memberships_sync_org adds a member's work location to the places they may
-- clock in. It checked for an existing row by (employee, company, location),
-- but the unique key is (employee, location) only, so a row on file under
-- another company_id slipped past the check and the insert failed, taking
-- the whole member update with it. Let the unique key decide instead.

create or replace function public.memberships_sync_org()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.position_id is not null
     and (tg_op = 'INSERT' or new.position_id is distinct from old.position_id) then
    update public.employee_positions
       set is_primary = false
     where employee_id = new.user_id and company_id = new.company_id
       and position_id <> new.position_id and is_primary;
    insert into public.employee_positions (company_id, employee_id, position_id, is_primary)
    values (new.company_id, new.user_id, new.position_id, true)
    on conflict (employee_id, position_id) do update set is_primary = true;
  end if;

  if new.location_id is not null
     and (tg_op = 'INSERT' or new.location_id is distinct from old.location_id) then
    insert into public.employee_locations (company_id, employee_id, location_id)
    values (new.company_id, new.user_id, new.location_id)
    on conflict (employee_id, location_id) do nothing;
  end if;
  return null;
end; $$;
