-- New companies start in 'pending' until a super admin approves them
CREATE OR REPLACE FUNCTION public.bootstrap_company(_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare uid uuid := auth.uid(); cid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  insert into public.companies (name, status) values (_name, 'pending') returning id into cid;
  insert into public.user_roles (user_id, company_id, role) values (uid, cid, 'company_admin');
  update public.profiles set company_id = cid where id = uid;
  return cid;
end; $function$;