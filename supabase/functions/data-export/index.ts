import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import * as log from "../_shared/logger.ts";
import {
  createClient,
  createUnsecureClient,
} from "../_shared/supabase.ts";

type AppEnv = {
  Variables: {
    supabase: ReturnType<typeof createClient>;
    user: any;
    token: string;
  };
};

const app = new Hono<AppEnv>();

app.use("*", cors());

// Authentication Middleware
app.use("*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    throw new HTTPException(401, {
      message: "Missing authorization token",
    });
  }

  c.set("token", token);

  const client = createClient(c.req.raw);
  const { data: { user }, error: userError } = await client.auth.getUser();

  if (userError || !user) {
    log.error("Invalid JWT", userError);
    throw new HTTPException(401, {
      message: "Invalid JWT",
      cause: userError,
    });
  }

  c.set("user", user);
  c.set("supabase", client);

  await next();
});

app.post("/data-export", async (c) => {
  const body = await c.req.json<{ organization_id: string }>();
  const organization_id = body.organization_id;

  if (!organization_id) {
    throw new HTTPException(400, { message: "Missing organization_id" });
  }

  const client = c.get("supabase");
  const user = c.get("user");

  // Validate that the user is the owner of the organization
  const { error: agentError, data: agent } = await client
    .from("agents")
    .select("organization_id")
    .eq("user_id", user.id)
    .eq("organization_id", organization_id)
    .eq("extra->>role", "owner")
    .maybeSingle();

  if (agentError || !agent) {
    log.error(`User ${user.id} not authorized to export organization ${organization_id}`);
    throw new HTTPException(403, {
      message: "Only organization owners can export data.",
    });
  }

  log.info(`Exporting data for organization ${organization_id}`);

  // Use unsecureClient (service_role) to retrieve all org-related records
  const unsecureClient = createUnsecureClient();

  const [
    orgRes,
    addressesRes,
    agentsRes,
    contactsRes,
    contactsAddressesRes,
    conversationsRes,
    messagesRes,
    webhooksRes,
    apiKeysRes,
  ] = await Promise.all([
    unsecureClient.from("organizations").select().eq("id", organization_id),
    unsecureClient.from("organizations_addresses").select().eq("organization_id", organization_id),
    unsecureClient.from("agents").select().eq("organization_id", organization_id),
    unsecureClient.from("contacts").select().eq("organization_id", organization_id),
    unsecureClient.from("contacts_addresses").select().eq("organization_id", organization_id),
    unsecureClient.from("conversations").select().eq("organization_id", organization_id),
    unsecureClient.from("messages").select().eq("organization_id", organization_id),
    unsecureClient.from("webhooks").select().eq("organization_id", organization_id),
    unsecureClient.from("api_keys").select().eq("organization_id", organization_id),
  ]);

  const dump = {
    exported_at: new Date().toISOString(),
    organization_id,
    organizations: orgRes.data || [],
    organizations_addresses: addressesRes.data || [],
    agents: agentsRes.data || [],
    contacts: contactsRes.data || [],
    contacts_addresses: contactsAddressesRes.data || [],
    conversations: conversationsRes.data || [],
    messages: messagesRes.data || [],
    webhooks: webhooksRes.data || [],
    api_keys: apiKeysRes.data || [],
  };

  return c.json(dump);
});

Deno.serve(app.fetch);
