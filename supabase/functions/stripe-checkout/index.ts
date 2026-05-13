/**
 * stripe-checkout — creates a Stripe Checkout Session for plan upgrades.
 *
 * POST /stripe-checkout
 * Body: { organization_id: string, plan_id: string, success_url: string, cancel_url: string }
 * Auth: Bearer JWT (owner or admin only)
 *
 * Environment variables required:
 *   STRIPE_SECRET_KEY        — Stripe secret key (sk_live_… or sk_test_…)
 *
 * Each plan must have its Stripe price_id stored in billing.plans.extra->>'stripe_price_id'.
 * Example: UPDATE billing.plans SET extra = '{"stripe_price_id":"price_xxx"}' WHERE id = 'starter';
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import Stripe from "stripe";
import * as log from "../_shared/logger.ts";
import {
  createClient,
  createUnsecureClient,
  type ApiKeyRow,
} from "../_shared/supabase.ts";
import { type User } from "@supabase/supabase-js";

type AppEnv = {
  Variables: {
    supabase: ReturnType<typeof createClient>;
    unsecureClient: ReturnType<typeof createUnsecureClient>;
    user: User | null;
    apiKey: ApiKeyRow | null;
  };
};

const app = new Hono<AppEnv>();

app.use("*", cors());

// Auth middleware — same pattern as whatsapp-management
app.use("*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    throw new HTTPException(401, { message: "Missing authorization token" });
  }

  if (token.startsWith("eyJ")) {
    const client = createClient(c.req.raw);
    const { data: { user }, error } = await client.auth.getUser();

    if (error || !user) {
      throw new HTTPException(401, { message: "Invalid JWT", cause: error });
    }

    c.set("user", user);
    c.set("apiKey", null);
    c.set("supabase", client);
  } else {
    throw new HTTPException(401, {
      message: "Stripe checkout requires user authentication",
    });
  }

  c.set("unsecureClient", createUnsecureClient());
  await next();
});

app.post("/stripe-checkout", async (c) => {
  const { organization_id, plan_id, success_url, cancel_url } = await c.req
    .json<{
      organization_id: string;
      plan_id: string;
      success_url: string;
      cancel_url: string;
    }>();

  if (!organization_id || !plan_id || !success_url || !cancel_url) {
    throw new HTTPException(400, { message: "Missing required fields" });
  }

  const user = c.get("user")!;
  const client = c.get("supabase");
  const unsecureClient = c.get("unsecureClient");

  // Verify the user is owner or admin of this organization
  const { data: agent, error: agentError } = await client
    .from("agents")
    .select("organization_id")
    .eq("user_id", user.id)
    .eq("organization_id", organization_id)
    .in("extra->>role", ["owner", "admin"])
    .maybeSingle();

  if (agentError || !agent) {
    throw new HTTPException(403, {
      message: "Not authorized for this organization",
    });
  }

  // Get plan details including Stripe price_id from extra field
  const { data: plan, error: planError } = await unsecureClient
    .schema("billing")
    .from("plans")
    .select("id, price, billing_cycle, extra")
    .eq("id", plan_id)
    .eq("active", true)
    .single();

  if (planError || !plan) {
    throw new HTTPException(404, {
      message: `Plan '${plan_id}' not found or inactive`,
    });
  }

  const stripePriceId = (plan.extra as Record<string, string> | null)
    ?.stripe_price_id;

  if (!stripePriceId) {
    throw new HTTPException(422, {
      message: `Plan '${plan_id}' has no Stripe price_id configured. Set billing.plans.extra->>'stripe_price_id'.`,
    });
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    throw new HTTPException(500, { message: "STRIPE_SECRET_KEY not set" });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2025-03-31.basil" });

  // Look up or create a Stripe customer linked to this organization
  const { data: subscription } = await unsecureClient
    .schema("billing")
    .from("subscriptions")
    .select("account_id, accounts(name)")
    .eq("organization_id", organization_id)
    .single();

  let customerId: string | undefined;

  // Retrieve existing Stripe customer ID from billing.accounts.extra
  if (subscription?.account_id) {
    const { data: account } = await unsecureClient
      .schema("billing")
      .from("accounts")
      .select("extra")
      .eq("id", subscription.account_id)
      .single();

    customerId = (account?.extra as Record<string, string> | null)
      ?.stripe_customer_id;
  }

  // Create checkout session
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: stripePriceId, quantity: 1 }],
    success_url,
    cancel_url,
    customer: customerId,
    client_reference_id: organization_id,
    metadata: {
      organization_id,
      plan_id,
    },
    subscription_data: {
      metadata: {
        organization_id,
        plan_id,
      },
    },
  });

  log.info("Stripe checkout session created", {
    session_id: session.id,
    organization_id,
    plan_id,
  });

  return c.json({ url: session.url, session_id: session.id });
});

Deno.serve(app.fetch);
