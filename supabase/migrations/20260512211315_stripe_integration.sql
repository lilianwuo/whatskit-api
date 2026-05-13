-- Stripe Integration: schema changes only.
-- Edge Functions (stripe-checkout, stripe-webhook) are deployed separately.
--
-- Changes:
--   1. billing.accounts gets an 'extra' jsonb column to store stripe_customer_id.
--   2. billing.plans gets an 'extra' jsonb column to store stripe_price_id.
--
-- After deploying, configure each plan's Stripe price ID:
--   UPDATE billing.plans
--   SET extra = jsonb_build_object('stripe_price_id', 'price_xxx')
--   WHERE id = 'starter';

alter table billing.accounts
add column if not exists extra jsonb;

alter table billing.plans
add column if not exists extra jsonb;

-- Required Supabase secrets (set via Dashboard > Edge Functions > Secrets):
--   STRIPE_SECRET_KEY       — sk_live_... or sk_test_...
--   STRIPE_WEBHOOK_SECRET   — whsec_... (from Stripe Dashboard > Webhooks)
