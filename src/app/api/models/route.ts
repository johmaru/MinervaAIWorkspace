import { availableModels, defaultModel } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/models — 利用可能なモデル一覧を返す。
 * LLM_MODELS env（カンマ区切り）から構築。未設定時は defaultModel() のみ。
 */
export async function GET() {
  const models = availableModels();
  const current = defaultModel();
  return Response.json({ models, default: current });
}
