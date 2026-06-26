import type { Database, TemplateData } from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import { ContentfulStatusCode } from "jsr:@hono/hono/utils/http-status";

const API_VERSION = "v24.0";

async function getBusinessCredentials(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
): Promise<{ waba_id: string; access_token: string }> {
  const { data, error } = await client
    .from("organizations_addresses")
    .select("extra->>waba_id, extra->>access_token")
    .eq("organization_id", organization_id)
    .eq("address", organization_address)
    .single();

  if (error || !data) {
    log.error("Could not fetch business access token", error);
    throw new HTTPException(403, {
      message: "Could not fetch business access token",
      cause: error,
    });
  }

  return data;
}

export async function listTemplates(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
): Promise<TemplateData[]> {
  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!response.ok) {
    const cause = await response.json().catch(() => ({}));
    log.error("Could not fetch templates from Meta", {
      status: response.status,
      waba_id,
      cause,
    });
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not fetch templates",
      cause,
    });
  }

  return await response.json();
}

export async function fetchTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<TemplateData> {
  const { access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${template.id}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not fetch template",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}

export async function createTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<{
  id: string;
  status: string;
  category: string;
}> {
  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const { name, category, language, components } = template;

  const filteredTemplate = {
    name,
    category,
    allow_category_change: true,
    language,
    components,
  };

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(filteredTemplate),
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not create template",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}

/**
 * Uploads a media sample for a template header and returns the resulting
 * `header_handle`, which Meta requires when creating IMAGE/VIDEO/DOCUMENT
 * header templates. Uses the Graph Resumable Upload API (two steps):
 *   1. start an upload session on the app
 *   2. POST the file bytes and read back the handle (`h`)
 */
export async function uploadTemplateSample(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  file: { bytes: Uint8Array; type: string },
): Promise<{ handle: string }> {
  const { access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  // Multiple Meta apps may be configured pipe-separated; use the first.
  const app_id = Deno.env.get("META_APP_ID")?.split("|")[0];

  if (!app_id) {
    throw new HTTPException(500, { message: "META_APP_ID is not configured" });
  }

  // Step 1: start an upload session.
  const sessionResponse = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${app_id}/uploads?file_length=${file.bytes.length}&file_type=${
      encodeURIComponent(file.type)
    }`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!sessionResponse.ok) {
    throw new HTTPException(sessionResponse.status as ContentfulStatusCode, {
      message: "Could not start media upload",
      cause: await sessionResponse.json().catch(() => ({})),
    });
  }

  const { id: session_id } = await sessionResponse.json();

  // Step 2: upload the bytes (note the OAuth scheme and file_offset header).
  const uploadResponse = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${session_id}`,
    {
      method: "POST",
      headers: {
        Authorization: `OAuth ${access_token}`,
        file_offset: "0",
      },
      body: file.bytes,
    },
  );

  if (!uploadResponse.ok) {
    throw new HTTPException(uploadResponse.status as ContentfulStatusCode, {
      message: "Could not upload media sample",
      cause: await uploadResponse.json().catch(() => ({})),
    });
  }

  const { h } = await uploadResponse.json();

  return { handle: h };
}

export async function editTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<{
  success: boolean;
}> {
  const { access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const { category, components } = template;
  const filteredTemplate = { category, components };

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${template.id}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(filteredTemplate),
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not update template",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}

export async function deleteTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<{
  success: boolean;
}> {
  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates?name=${template.name}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not delete template",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}
