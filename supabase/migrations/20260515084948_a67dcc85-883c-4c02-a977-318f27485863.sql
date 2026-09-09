CREATE TABLE IF NOT EXISTS public.pricing_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  price_cents integer NOT NULL DEFAULT 0,
  capacity text NOT NULL DEFAULT '',
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  featured boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pricing_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "plans_read_public" ON public.pricing_plans
  FOR SELECT TO anon, authenticated USING (active = true OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "plans_super_admin_write" ON public.pricing_plans
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'super_admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'super_admin'::app_role));

INSERT INTO public.pricing_plans (name, price_cents, capacity, features, featured, sort_order) VALUES
  ('Basic', 4900, 'Up to 25 employees', '["Schedule builder","Shift trades","Time-off requests","Email support"]'::jsonb, false, 1),
  ('Pro', 14900, 'Up to 100 employees', '["Everything in Basic","Smart scheduling","Reports & exports","Priority support"]'::jsonb, true, 2),
  ('Enterprise', 49900, 'Unlimited employees', '["Everything in Pro","Audit logs","SSO ready","Dedicated CSM"]'::jsonb, false, 3);