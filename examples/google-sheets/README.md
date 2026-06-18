# Integração Google Sheets → whatskit

Envia mensagens de WhatsApp **pelo whatskit** a partir de uma planilha, de modo
que cada mensagem fique registrada nas conversas (com WAMID e status de entrega),
em vez de chamar a Meta Graph API diretamente — que não aparece no whatskit.

## Por que usar a API do whatskit (e não a Meta direto)

Mensagens enviadas direto pela Meta Graph API **não são registradas** no whatskit:
a Meta só ecoa para o app mensagens que o próprio app enviou. Ao inserir a
mensagem via `POST /rest/v1/messages`, o whatskit dispara internamente o
`whatsapp-dispatcher`, que envia à Meta **e** persiste a mensagem.

```
Apps Script → POST /rest/v1/messages → trigger → whatsapp-dispatcher → Meta API
                                              ↘ registra em messages/conversations
```

## Autenticação: DUAS chaves + o organization_id

Chamar `POST /rest/v1/...` com identidade do whatskit exige:

- header `apikey` + `Authorization: Bearer` → a **Publishable key** do Supabase
  (Settings → API). **Nunca** a Secret key (ela ignora a RLS).
- header customizado `api-key` → a **API key do whatskit** (tabela
  `public.api_keys`). É ela que identifica a organização e o papel.
- `organization_id` no corpo do POST (não há default).

## Configuração

1. **Publishable key**: Supabase → Settings → API → "Publishable key".
2. **API key do whatskit**: gere no app (Settings → API Keys). Se o botão da UI
   não funcionar, crie manualmente no SQL Editor:
   ```sql
   -- 1) gere e copie o valor:
   SELECT 'wk_' || encode(extensions.gen_random_bytes(24), 'hex') AS nova_chave;
   -- 2) grave o hash (troque <CHAVE>); retorna o organization_id:
   INSERT INTO public.api_keys (organization_id, role, name, key_prefix, key_hash)
   SELECT oa.organization_id, 'member'::public.role, 'planilha',
          substr('<CHAVE>', 1, 8), extensions.digest('<CHAVE>', 'sha256')
   FROM public.organizations_addresses oa
   WHERE oa.address = '<seu_phone_number_id>'
   RETURNING organization_id;
   ```
3. No Apps Script → **Project Settings → Script Properties**, adicione:
   | Propriedade | Valor |
   |-------------|-------|
   | `WHATSKIT_URL` | `https://<project-ref>.supabase.co` |
   | `SUPABASE_PUBLISHABLE_KEY` | a Publishable key (passo 1) |
   | `WHATSKIT_API_KEY` | a API key do whatskit (passo 2) |
   | `WHATSKIT_ORG_ID` | o `organization_id` (retornado no passo 2) |

   O `organization_address` (phone_number_id) é lido de `CONFIG.PHONE_ID`.
4. Cole o conteúdo de [`rede-pocante-whatskit.gs`](./rede-pocante-whatskit.gs)
   no projeto Apps Script (referência de implementação).

## Uso

`enviarMensagemAPI(telefone, templateName, imagemUrl)` envia um template aprovado
(com imagem no header) e o registra no whatskit. O envelope de conteúdo usa
`{ type:"data", kind:"template", text:<prévia>, data:<objeto template da Meta> }`
— o campo `text` é o que aparece legível na conversa (sem ele, a UI mostra o JSON
cru). `subirContatosWhatskit(lista)` sobe uma base de contatos (cria contato +
vincula telefone) em duas etapas, já que a RLS bloqueia o atalho `synced.add`.

## ⚠️ Janela de 24h e templates

O WhatsApp **só entrega texto livre dentro de 24h** após a última mensagem do
contato. Para **contatos frios** (o caso típico de disparo por planilha), é
**obrigatório** usar um **template aprovado** na Meta (`conteudoTemplate`). Por
isso a tela de Modelos do whatskit precisa estar listando os templates
corretamente (ver troubleshooting abaixo).

## Troubleshooting: a tela de Modelos não lista os templates

A UI chama `PUT /functions/v1/whatsapp-management/templates`, que lê
`waba_id` e `access_token` de `organizations_addresses.extra` (no banco) — não
dos secrets globais do Supabase. Se a lista vier vazia:

1. Verifique a linha da conta:
   ```sql
   SELECT organization_id, address, status, extra
   FROM organizations_addresses
   WHERE address = '<seu_phone_number_id>';
   ```
   `extra->>waba_id` e `extra->>access_token` precisam existir e ser válidos.
2. Teste a chamada à Meta diretamente:
   ```bash
   curl "https://graph.facebook.com/v24.0/<waba_id>/message_templates" \
     -H "Authorization: Bearer <access_token>"
   ```
   O corpo de erro indica a causa (token expirado, falta a permissão
   `whatsapp_business_management`, ou `waba_id` errado).
3. O erro real da Meta também é logado pela edge function `whatsapp-management`
   ("Could not fetch templates from Meta").

## Configurar o webhook da Meta (respostas + status)

Sem webhook, o disparo funciona, mas as **respostas dos contatos** e os **status
de entrega** (entregue/lido) não aparecem no whatskit. Para fechar o ciclo:

1. **Escolha um verify token** (qualquer string aleatória), ex.:
   ```sql
   SELECT 'vt_' || encode(extensions.gen_random_bytes(16), 'hex');
   ```
2. **Grave como secret** no Supabase (Edge Functions → Secrets, ou CLI):
   ```bash
   npx supabase secrets set WHATSAPP_VERIFY_TOKEN=<o_valor_escolhido>
   ```
   (`META_APP_ID` e `META_APP_SECRET` já existem — são usados para validar a
   assinatura `X-Hub-Signature-256` de cada evento.)
3. **No Meta App Dashboard** → WhatsApp → Configuration → Webhook → Edit:
   - **Callback URL**: `https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook`
   - **Verify token**: o mesmo valor do passo 1
   - Clique em **Verify and Save** (a Meta faz um GET e compara o token).
4. **Subscribe** ao campo **`messages`** — ele cobre tanto mensagens recebidas
   quanto atualizações de status (sent/delivered/read). (Opcional:
   `message_echoes` só é necessário se você ainda enviar algo fora do whatskit.)
5. Garanta que o app está **subscrito à sua WABA** (na própria tela de WhatsApp
   da Meta).

Pronto: respostas e status passam a aparecer nas conversas do whatskit.
