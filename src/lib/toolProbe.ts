import type OpenAI from "openai";
import { createLLM, defaultModel } from "@/lib/llm";

/**
 * Result of determining whether the model stably supports function calling (tool use).
 *
 * GLM-5.2 has a track record of unstable `response_format`, and tool_calls may
 * similarly be unstable. Therefore, a probe is run once at startup to determine this.
 */
export type ToolSupport = {
  supported: boolean;
  checkedAt: Date;
};

let cached: ToolSupport | null = null;
let probePromise: Promise<ToolSupport> | null = null;

/** Call to discard the cache on config changes (when LLM-related settings change). */
export function resetToolProbeCache(): void {
  cached = null;
  probePromise = null;
}

/**
 * Dummy search tool definition for probing. Expected to never actually be called.
 */
const PROBE_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web for information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
];

/**
 * Probes whether the model supports function calling.
 * Probe content: define a dummy search tool in `tools`, and call
 * `chat.completions.create` once with `stream:false` using the message
 * "Return the string 'probe-ok' without calling any tool."
 *
 * - `finish_reason==="stop"` and content contains "probe-ok" → supported: true
 * - `tool_calls` were called unprompted, or error/timeout → supported: false
 *
 * Results are cached in-process (same pattern as getUmansModels).
 * The probe is started in the background at startup; `probeToolSupport`
 * awaits until results are ready.
 *
 * @param llm OpenAI client
 * @param model Model id (defaults to defaultModel() if unspecified)
 * @param client For test injection. If unspecified, createLLM() is used — but llm is required.
 */
export async function probeToolSupport(
  llm: OpenAI,
  model: string = defaultModel(),
): Promise<ToolSupport> {
  if (cached) return cached;
  if (probePromise) return probePromise;
  probePromise = runProbe(llm, model);
  try {
    cached = await probePromise;
    return cached;
  } finally {
    probePromise = null;
  }
}

async function runProbe(llm: OpenAI, model: string): Promise<ToolSupport> {
  try {
    const completion = await llm.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content:
            "Return the string 'probe-ok' without calling any tool. Do not call any function.",
        },
      ],
      tools: PROBE_TOOLS,
      stream: false,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

    const choice = completion.choices?.[0];
    if (!choice) return { supported: false, checkedAt: new Date() };

    // Tool was called unprompted → not supported (cannot follow instructions)
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      return { supported: false, checkedAt: new Date() };
    }

    if (choice.finish_reason === "stop") {
      const content = choice.message.content ?? "";
      if (content.includes("probe-ok")) {
        return { supported: true, checkedAt: new Date() };
      }
    }

    return { supported: false, checkedAt: new Date() };
  } catch {
    return { supported: false, checkedAt: new Date() };
  }
}

let warmupStarted = false;

/**
 * Starts the probe in the background at process startup to hide first-request latency.
 *
 * Environment variables may not be set immediately after module load, so it runs
 * with a microtask delay (to execute after env loading at the entry point).
 * Warmup failure is harmless: retried on the first `probeToolSupport()` call.
 */
export function warmupToolProbe(): void {
  if (warmupStarted) return;
  warmupStarted = true;
  queueMicrotask(() => {
    try {
      void probeToolSupport(createLLM(), defaultModel());
    } catch {
    // Warmup failure is harmless (retried on first request)
    }
  });
}
