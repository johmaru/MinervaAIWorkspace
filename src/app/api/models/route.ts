import { availableModels, defaultModel, getModelDisplayNames } from "@/lib/llm";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/models — Returns the list of available models.
 *
 * - Umans mode: Returns the model list and displayNames from `/v1/models/info`.
 * - OAI-compatible mode: Built from LLM_MODELS env (comma-separated). displayNames is empty.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const models = await availableModels();
  const current = defaultModel();
  const displayNames = await getModelDisplayNames();
  return Response.json({ models, default: current, displayNames });
}
