import type OpenAI from "openai";
import { createLLM, defaultModel, buildDisableReasoningParams } from "@/lib/llm";
import { getSessionUser } from "@/lib/auth-guards";
import { getRequestLocale } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Map UI locale to English language name for LLM prompt. */
const LOCALE_LANG_NAME: Record<Locale, string> = {
  en: "English",
  ja: "Japanese",
};

type Body = {
  text: string;
  targetLang: string; // English display name, e.g. "Japanese", "English"
  sourceLang?: string; // English display name; omitted = auto-detect
  explainLang?: string; // English display name for characteristics; omitted = derive from request locale
  context?: string; // Optional situational context for tone/terminology
  mode?: "single" | "multi"; // omitted = "single" (backward compatible)
};

type MultiCandidate = { text: string; characteristics: string };

/**
 * Parses multi-translation candidates from the LLM's raw response.
 * Returns null on invalid input; the caller falls back to raw text.
 * Follows the same strip-fences-then-JSON.parse pattern as parseDecision()
 * in src/lib/searchDecision.ts — no response_format, defensive parsing.
 */
function parseMultiTranslation(raw: string | null): MultiCandidate[] | null {
  if (!raw || !raw.trim()) return null;
  const stripped = raw.trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const translations = (parsed as Record<string, unknown>).translations;
  if (!Array.isArray(translations)) return null;
  const result: MultiCandidate[] = [];
  for (const c of translations) {
    if (
      typeof c === "object" && c !== null &&
      "text" in c && typeof c.text === "string" &&
      "characteristics" in c && typeof c.characteristics === "string"
    ) {
      if (c.text.trim().length > 0) {
        result.push({ text: c.text, characteristics: c.characteristics });
      }
    }
  }
  return result.length > 0 ? result.slice(0, 3) : null;
}

/**
 * POST /api/translate — Non-streaming LLM translation.
 *
 * Authenticates via getSessionUser(). Reuses the same createLLM() + non-streaming
 * completion pattern as contextCompaction.ts and chat route's completeText().
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { text, targetLang, sourceLang, explainLang } = body;
  const context = body.context?.trim() ?? "";

  if (!text || !text.trim()) {
    return Response.json({ error: "text is required" }, { status: 400 });
  }
  if (!targetLang || !targetLang.trim()) {
    return Response.json({ error: "targetLang is required" }, { status: 400 });
  }

  const llm = createLLM();
  const model = defaultModel();

  const sourceClause = sourceLang
    ? `from ${sourceLang} `
    : "";
  const contextClause = context
    ? " Use the provided context to ensure the translation fits the situation (tone, terminology, references)."
    : "";
  // characteristics language: explicit explainLang param, or fall back to the request's UI locale.
  const explainLangResolved = explainLang?.trim() || LOCALE_LANG_NAME[getRequestLocale(req)];
  const characteristicsLangClause = `in ${explainLangResolved}`;
  const isMulti = body.mode === "multi";
  const multiSystemPrompt = `You are a professional translator. Translate the following text ${sourceClause}into ${targetLang}.
Provide 3 different translation candidates, each with a distinct nuance or tone.
Return ONLY a JSON object in this exact format, no markdown, no code fences:
{"translations":[{"text":"<translation>","characteristics":"<one sentence ${characteristicsLangClause} describing the nuance, tone, and how it differs from the other candidates>"}]}
The first candidate should be the most natural/standard translation. ${contextClause}`;
  const systemPrompt = isMulti ? multiSystemPrompt : `You are a professional translator. Translate the following text ${sourceClause}into ${targetLang}. If the source language is the same as the target, still provide the text as-is. Return only the translated text, no explanations.${contextClause}`;
  const userContent = context
    ? `--- Context ---\n${context}\n\n--- Text to translate ---\n${text}`
    : text;

  try {
    const disableParams = await buildDisableReasoningParams(model);
    console.log("[translate] model:", model, "disableParams:", JSON.stringify(disableParams));
    const completion = await llm.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: isMulti ? 0.7 : 0.3,
      max_tokens: isMulti ? 8192 : 4096,
      ...disableParams,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, {
      timeout: 30_000,
      maxRetries: 0,
    });

    if (isMulti) {
      const rawText = completion.choices?.[0]?.message?.content ?? "";
      const candidates = parseMultiTranslation(rawText);
      if (candidates) {
        return Response.json({ translations: candidates, detectedLang: "" });
      }
      // Fallback: treat raw text as a single candidate with empty characteristics
      return Response.json({
        translations: [{ text: rawText.trim(), characteristics: "" }],
        detectedLang: "",
      });
    }

    const translation =
      completion.choices?.[0]?.message?.content?.trim() ?? "";

    return Response.json({ translation, detectedLang: "" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[translate] LLM call failed:", message);
    return Response.json({ error: "Translation failed" }, { status: 502 });
  }
}
