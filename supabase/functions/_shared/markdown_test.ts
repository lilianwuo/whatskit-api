import { assertEquals } from "jsr:@std/assert@1";
import { markdownToWhatsApp, whatsappToMarkdown } from "./markdown.ts";

// ─────────────────────────────────────────────────────────────────────────────
// markdownToWhatsApp
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("markdownToWhatsApp: texto simples sem formatação permanece igual", () => {
  assertEquals(markdownToWhatsApp("Olá, mundo!"), "Olá, mundo!");
});

Deno.test("markdownToWhatsApp: negrito **text** vira *text*", () => {
  assertEquals(markdownToWhatsApp("**negrito**"), "*negrito*");
});

Deno.test("markdownToWhatsApp: negrito __text__ vira *text*", () => {
  assertEquals(markdownToWhatsApp("__negrito__"), "*negrito*");
});

Deno.test("markdownToWhatsApp: itálico *text* vira _text_", () => {
  assertEquals(markdownToWhatsApp("*itálico*"), "_itálico_");
});

Deno.test("markdownToWhatsApp: itálico _text_ permanece _text_", () => {
  assertEquals(markdownToWhatsApp("_itálico_"), "_itálico_");
});

Deno.test("markdownToWhatsApp: tachado ~~text~~ vira ~text~", () => {
  assertEquals(markdownToWhatsApp("~~tachado~~"), "~tachado~");
});

Deno.test("markdownToWhatsApp: cabeçalho # Título vira *Título*", () => {
  assertEquals(markdownToWhatsApp("# Título"), "*Título*");
});

Deno.test("markdownToWhatsApp: cabeçalho ## Sub vira *Sub*", () => {
  assertEquals(markdownToWhatsApp("## Sub"), "*Sub*");
});

Deno.test("markdownToWhatsApp: bloco de código não é alterado", () => {
  const code = "```\nconst x = 1;\n```";
  assertEquals(markdownToWhatsApp(code), code);
});

Deno.test("markdownToWhatsApp: código inline não é alterado", () => {
  const code = "Use `npm install` para instalar";
  assertEquals(markdownToWhatsApp(code), "Use `npm install` para instalar");
});

Deno.test("markdownToWhatsApp: negrito e itálico combinados na mesma linha", () => {
  const input = "**negrito** e *itálico*";
  const expected = "*negrito* e _itálico_";
  assertEquals(markdownToWhatsApp(input), expected);
});

Deno.test("markdownToWhatsApp: string vazia retorna string vazia", () => {
  assertEquals(markdownToWhatsApp(""), "");
});

Deno.test("markdownToWhatsApp: múltiplos parágrafos com formatação", () => {
  const input = "**Parágrafo 1**\n\n*Parágrafo 2*";
  const expected = "*Parágrafo 1*\n\n_Parágrafo 2_";
  assertEquals(markdownToWhatsApp(input), expected);
});

// ─────────────────────────────────────────────────────────────────────────────
// whatsappToMarkdown
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("whatsappToMarkdown: texto simples sem formatação permanece igual", () => {
  assertEquals(whatsappToMarkdown("Olá, mundo!"), "Olá, mundo!");
});

Deno.test("whatsappToMarkdown: negrito *text* vira **text**", () => {
  assertEquals(whatsappToMarkdown("*negrito*"), "**negrito**");
});

Deno.test("whatsappToMarkdown: itálico _text_ vira *text*", () => {
  assertEquals(whatsappToMarkdown("_itálico_"), "*itálico*");
});

Deno.test("whatsappToMarkdown: tachado ~text~ vira ~~text~~", () => {
  assertEquals(whatsappToMarkdown("~tachado~"), "~~tachado~~");
});

Deno.test("whatsappToMarkdown: bloco de código não é alterado", () => {
  const code = "```\nconst x = 1;\n```";
  assertEquals(whatsappToMarkdown(code), code);
});

Deno.test("whatsappToMarkdown: código inline não é alterado", () => {
  const code = "Use `npm install` para instalar";
  assertEquals(whatsappToMarkdown(code), "Use `npm install` para instalar");
});

Deno.test("whatsappToMarkdown: string vazia retorna string vazia", () => {
  assertEquals(whatsappToMarkdown(""), "");
});

Deno.test("whatsappToMarkdown: negrito e itálico combinados", () => {
  const input = "*negrito* e _itálico_";
  const expected = "**negrito** e *itálico*";
  assertEquals(whatsappToMarkdown(input), expected);
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("round-trip: markdown → whatsapp → markdown preserva negrito", () => {
  const original = "**negrito**";
  const wa = markdownToWhatsApp(original);
  const back = whatsappToMarkdown(wa);
  assertEquals(back, original);
});

Deno.test("round-trip: markdown → whatsapp → markdown preserva tachado", () => {
  const original = "~~tachado~~";
  const wa = markdownToWhatsApp(original);
  const back = whatsappToMarkdown(wa);
  assertEquals(back, original);
});
