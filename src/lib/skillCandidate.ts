import type OpenAI from "openai";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, skillCandidates, threads } from "@/db/schema";

/**
 * スキル候補抽出 — 会話から再利用可能なスキル候補を自動抽出。
 *
 * ユーザーが「スキルで保存」と明示した場合は generateSkillFromConversation
 * が直接スキルを作成するが、本モジュールは全会話後に自動で候補を抽出し、
 * ユーザーが承認してからスキル化する（approval-based learning loop）。
 *
 * LLM が concrete な reusable skill を認識しなかった場合は候補を作成しない。
 * Max 3 candidates per conversation.
 */

const SYSTEM_PROMPT = `You are a skill candidate extractor. Analyze the conversation and identify concrete reusable skills worth saving for future use.

Only extract:
- Concrete reusable procedures (step-by-step workflows)
- Debugging patterns (how a specific bug was diagnosed and fixed)
- Project rules (conventions, gotchas, must-do rules)
- Tool usage patterns (how to use a specific tool/API correctly)
- Implementation patterns (reusable code patterns or architectural decisions)

Do NOT extract:
- User preferences, personal info, or identity
- General facts or broad advice
- Temporary context or one-off task details
- Generic programming knowledge found in any docs
- Persona or style instructions

If no concrete reusable skill exists in this conversation, return an empty array: []

Maximum 3 candidates per conversation. Each candidate must be genuinely reusable across future conversations.

Respond in JSON only:
[{"name": "short skill name (2-5 words)", "kind": "workflow|bugfix|project_rule|tool_usage|coding_pattern|debugging", "trigger": "when to apply this skill (natural language)", "tags": ["tag1"], "content": "reusable instructions in second person (You should... / When X happens, do Y)", "confidence": 0.0-1.0, "reason": "why this skill is worth saving"}]`;

type ExtractedCandidate = {
  name: string;
  kind: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
  trigger: string;
  tags: string[];
  content: string;
  confidence: number;
  reason: string;
};

/**
 * LLM の生レスポンスから ExtractedCandidate 配列をパース。
 * markdown コードフェンスを除去し JSON をパース。
 * 不正な場合は null を返し、呼び出し元でスキップ。
 */
export function parseCandidates(raw: string | null | undefined): ExtractedCandidate[] | null {
  if (!raw || !raw.trim()) return null;
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (!Array.isArray(parsed)) return null;
    const validKinds = ["workflow", "bugfix", "project_rule", "tool_usage", "coding_pattern", "debugging"] as const;
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((obj) => {
        const name = obj.name;
        const content = obj.content;
        const kind = obj.kind;
        const trigger = obj.trigger;
        const tags = obj.tags;
        const confidence = obj.confidence;
        const reason = obj.reason;
        if (typeof name !== "string" || !name.trim()) return null;
        if (typeof content !== "string" || !content.trim()) return null;
        return {
          name: name.trim(),
          content: content.trim(),
          kind:
            typeof kind === "string" && (validKinds as readonly string[]).includes(kind)
              ? (kind as (typeof validKinds)[number])
              : "workflow",
          trigger: typeof trigger === "string" ? trigger.trim() : "",
          tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
          confidence: typeof confidence === "number" ? Math.max(0, Math.min(1, confidence)) : 0.5,
          reason: typeof reason === "string" ? reason.trim() : "",
        } satisfies ExtractedCandidate;
      })
      .filter((c): c is ExtractedCandidate => c !== null)
      .slice(0, 3);
  } catch {
    return null;
  }
}

/**
 * スレッドの会話からスキル候補を抽出し draft として保存。
 *
 * 1. threads から userId を検証
 * 2. messages を時系列で取得
 * 3. LLM で候補抽出（[] の場合は何もしない）
 * 4. 各候補を skill_candidates テーブルに draft として挿入
 *
 * LLM 失敗・空配列・パース失敗時はスキップ（エラーを投げない）。
 */
export async function extractSkillCandidates(
  threadId: string,
  userId: string,
  llm: OpenAI,
  model: string,
): Promise<void> {
  // スレッド所有者を検証
  const [thread] = await db
    .select({ userId: threads.userId })
    .from(threads)
    .where(eq(threads.id, threadId));
  if (!thread || thread.userId !== userId) return;

  // 会話の全メッセージを時系列で取得
  const allMessages = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  const hasUser = allMessages.some((m) => m.role === "user");
  const hasAssistant = allMessages.some((m) => m.role === "assistant");
  if (!hasUser || !hasAssistant || allMessages.length === 0) return;

  // LLM で候補抽出
  let candidates: ExtractedCandidate[] | null;
  try {
    const completion = await llm.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: allMessages
            .map((m) => `${m.role}: ${m.content}`)
            .join("\n"),
        },
      ],
    });
    candidates = parseCandidates(completion.choices[0]?.message?.content);
  } catch (err) {
    console.error("[skill-candidate] LLM extraction failed:", err);
    return;
  }

  if (!candidates || candidates.length === 0) return;

  // 各候補を draft として挿入
  for (const c of candidates) {
    try {
      await db.insert(skillCandidates).values({
        userId,
        threadId,
        proposedName: c.name,
        proposedKind: c.kind,
        proposedTrigger: c.trigger,
        proposedContent: c.content,
        proposedTags: c.tags,
        confidence: c.confidence,
        reason: c.reason,
        status: "draft",
      });
    } catch (err) {
      console.error("[skill-candidate] failed to insert candidate:", c.name, err);
    }
  }

  console.log(`[skill-candidate] extracted ${candidates.length} candidates from thread ${threadId}`);
}
