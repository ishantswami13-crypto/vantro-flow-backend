-- ============================================================
-- Vantro staging repair: create public.sales
-- Derived exactly from POST /api/sales in server.js (lines 9548-9615)
-- and SalesService.getSales in lib/services/SalesService.js.
-- Idempotent: CREATE TABLE IF NOT EXISTS throughout.
-- NO FK on user_id -- harness test users exist only in Railway Postgres,
-- not in this Supabase project; a FK would reject every harness insert.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sales (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID          NOT NULL,
  customer_name   TEXT          NOT NULL,
  amount          NUMERIC(14,2) NOT NULL,
  paid_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  status          TEXT          NOT NULL DEFAULT 'unpaid'
                    CHECK (status IN ('paid', 'partial', 'unpaid')),
  sale_date       DATE,
  due_date        DATE,
  invoice_number  TEXT,
  customer_phone  TEXT,
  customer_gstin  TEXT,
  notes           TEXT,
  items           TEXT,
  gst_type        TEXT,
  gst_rate        NUMERIC(10,4),
  gst_amount      NUMERIC(14,2),
  cgst_amount     NUMERIC(14,2),
  sgst_amount     NUMERIC(14,2),
  igst_amount     NUMERIC(14,2),
  subtotal        NUMERIC(14,2),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_user_id
  ON public.sales (user_id);

CREATE INDEX IF NOT EXISTS idx_sales_user_date
  ON public.sales (user_id, sale_date DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_sales_user_status
  ON public.sales (user_id, status);

CREATE INDEX IF NOT EXISTS idx_sales_invoice_number
  ON public.sales (user_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

SELECT
  table_name,
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = 'sales' AND table_schema = 'public') AS column_count
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'sales';

NOTIFY pgrst, 'reload schema';
