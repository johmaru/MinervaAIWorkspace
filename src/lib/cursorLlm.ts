/**
 * Cursor SDK adapter — bills LLM usage to the Cursor account via CURSOR_API_KEY.
 * Not OpenAI Chat Completions compatible; uses Agent / Run / stream events.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Agent, Cursor, type SDKAgent, type SDKMessage } from "@cursor/sdk";
import { getDataDir } from "@/lib/user-data";
import { getWorkspaceRoot } from "@/lib/workspace";
import { logger } from "@/lib/logger";

export type CursorModelInfo = {
  id: string;
  displayName: string;
};

export type CursorStreamHandlers = {
  onDelta: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onStatus?: (label: string) => void;
};

export function cursorApiKey(): string | null {
  const v = process.env.CURSOR_API_KEY?.trim();
  return v || null;
}

/** Workspace cwd for local Cursor agents (creates dir if missing). */
export function resolveCursorCwd(userId: string): string {
  const cwd = getWorkspaceRoot(userId);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

let cursorModelsCache: CursorModelInfo[] | null = null;
let cursorModelsPromise: Promise<CursorModelInfo[]> | null = null;

export function resetCursorModelsCache(): void {
  cursorModelsCache = null;
  cursorModelsPromise = null;
}

export async function listCursorModels(): Promise<CursorModelInfo[]> {
  if (cursorModelsCache) return cursorModelsCache;
  if (cursorModelsPromise) return cursorModelsPromise;
  cursorModelsPromise = fetchCursorModels();
  try {
    cursorModelsCache = await cursorModelsPromise;
    return cursorModelsCache;
  } finally {
    cursorModelsPromise = null;
  }
}

async function fetchCursorModels(): Promise<CursorModelInfo[]> {
  const apiKey = cursorApiKey();
  if (!apiKey) {
    return [{ id: "composer-2.5", displayName: "composer-2.5" }];
  }
  try {
    const models = await Cursor.models.list({ apiKey });
    return models.map((m) => ({
      id: m.id,
      displayName: m.displayName || m.id,
    }));
  } catch (err) {
    logger.warn("cursor", "models.list failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [{ id: "composer-2.5", displayName: "composer-2.5" }];
  }
}

export async function createOrResumeCursorAgent(opts: {
  userId: string;
  model: string;
  existingAgentId?: string | null;
}): Promise<{ agent: SDKAgent; agentId: string; resumed: boolean }> {
  const apiKey = cursorApiKey();
  if (!apiKey) {
    throw new Error("CURSOR_API_KEY is not set");
  }
  const cwd = resolveCursorCwd(opts.userId);
  const model = { id: opts.model };

  if (opts.existingAgentId) {
    try {
      const agent = await Agent.resume(opts.existingAgentId, {
        apiKey,
        model,
        local: { cwd },
      });
      return { agent, agentId: agent.agentId, resumed: true };
    } catch (err) {
      logger.warn("cursor", "Agent.resume failed; creating new agent", {
        agentId: opts.existingAgentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const agent = await Agent.create({
    apiKey,
    model,
    local: { cwd },
  });
  return { agent, agentId: agent.agentId, resumed: false };
}

/**
 * Extract incremental text from stream events and invoke handlers.
 * Assistant/thinking payloads may be cumulative; we emit only new suffixes.
 */
export function extractStreamDeltas(
  event: SDKMessage,
  state: { assistantText: string; thinkingText: string },
  handlers: CursorStreamHandlers,
): void {
  if (event.type === "assistant") {
    const text = (event.message.content ?? [])
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text.startsWith(state.assistantText)) {
      const delta = text.slice(state.assistantText.length);
      if (delta) handlers.onDelta(delta);
      state.assistantText = text;
    } else if (text && text !== state.assistantText) {
      handlers.onDelta(text);
      state.assistantText += text;
    }
    return;
  }
  if (event.type === "thinking") {
    const text = event.text ?? "";
    if (!handlers.onReasoning) return;
    if (text.startsWith(state.thinkingText)) {
      const delta = text.slice(state.thinkingText.length);
      if (delta) handlers.onReasoning(delta);
      state.thinkingText = text;
    } else if (text && text !== state.thinkingText) {
      handlers.onReasoning(text);
      state.thinkingText += text;
    }
    return;
  }
  if (event.type === "status" && event.message && handlers.onStatus) {
    handlers.onStatus(event.message);
  }
}

/**
 * Send a prompt to a Cursor agent, stream events, wait for completion, dispose.
 * Returns final assistant text and the agent id to persist on the thread.
 */
export async function runCursorChat(opts: {
  userId: string;
  model: string;
  prompt: string;
  existingAgentId?: string | null;
  handlers: CursorStreamHandlers;
}): Promise<{ assistantContent: string; agentId: string }> {
  const { agent, agentId } = await createOrResumeCursorAgent({
    userId: opts.userId,
    model: opts.model,
    existingAgentId: opts.existingAgentId,
  });

  const state = { assistantText: "", thinkingText: "" };
  try {
    const run = await agent.send(opts.prompt);
    for await (const event of run.stream()) {
      extractStreamDeltas(event, state, opts.handlers);
    }
    const result = await run.wait();
    if (result.status === "error") {
      throw new Error(`Cursor run failed (${result.id})`);
    }
    return { assistantContent: state.assistantText, agentId };
  } finally {
    try {
      await agent[Symbol.asyncDispose]();
    } catch {
      try {
        agent.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Build a single prompt string from chat history + latest user message. */
export function buildCursorPrompt(opts: {
  systemContent?: string | null;
  history: Array<{ role: string; content: string }>;
  userContent: string;
}): string {
  const parts: string[] = [];
  if (opts.systemContent?.trim()) {
    parts.push(`System instructions:\n${opts.systemContent.trim()}`);
  }
  // Keep recent history for first-turn context when creating a new agent;
  // resume path still benefits from an explicit latest user message.
  const recent = opts.history.slice(-12);
  for (const m of recent) {
    if (m.role === "user") parts.push(`User:\n${m.content}`);
    else if (m.role === "assistant") parts.push(`Assistant:\n${m.content}`);
  }
  parts.push(`User:\n${opts.userContent}`);
  return parts.join("\n\n");
}

/** Fallback cwd under data/ when workspace helpers are unavailable (tests). */
export function defaultCursorDataCwd(): string {
  return join(getDataDir(), "workspace");
}
