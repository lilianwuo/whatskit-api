/**
 * Adaptação do disparador "Rede Pocante" para enviar PELO whatskit
 * ================================================================
 *
 * Troca o destino do envio de WhatsApp: em vez de chamar a Meta Graph API
 * diretamente (que NÃO aparece no whatskit), passa a inserir a mensagem via
 * API do whatskit. Resultado: a Meta envia E a mensagem fica registrada nas
 * conversas do whatskit (com WAMID e status de entrega).
 *
 * IMPORTANTE — a API do whatskit usa DUAS chaves + o organization_id:
 *   - apikey  (header padrão do Supabase): a "Publishable key" do projeto
 *             Supabase (NUNCA a Secret key — ela ignora as regras de segurança).
 *   - api-key (header CUSTOMIZADO, com hífen): a API key do whatskit, gerada
 *             no app do whatskit (Settings > API Keys). É ela que identifica
 *             a sua organização e o papel (role).
 *   - organization_id: precisa ir no corpo do POST (UUID da sua org).
 *
 * Configuração (Project Settings > Script Properties):
 *   WHATSKIT_URL              = https://lituwvrjuiqwnnqebddp.supabase.co
 *   SUPABASE_PUBLISHABLE_KEY  = <Publishable key do Supabase (Settings > API)>
 *   WHATSKIT_API_KEY          = <API key do whatskit (app > Settings > API Keys)>
 *   WHATSKIT_ORG_ID           = <UUID da sua organização>
 * Mantém CONFIG.PHONE_ID = 1017700914763558 (o organization_address).
 *
 * O que muda no seu script atual:
 *   1. Adicionar o helper _whatskit() e _whatskitHeaders() (abaixo).
 *   2. SUBSTITUIR a função enviarMensagemAPI por esta versão.
 *      (processarDisparoWhatsApp e dispararTesteWhatsApp continuam IGUAIS.)
 *   3. (Opcional) Usar subirContatosWhatskit() para popular a base no whatskit.
 */

function _whatskit() {
  var p = PropertiesService.getScriptProperties();
  return {
    url: (p.getProperty("WHATSKIT_URL") || "").replace(/\/+$/, ""),
    supabaseKey: p.getProperty("SUPABASE_PUBLISHABLE_KEY"),
    apiKey: p.getProperty("WHATSKIT_API_KEY"),
    orgId: p.getProperty("WHATSKIT_ORG_ID"),
    orgAddress: CONFIG.PHONE_ID, // 1017700914763558
  };
}

