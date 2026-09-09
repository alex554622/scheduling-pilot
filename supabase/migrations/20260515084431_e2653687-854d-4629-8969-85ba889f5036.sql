ALTER TABLE public.companies
ADD COLUMN IF NOT EXISTS billing_mode text NOT NULL DEFAULT 'pending'
CHECK (billing_mode IN ('pending','card','cash','waived'));