-- Tell the platform admins when a business registers.
--
-- `bootstrap_company` has always parked a new company at 'pending', and the
-- Companies page has always had the approval queue - but nothing ever told a
-- super admin that a company had joined it. The business sat on the "Awaiting
-- approval" screen until somebody happened to open that page and look, which
-- from the customer's side is indistinguishable from being ignored.
--
-- The counterpart already exists: `notify_company_status_change` tells the
-- company when the approval lands. This is the half that asks for it.
--
-- Re-runnable; applied by hand in Studio.

create or replace function public.notify_new_company()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  requested_by text;
begin
  -- Only a registration needs a decision. A company a super admin creates
  -- already active is not waiting on anyone.
  if NEW.status is distinct from 'pending' then return NEW; end if;

  -- Who to talk to about it. The row is created by `bootstrap_company` before
  -- the caller's profile points at it, so fall back to the signed-in account.
  select coalesce(nullif(p.full_name, ''), u.email)
    into requested_by
    from auth.users u
    left join public.profiles p on p.id = u.id
   where u.id = auth.uid();

  insert into public.notifications (user_id, type, title, body, link)
  select distinct ur.user_id,
         'company_pending',
         'New business account',
         NEW.name || ' has registered'
           || coalesce(' (' || requested_by || ')', '')
           || ' and is waiting for approval.',
         '/companies'
    from public.user_roles ur
   where ur.role = 'super_admin';

  return NEW;
end; $$;

drop trigger if exists trg_notify_new_company on public.companies;
create trigger trg_notify_new_company
after insert on public.companies
for each row execute function public.notify_new_company();
