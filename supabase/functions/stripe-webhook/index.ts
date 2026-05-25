/**
 * stripe-webhook — handles Stripe webhook events.
 *
 * POST /stripe-webhook
 * Auth: Stripe-Signature header (verified with STRIPE_WEBHOOK_SECRET)
 *
 * Environment variables required:
 *   STRIPE_SECRET_KEY        — Stripe secret key
 *   STRIPE_WEBHOOK_SECRET    — Stripe webhook signing secret (whsec_…)
 *
 * Handled events:
 *   checkout.session.completed  → activate plan via billing.change_plan()
 *   invoice.payment_succeeded   → mark most recent invoice as 'paid', record payment
 *   invoice.payment_failed      → log the failure (no automatic downgrade — human decision)
 *   customer.subscription.deleted → downgrade org to free plan
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "stripe";
import * as log from "../_shared/logger.ts";
import { createUnsecureClient } from "../_shared/supabase.ts";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2025-03-31.basil" as any,
});

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    log.warn("Missing Stripe-Signature header");
    return new Response("Missing signature", { status: 400 });
  }

  let event: Stripe.Event;

  try {
    const body = await req.text();
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    log.error("Stripe webhook signature verification failed", err);
    return new Response(`Webhook error: ${(err as Error).message}`, {
      status: 400,
    });
  }

  log.info(`Stripe event received: ${event.type}`, { event_id: event.id });

  const client = createUnsecureClient();

  try {
    switch (event.type) {
      // ── checkout.session.completed ─────────────────────────────────────────
      // Fired when a customer completes a Checkout Session.
      // We activate the new plan immediately.
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const organization_id = session.metadata?.organization_id;
        const plan_id = session.metadata?.plan_id;
        const stripeCustomerId = session.customer as string | null;

        if (!organization_id || !plan_id) {
          log.warn("checkout.session.completed missing metadata", {
            session_id: session.id,
          });
          break;
        }

        // Persist the Stripe customer ID in billing.accounts for future lookups
        if (stripeCustomerId) {
          await upsertStripeCustomer(client, organization_id, stripeCustomerId);
        }

        // Apply the new plan
        const { error } = await client
          .schema("billing")
          .rpc("change_plan", {
            _organization_id: organization_id,
            _plan_id: plan_id,
          });

        if (error) {
          log.error("Failed to change plan after checkout", {
            organization_id,
            plan_id,
            error: error.message,
          });
        } else {
          log.info("Plan activated via Stripe checkout", {
            organization_id,
            plan_id,
          });
        }
        break;
      }

      // ── invoice.payment_succeeded ──────────────────────────────────────────
      // Fired when a Stripe invoice is paid (monthly renewal via Stripe).
      // We mark the most recent 'issued' billing.invoices row as 'paid'
      // and record a payment entry.
      case "invoice.payment_succeeded": {
        const stripeInvoice = event.data.object as Stripe.Invoice;
        const organization_id = stripeInvoice.subscription_details?.metadata
          ?.organization_id;

        if (!organization_id) {
          log.warn("invoice.payment_succeeded missing organization_id", {
            stripe_invoice_id: stripeInvoice.id,
          });
          break;
        }

        const amount = (stripeInvoice.amount_paid ?? 0) / 100; // cents → dollars

        // Find the most recent issued invoice for this org
        const { data: invoice } = await client
          .schema("billing")
          .from("invoices")
          .select("id")
          .eq("organization_id", organization_id)
          .eq("status", "issued")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (invoice) {
          // Mark invoice as paid
          await client
            .schema("billing")
            .from("invoices")
            .update({ status: "paid" })
            .eq("id", invoice.id);

          // Record payment
          await client
            .schema("billing")
            .from("payments")
            .insert({
              invoice_id: invoice.id,
              organization_id,
              amount,
              method: "stripe",
              status: "succeeded",
              external_id: stripeInvoice.id,
            });

          log.info("Invoice marked as paid", {
            invoice_id: invoice.id,
            organization_id,
            amount,
          });
        } else {
          log.warn(
            "No issued invoice found for payment_succeeded — recording standalone payment",
            { organization_id },
          );
        }
        break;
      }

      // ── invoice.payment_failed ─────────────────────────────────────────────
      // Log the failure. Do not auto-downgrade — Stripe retries automatically,
      // and forced downgrades should be a deliberate business decision.
      case "invoice.payment_failed": {
        const stripeInvoice = event.data.object as Stripe.Invoice;
        const organization_id = stripeInvoice.subscription_details?.metadata
          ?.organization_id;

        log.warn("Stripe payment failed", {
          organization_id,
          stripe_invoice_id: stripeInvoice.id,
          attempt_count: stripeInvoice.attempt_count,
        });

        // Record a failed payment for visibility in the dashboard
        if (organization_id) {
          const { data: invoice } = await client
            .schema("billing")
            .from("invoices")
            .select("id")
            .eq("organization_id", organization_id)
            .eq("status", "issued")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (invoice) {
            await client
              .schema("billing")
              .from("payments")
              .insert({
                invoice_id: invoice.id,
                organization_id,
                amount: (stripeInvoice.amount_due ?? 0) / 100,
                method: "stripe",
                status: "failed",
                external_id: stripeInvoice.id,
              });
          }
        }
        break;
      }

      // ── customer.subscription.deleted ─────────────────────────────────────
      // Subscription cancelled in Stripe (e.g. after all retries failed).
      // Downgrade the organization to the free plan.
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const organization_id = subscription.metadata?.organization_id;

        if (!organization_id) {
          log.warn("customer.subscription.deleted missing organization_id", {
            subscription_id: subscription.id,
          });
          break;
        }

        // Find the default free plan
        const { data: freePlan } = await client
          .schema("billing")
          .from("plans")
          .select("id")
          .eq("is_default", true)
          .single();

        if (freePlan) {
          const { error } = await client
            .schema("billing")
            .rpc("change_plan", {
              _organization_id: organization_id,
              _plan_id: freePlan.id,
            });

          if (error) {
            log.error("Failed to downgrade to free plan", {
              organization_id,
              error: error.message,
            });
          } else {
            log.info(
              "Org downgraded to free plan after subscription deletion",
              {
                organization_id,
              },
            );
          }
        }
        break;
      }

      default:
        log.info(`Unhandled Stripe event type: ${event.type}`);
    }
  } catch (err) {
    log.error(`Error processing Stripe event ${event.type}`, err);
    // Return 200 anyway to prevent Stripe from retrying — we log the error.
    // For transient errors (DB down), returning 500 would cause Stripe to retry.
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});

/**
 * Persists the Stripe customer ID in billing.accounts, creating the account
 * row if it does not exist yet, and linking it to the subscription.
 */
async function upsertStripeCustomer(
  client: ReturnType<typeof createUnsecureClient>,
  organization_id: string,
  stripe_customer_id: string,
): Promise<void> {
  // Check if an account is already linked
  const { data: sub } = await client
    .schema("billing")
    .from("subscriptions")
    .select("account_id")
    .eq("organization_id", organization_id)
    .single();

  if (sub?.account_id) {
    // Update existing account's extra with stripe_customer_id
    await client
      .schema("billing")
      .from("accounts")
      .update({ extra: { stripe_customer_id } } as never)
      .eq("id", sub.account_id);
  } else {
    // Create new account and link to subscription
    const { data: account } = await client
      .schema("billing")
      .from("accounts")
      .insert({ name: organization_id, extra: { stripe_customer_id } } as never)
      .select("id")
      .single();

    if (account) {
      await client
        .schema("billing")
        .from("subscriptions")
        .update({ account_id: account.id })
        .eq("organization_id", organization_id);
    }
  }
}
