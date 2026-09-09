ALTER TABLE public.companies REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.companies;