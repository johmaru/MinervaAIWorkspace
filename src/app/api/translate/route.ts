import type OpenAI from "openai";
import { createLLM, defaultModel, buildDisableReasoningParams } from "@/lib/llm";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  text: string;
  targetLang: string; // English display name, e.g. "Japanese", "English"
  sourceLang?: string; // English display name; omitted = auto-detect
  context?: string; // Optional situational context for tone/terminology
};

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

  const { text, targetLang, sourceLang } = body;
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
  const systemPrompt = `You are a professional translator. Translate the following text ${sourceClause}into ${targetLang}. If the source language is the same as the target, still provide the text as-is. Return only the translated text, no explanations.${contextClause}`;
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
      stream: false,
      temperature: 0.3,
      max_tokens: 4096,
      ...disableParams,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, {
      timeout: 30_000,
      maxRetries: 0,
    });

    const translation =
      completion.choices?.[0]?.message?.content?.trim() ?? "";

    return Response.json({ translation, detectedLang: "" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[translate] LLM call failed:", message);
    return Response.json({ error: "Translation failed" }, { status: 502 });
  }
}
