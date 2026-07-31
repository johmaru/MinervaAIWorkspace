import {
  availableModels,
  defaultModel,
  getModelDisplayNames,
  getProviderModels,
  llmProvider,
} from "@/lib/llm";
import { listCursorModels } from "@/lib/cursorLlm";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/models — Returns the list of available models for the active provider.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const provider = llmProvider();
  const models = await availableModels();
  const current = defaultModel();
  const displayNames = await getModelDisplayNames();
  const reasoningLevels: Record<string, string[]> = {};

  if (provider === "cursor") {
    const cursorModels = await listCursorModels();
    for (const m of cursorModels) reasoningLevels[m.id] = [];
  } else {
    const providerModels = await getProviderModels();
    for (const m of providerModels) reasoningLevels[m.id] = m.reasoning.levels;
  }

  return Response.json({
    models,
    default: current,
    displayNames,
    reasoningLevels,
    provider,
  });
}
