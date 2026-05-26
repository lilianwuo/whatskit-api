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

app.post("/storage-cleanup", async (c) => {
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
    log.error(`User ${user.id} not authorized to cleanup storage for organization ${organization_id}`);
    throw new HTTPException(403, {
      message: "Only organization owners can cleanup organization storage.",
    });
  }

  log.info(`Cleaning up storage for organization ${organization_id}`);

  // Use unsecureClient (service_role) to list and delete files in the storage bucket
  const unsecureClient = createUnsecureClient();

  const folderPath = `organizations/${organization_id}/attachments`;

  // List all files under the organization attachments folder
  const { data: files, error: listError } = await unsecureClient.storage
    .from("media")
    .list(folderPath);

  if (listError) {
    log.error(`Failed to list files in storage under ${folderPath}`, listError);
    return c.json({ success: false, error: listError.message }, 500);
  }

  if (files && files.length > 0) {
    const fileKeys = files.map((file) => `${folderPath}/${file.name}`);
    log.info(`Removing ${fileKeys.length} files from media storage:`, fileKeys);

    const { error: removeError } = await unsecureClient.storage
      .from("media")
      .remove(fileKeys);

    if (removeError) {
      log.error("Failed to delete files from storage", removeError);
      return c.json({ success: false, error: removeError.message }, 500);
    }
  }

  return c.json({ success: true, message: `Successfully cleaned up ${files?.length || 0} files` });
});

Deno.serve(app.fetch);
