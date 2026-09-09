
-- Notifications table
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON public.notifications (user_id, created_at DESC);

GRANT SELECT, UPDATE, DELETE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_own_select ON public.notifications;
CREATE POLICY notifications_own_select ON public.notifications
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_own_update ON public.notifications;
CREATE POLICY notifications_own_update ON public.notifications
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_own_delete ON public.notifications;
CREATE POLICY notifications_own_delete ON public.notifications
  FOR DELETE USING (user_id = auth.uid());

-- Realtime
ALTER TABLE public.notifications REPLICA IDENTITY FULL;
DO $$ BEGIN
  PERFORM 1 FROM pg_publication_tables
   WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='notifications';
  IF NOT FOUND THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications';
  END IF;
END $$;

-- Trigger: notify company members when company status changes
CREATE OR REPLACE FUNCTION public.notify_company_status_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare
  title text;
  body  text;
begin
  if NEW.status is distinct from OLD.status then
    if NEW.status = 'active' and OLD.status = 'pending' then
      title := 'Company approved';
      body  := NEW.name || ' has been approved by the platform admin. You now have full access.';
    elsif NEW.status = 'suspended' then
      title := 'Company suspended';
      body  := NEW.name || ' has been suspended. Please contact support.';
    elsif NEW.status = 'past_due' then
      title := 'Account past due';
      body  := NEW.name || ' is past due. Update billing to restore access.';
    elsif NEW.status = 'active' then
      title := 'Account reactivated';
      body  := NEW.name || ' is active again.';
    else
      return NEW;
    end if;

    insert into public.notifications (user_id, type, title, body, link)
    select p.id, 'company_status_' || NEW.status, title, body, '/dashboard'
    from public.profiles p
    where p.company_id = NEW.id;
  end if;
  return NEW;
end; $$;

DROP TRIGGER IF EXISTS trg_notify_company_status ON public.companies;
CREATE TRIGGER trg_notify_company_status
AFTER UPDATE OF status ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.notify_company_status_change();

-- Trigger: notify user when their join request is approved or rejected
CREATE OR REPLACE FUNCTION public.notify_membership_decision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare
  cname text;
begin
  -- Approval: pending cleared AND company_id newly set
  if OLD.pending_company_id is not null
     and NEW.pending_company_id is null
     and NEW.company_id is not null
     and NEW.company_id is distinct from OLD.company_id then
    select name into cname from public.companies where id = NEW.company_id;
    insert into public.notifications (user_id, type, title, body, link)
    values (NEW.id, 'membership_approved', 'Join request approved',
            'You''ve been approved to join ' || coalesce(cname, 'the company') || '.',
            '/dashboard');
  -- Rejection: pending cleared AND still no company
  elsif OLD.pending_company_id is not null
     and NEW.pending_company_id is null
     and NEW.company_id is null then
    select name into cname from public.companies where id = OLD.pending_company_id;
    insert into public.notifications (user_id, type, title, body, link)
    values (NEW.id, 'membership_rejected', 'Join request declined',
            'Your request to join ' || coalesce(cname, 'the company') || ' was declined.',
            '/login');
  end if;
  return NEW;
end; $$;

DROP TRIGGER IF EXISTS trg_notify_membership_decision ON public.profiles;
CREATE TRIGGER trg_notify_membership_decision
AFTER UPDATE OF pending_company_id, company_id ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.notify_membership_decision();
