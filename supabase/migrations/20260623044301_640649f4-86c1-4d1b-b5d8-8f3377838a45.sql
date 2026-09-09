
-- Add join_code: short, friendly company code generated when super admin approves company
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS join_code text UNIQUE;

-- CompanyLite SELECT for members already exists; ensure company_admin can read their own code via existing policies.

-- Generator
CREATE OR REPLACE FUNCTION public.generate_company_join_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
  i int;
begin
  loop
    code := '';
    for i in 1..8 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.companies where join_code = code);
  end loop;
  return code;
end; $$;

-- Trigger: assign join_code when company becomes active (and not yet set)
CREATE OR REPLACE FUNCTION public.assign_join_code_on_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
begin
  if NEW.status = 'active' and NEW.join_code is null then
    NEW.join_code := public.generate_company_join_code();
  end if;
  return NEW;
end; $$;

DROP TRIGGER IF EXISTS trg_assign_join_code ON public.companies;
CREATE TRIGGER trg_assign_join_code
BEFORE INSERT OR UPDATE OF status ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.assign_join_code_on_approval();

-- Backfill codes for already-active companies
UPDATE public.companies SET join_code = public.generate_company_join_code()
WHERE status = 'active' AND join_code IS NULL;

-- New RPC: join by short code (sets pending_company_id, awaits admin approval)
CREATE OR REPLACE FUNCTION public.join_company_by_code(_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  update public.profiles set pending_company_id = cid where id = uid;
  return cid;
end; $$;

GRANT EXECUTE ON FUNCTION public.join_company_by_code(text) TO authenticated;