function _whatskitHeaders(wk, extra) {
  var h = {
    "apikey": wk.supabaseKey,               // passa pelo gateway do Supabase (role anon)
    "Authorization": "Bearer " + wk.supabaseKey,
    "api-key": wk.apiKey,                    // header customizado: identidade no whatskit
  };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

// Busca o TEXTO do corpo (BODY) de um template aprovado, para usar como prévia
// legível no whatskit. Usa o endpoint multi-tenant do whatskit (a edge function
// aceita a api key do whatskit como Bearer). Cacheia 6h para não chamar a cada envio.
function obterTextoTemplate(templateName) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get("tpl_" + templateName);
  if (hit !== null) return hit;

  var wk = _whatskit();
  try {
    var res = UrlFetchApp.fetch(wk.url + "/functions/v1/whatsapp-management/templates", {
      method: "put",
      contentType: "application/json",
      headers: {
        "apikey": wk.supabaseKey,
        "Authorization": "Bearer " + wk.apiKey // verify_jwt=false: a function lê a api key aqui
      },
      payload: JSON.stringify({
        organization_id: wk.orgId,
        organization_address: wk.orgAddress
      }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) return "";

    var lista = JSON.parse(res.getContentText());
    var arr = lista.data || lista; // a Meta retorna { data: [...] }
    var tpl = (arr || []).filter(function (t) { return t.name === templateName; })[0];
    if (!tpl) return "";

    var body = (tpl.components || []).filter(function (c) { return c.type === "BODY"; })[0];
    var texto = (body && body.text) ? body.text : "";
    cache.put("tpl_" + templateName, texto, 21600); // 6h
    return texto;
  } catch (e) {
    return "";
  }
}

// --- SUBSTITUA sua enviarMensagemAPI por esta ---
// Template com botão de URL ESTÁTICO (sem variável {{1}}): enviamos só o header.
function enviarMensagemAPI(telefone, templateName, imagemUrl) {
  var wk = _whatskit();
  var url = wk.url + "/rest/v1/messages";

  // content.data é EXATAMENTE o objeto "template" que você já enviava à Meta.
  // content.text é um resumo legível: a UI do whatskit mostra ELE em vez do
  // JSON cru (o dispatcher ignora o text e envia só o content.data à Meta).
  var components = [
    { type: "header", parameters: [ { type: "image", image: { link: imagemUrl } } ] }
  ];

  var content = {
    version: "1",
    type: "data",
    kind: "template",
    // Prévia legível no whatskit: o texto real do corpo do modelo (com fallback
    // para o nome, caso a busca falhe).
    text: obterTextoTemplate(templateName) || ("📨 Modelo enviado: " + templateName),
    data: {
      name: templateName,
      language: { code: "pt_BR", policy: "deterministic" },
      components: components
    }
  };

  var payload = {
    organization_id: wk.orgId,
    organization_address: wk.orgAddress,
    contact_address: String(telefone).replace(/\D/g, ""),
    service: "whatsapp",
    direction: "outgoing",
    content: content
  };

  try {
    var response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: _whatskitHeaders(wk, { "Prefer": "return=representation" }),
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    var body = response.getContentText();

    if (code < 200 || code >= 300) {
      var err;
      try { err = JSON.parse(body); } catch (e) { err = { message: body }; }
      return { ok: false, erro: (err.message || err.error || body) };
    }

    var rows = JSON.parse(body);
    // O envio à Meta acontece de forma assíncrona (dispatcher). Aqui só
    // confirmamos que a mensagem foi REGISTRADA/enfileirada no whatskit.
    if (rows && rows[0] && rows[0].id) return { ok: true, id: rows[0].id };
    return { ok: false, erro: "Resposta inesperada do whatskit" };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

// --- (Opcional) Subir a base de contatos no whatskit ---
// Em DUAS etapas porque a RLS bloqueia o atalho synced.add para members:
//   1) cria o contato (nome)  -> POST /rest/v1/contacts
//   2) vincula o telefone     -> POST /rest/v1/contacts_addresses
// Use a lista que buscarContatosFiltrados() já produz: [{ nome, telefone, ... }]
function subirContatosWhatskit(listaContatos) {
  var wk = _whatskit();
  var criados = 0, erros = 0;

  for (var i = 0; i < listaContatos.length; i++) {
    var c = listaContatos[i];
    var telefone = String(c.telefone).replace(/\D/g, "");
    if (!telefone) continue;

    try {
      // 1) cria o contato
      var resC = UrlFetchApp.fetch(wk.url + "/rest/v1/contacts", {
        method: "post",
        contentType: "application/json",
        headers: _whatskitHeaders(wk, { "Prefer": "return=representation" }),
        payload: JSON.stringify({ organization_id: wk.orgId, name: c.nome || "" }),
        muteHttpExceptions: true
      });
      if (resC.getResponseCode() >= 300) {
        erros++; Logger.log("contato " + telefone + ": " + resC.getContentText()); continue;
      }
      var contactId = JSON.parse(resC.getContentText())[0].id;

      // 2) vincula o telefone ao contato (upsert por telefone)
      var resA = UrlFetchApp.fetch(wk.url + "/rest/v1/contacts_addresses", {
        method: "post",
        contentType: "application/json",
        headers: _whatskitHeaders(wk, { "Prefer": "resolution=merge-duplicates" }),
        payload: JSON.stringify({
          organization_id: wk.orgId,
          contact_id: contactId,
          service: "whatsapp",
          address: telefone
        }),
        muteHttpExceptions: true
      });
      if (resA.getResponseCode() >= 300) {
        erros++; Logger.log("endereço " + telefone + ": " + resA.getContentText()); continue;
      }

      criados++;
    } catch (e) {
      erros++; Logger.log("contato " + telefone + " erro: " + e.message);
    }
    Utilities.sleep(300);
  }

  Logger.log("Contatos subidos: " + criados + " | erros: " + erros);
  return { criados: criados, erros: erros, total: listaContatos.length };
}

// Exemplo: subir todos os contatos elegíveis (sem filtro de presença/edição)
function subirBaseCompleta() {
  var lista = buscarContatosFiltrados({ presente: "todos", edicoes: [] });
  return subirContatosWhatskit(lista);
}
