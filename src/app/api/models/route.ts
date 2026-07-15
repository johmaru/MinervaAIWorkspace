import { availableModels, defaultModel, getModelDisplayNames, getUmansModels } from "@/lib/llm";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/models — Returns the list of available models.
 *
 * Returns the model list, displayNames, and reasoningLevels from `/v1/models/info`.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const models = await availableModels();
  const current = defaultModel();
  const displayNames = await getModelDisplayNames();
  const umansModels = await getUmansModels();
  const reasoningLevels: Record<string, string[]> = {};
  for (const m of umansModels) reasoningLevels[m.id] = m.reasoning.levels;
  return Response.json({ models, default: current, displayNames, reasoningLevels });
}
