import { availableModels, defaultModel, getModelDisplayNames } from "@/lib/llm";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/models — 利用可能なモデル一覧を返す。
 *
 * - Umansモード: `/v1/models/info` 由来のモデル一覧と displayNames を返す。
 * - OAI互換モード: LLM_MODELS env（カンマ区切り）から構築。displayNames は空。
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const models = await availableModels();
  const current = defaultModel();
  const displayNames = await getModelDisplayNames();
  return Response.json({ models, default: current, displayNames });
}
