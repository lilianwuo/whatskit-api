import { corsHeaders } from "../_shared/cors.ts";

const API_VERSION = "v25.0";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // Trata a requisição de pré-teste (Preflight) do navegador
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Puxa as credenciais direto dos Secrets guardados no Supabase
    const WABA_ID = Deno.env.get("META_WABA_ID");
    const TOKEN = Deno.env.get("META_SYSTEM_USER_ACCESS_TOKEN");

    if (!WABA_ID || !TOKEN) {
      return jsonResponse(
        {
          error:
            "Configuração pendente: META_WABA_ID ou META_SYSTEM_USER_ACCESS_TOKEN ausentes nos Secrets do Supabase.",
        },
        400,
      );
    }

    // URL oficial da Meta para buscar os modelos (WABA ID)
    const url =
      `https://graph.facebook.com/${API_VERSION}/${WABA_ID}/message_templates`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));

    // Propaga o erro real da Meta (token expirado, permissão faltando, etc.)
    // em vez de mascarar como sucesso.
    if (!response.ok) {
      return jsonResponse(
        {
          error: "Não foi possível buscar os modelos na Meta.",
          meta_error: data?.error ?? data,
        },
        response.status,
      );
    }

    // Devolve a lista de modelos aprovados para o Whatskit
    return jsonResponse(data, 200);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
