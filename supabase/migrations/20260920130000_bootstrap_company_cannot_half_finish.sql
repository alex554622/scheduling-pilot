-- A business registration that half-finished, and the companies it hid.
--
-- `bootstrap_company` did three things and assumed all three landed:
--
--   insert into companies ...                    -- the company
--   insert into user_roles ...                   -- the caller is its admin
--   update profiles set company_id = cid         -- and belongs to it
--        where id = uid;                         -- ← matches nothing if the
--                                                --   profile row isn't there
--
-- The move to self-hosted lost `on_auth_user_created`, so for a while new
-- accounts had no profile row (restored in 20260911120000). During that window
-- the UPDATE quietly matched zero rows. The company was created and the role
-- was granted, but nobody was attached to it: the company shows "0 members" and
-- the person who registered it lands on the "Add your company" screen instead
-- of their own workspace — with no way back to the company they had just made.
--
-- An UPDATE that matches nothing is not an error, so this failed in silence.
-- The insert below cannot.
--
-- Re-runnable; applied by hand in Studio.

create or replace function public.bootstrap_company(_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  insert into public.companies (name, status) values (_name, 'pending') returning id into cid;
  insert into public.user_roles (user_id, company_id, role) values (uid, cid, 'company_admin');

  -- Upsert, not update: whether or not the profile row exists yet, the person
  -- who registered the company ends up inside it. `full_name` defaults to ''
  -- and the profile trigger fills it in, so creating the row here costs nothing.
  insert into public.profiles (id, company_id)
  values (uid, cid)
  on conflict (id) do update set company_id = excluded.company_id;

  -- Period dates stay null until approval; `company_plan_id` treats a trial
  -- with no end date as not yet started, which is right for a pending company.
  insert into public.company_subscriptions (company_id, plan_id, status)
  values (cid, public.trial_plan_id(), 'trialing');

  return cid;
end;
$$;

revoke all on function public.bootstrap_company(text) from public, anon;
grant execute on function public.bootstrap_company(text) to authenticated;

-- ------------------------------------------------------------ the repair
-- Reattach the people it already detached. Someone holding a role in a company
-- while their profile points at nothing is not an ambiguous case: the role row
-- says which company, and it was written by this same function.
--
-- Deliberately narrow — only profiles with no company at all are touched, so a
-- person who has since joined somewhere else is left exactly where they are.
update public.profiles p
   set company_id = ur.company_id
  from public.user_roles ur
 where ur.user_id = p.id
   and ur.company_id is not null
   and p.company_id is null
   and p.pending_company_id is null;
