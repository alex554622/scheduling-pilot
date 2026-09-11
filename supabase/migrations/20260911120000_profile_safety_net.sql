-- Every account needs a profile row. The app reads it to decide what a
-- signed-in user sees, and join_company_by_code writes the join request into
-- it. Without one, the "Add your company" screen never appeared, and a join
-- code "succeeded" while saving nothing: the UPDATE matched zero rows and the
-- function still returned the company id.
--
-- Profiles come from on_auth_user_created, a trigger on auth.users. That table
-- lives in the auth schema, which a public-schema dump doesn't carry, so the
-- trigger can go missing when the database is moved. This file restores it,
-- backfills every account left without a profile, and makes the join path
-- create the row itself rather than depend on the trigger.
--
-- Re-runnable; it is applied by hand in Studio. The final SELECT reports the
-- result: signup_trigger_exists = true, users_missing_profile = 0.

-- 1. The signup trigger. ON CONFLICT so a profile the join path already made
--    never fails a signup.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end; $$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. Backfill. bootstrap_company grants the company_admin role even when its
--    profile update matched nothing, so an account that already runs a company
--    gets that company put back on its new profile.
insert into public.profiles (id, full_name, company_id)
select
  u.id,
  coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), split_part(u.email, '@', 1)),
  (select r.company_id
     from public.user_roles r
    where r.user_id = u.id and r.company_id is not null
    order by (r.role = 'company_admin') desc
    limit 1)
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- 3. Joining by code creates the profile when it is missing instead of
--    silently doing nothing. Everything else is unchanged from
--    20260623044301.
create or replace function public.join_company_by_code(_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  cstatus text;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if _code is null or length(trim(_code)) = 0 then raise exception 'code required'; end if;

  select id, status into cid, cstatus
  from public.companies
  where upper(join_code) = upper(trim(_code));

  if cid is null then raise exception 'invalid company code'; end if;
  if cstatus <> 'active' then raise exception 'company is not active yet'; end if;

  if exists (select 1 from public.profiles where id = uid and company_id is not null) then
    raise exception 'already a member of a company';
  end if;

  insert into public.profiles (id, full_name, pending_company_id)
  select
    u.id,
    coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), split_part(u.email, '@', 1)),
    cid
  from auth.users u
  where u.id = uid
  on conflict (id) do update set pending_company_id = excluded.pending_company_id;

  if not found then raise exception 'account not found'; end if;
  return cid;
end; $$;

revoke all on function public.join_company_by_code(text) from public, anon;
grant execute on function public.join_company_by_code(text) to authenticated;

-- 4. Result.
select
  exists (select 1 from pg_trigger where tgname = 'on_auth_user_created' and tgrelid = 'auth.users'::regclass) as signup_trigger_exists,
  (select count(*) from auth.users u where not exists (select 1 from public.profiles p where p.id = u.id)) as users_missing_profile;
