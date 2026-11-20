-- CRM status and intake record produced from the AI call (see lead-callback function).
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS call_crm_status TEXT,
  ADD COLUMN IF NOT EXISTS call_intake JSONB,
  ADD COLUMN IF NOT EXISTS call_attempt INTEGER;
