
-- Employee join requests now require company-admin approval.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS pending_company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL;

-- Allow company admins to see profiles that are requesting to join their company.
DROP POLICY IF EXISTS profile_view_pending ON public.profiles;
CREATE POLICY profile_view_pending ON public.profiles
  FOR SELECT
  USING (pending_company_id IS NOT NULL
         AND has_role(auth.uid(), 'company_admin'::app_role, pending_company_id));

-- Allow company admins to update pending requesters (to approve = set company_id, clear pending; or reject).
DROP POLICY IF EXISTS profile_update_pending ON public.profiles;
CREATE POLICY profile_update_pending ON public.profiles
  FOR UPDATE
  USING (pending_company_id IS NOT NULL
         AND has_role(auth.uid(), 'company_admin'::app_role, pending_company_id))
  WITH CHECK (
    -- After update, either approved into the company or rejection (cleared)
    (company_id IS NOT NULL AND has_role(auth.uid(), 'company_admin'::app_role, company_id))
    OR pending_company_id IS NULL
  );

-- Replace join_company: now creates a pending request instead of immediate membership.
CREATE OR REPLACE FUNCTION public.join_company(_company uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.companies where id = _company) then
    raise exception 'company not found';
  end if;
  if exists (select 1 from public.profiles where id = uid and company_id is not null) then
    raise exception 'already a member of a company';
  end if;
  update public.profiles
    set pending_company_id = _company
    where id = uid;
end;
$$;

-- Approve a pending join request (company admin only).
CREATE OR REPLACE FUNCTION public.approve_membership(_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  cid uuid;
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'not authenticated'; end if;
  select pending_company_id into cid from public.profiles where id = _user;
  if cid is null then raise exception 'no pending request'; end if;
  if not (public.has_role(caller, 'company_admin'::app_role, cid)
          or public.has_role(caller, 'super_admin'::app_role)) then
    raise exception 'not authorized';
  end if;
  update public.profiles
    set company_id = cid, pending_company_id = null
    where id = _user;
  insert into public.user_roles (user_id, company_id, role)
    values (_user, cid, 'employee')
    on conflict do nothing;
end;
$$;

-- Reject a pending join request (company admin only).
CREATE OR REPLACE FUNCTION public.reject_membership(_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  cid uuid;
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'not authenticated'; end if;
  select pending_company_id into cid from public.profiles where id = _user;
  if cid is null then return; end if;
  if not (public.has_role(caller, 'company_admin'::app_role, cid)
          or public.has_role(caller, 'super_admin'::app_role)) then
    raise exception 'not authorized';
  end if;
  update public.profiles set pending_company_id = null where id = _user;
end;
$$;
