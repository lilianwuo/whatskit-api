import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// Cabeçalhos para liberar o acesso do seu front-end (CORS)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Trata a requisição de pré-teste (Preflight) do navegador
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Puxa as credenciais direto dos Segredos guardados no Supabase
    const WABA_ID = Deno.env.get('META_WABA_ID')
    const TOKEN = Deno.env.get('META_SYSTEM_USER_TOKEN')

    if (!WABA_ID || !TOKEN) {
      return new Response(
        JSON.stringify({ error: 'Configuração pendente: META_WABA_ID ou META_TOKEN ausentes nos Secrets do Supabase.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // URL oficial da Meta para buscar os modelos (WABA ID)
    const url = https://graph.facebook.com/v25.0/${WABA_ID}/message_templates
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': Bearer ${TOKEN},
        'Content-Type': 'application/json'
      }
    })

    const data = await response.json()

    // Devolve a lista de modelos aprovados para o Whatskit
    return new Response(
      JSON.stringify(data),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
