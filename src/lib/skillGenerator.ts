import type OpenAI from "openai";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, skills, threads } from "@/db/schema";
import { embedText, hashContent } from "@/lib/embed";

/**
 * スキル生成 — 会話全体を LLM で要約し、再利用可能なスキルとして保存。
 *
 * ユーザーが「今までの内容スキルで保存して」等と要求した際に chat route の
 * after() で実行される。会話の全メッセージを LLM に渡し、
 * { name, content } の JSON を抽出 → embedding → contentHash で重複回避 → INSERT。
 *
 * memories が直近ターン単位で抽出されるのに対し、
 * skills は会話全体からの要約。1会話 → 1スキル。
 */

const SYSTEM_PROMPT = `You are a skill extractor. Analyze the conversation and extract a concrete reusable skill.

Only extract:
- Concrete reusable procedures (step-by-step workflows)
- Debugging patterns (how a specific bug was diagnosed and fixed)
- Project rules (conventions, gotchas, must-do rules for this codebase)
- Tool usage patterns (how to use a specific tool/API correctly)
- Implementation patterns (reusable code patterns or architectural decisions)

Do NOT extract:
- User preferences, personal info, or identity
- General facts or broad advice
- Temporary context or one-off task details
- Generic programming knowledge found in any docs
- Persona or style instructions

If no concrete reusable skill exists in this conversation, return an empty array: []

Respond in JSON only. Return an array (empty if no skill applies):
[{"name": "short skill name (2-5 words)", "kind": "workflow|bugfix|project_rule|tool_usage|coding_pattern|debugging", "trigger": "when to apply this skill (natural language)", "tags": ["tag1", "tag2"], "content": "reusable instructions in second person (You should... / When X happens, do Y)"}]`;

type ExtractedSkill = {
  name: string;
  content: string;
  kind: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
  trigger: string;
  tags: string[];
};

/**
 * LLM の生レスポンスから ExtractedSkill をパース。
 * markdown コードフェンスを除去し JSON をパース。
 * 不正な場合は null を返し、呼び出し元でスキップ。
 */
export function parseSkillExtraction(raw: string | null | undefined): ExtractedSkill | null {
  if (!raw || !raw.trim()) return null;
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as unknown;
    // プロンプトは配列を要求するが、単一オブジェクトも許容（後方互換）
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      const name = obj.name;
      const content = obj.content;
      if (typeof name !== "string" || !name.trim()) continue;
      if (typeof content !== "string" || !content.trim()) continue;
      const kind = obj.kind;
      const trigger = obj.trigger;
      const tags = obj.tags;
      return {
        name: name.trim(),
        content: content.trim(),
        kind:
          kind === "workflow" || kind === "bugfix" || kind === "project_rule" ||
          kind === "tool_usage" || kind === "coding_pattern" || kind === "debugging"
            ? kind
            : "workflow",
        trigger: typeof trigger === "string" ? trigger.trim() : "",
        tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * スレッドの全メッセージからスキルを抽出し保存。
 *
 * 1. messages を時系列で取得
 * 2. LLM で { name, content } を抽出
 * 3. embedText(content, "document") でベクトル化
 * 4. contentHash で重複回避
 * 5. skills テーブルに挿入
 *
 * user/assistant メッセージが無い場合はスキップ。
 * embed 失敗・LLM 失敗・重複時はログのみで終了（エラーを投げない）。
 *
 * @param threadId 対象スレッド
 * @param userId スキル所有者
 * @param llm LLM クライアント
 * @param model LLM モデル名
 */
export async function generateSkillFromConversation(
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

  // LLM でスキル抽出
  let extracted: ExtractedSkill | null;
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
    extracted = parseSkillExtraction(completion.choices[0]?.message?.content);
  } catch (err) {
    console.error("[skill] LLM extraction failed:", err);
    return;
  }

  if (!extracted) {
    console.log("[skill] extraction returned no result, skipping");
    return;
  }

  // embedding 生成: name + trigger + tags + content の結合テキストから
  // 検索性を向上（trigger/tags がクエリと一致しやすくなる）
  const embedSource = [
    extracted.name,
    extracted.trigger,
    extracted.tags.join(", "),
    extracted.content,
  ]
    .filter(Boolean)
    .join("\n");
  const vector = await embedText(embedSource, "document");
  if (vector.length === 0) {
    console.log("[skill] embedding failed, skipping");
    return;
  }

  // contentHash で重複回避（content のみで判定）
  const contentHash = hashContent(extracted.content);
  const [dup] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.userId, userId), eq(skills.contentHash, contentHash)))
    .limit(1);
  if (dup) {
    console.log("[skill] duplicate skill (same contentHash), skipping");
    return;
  }

  await db.insert(skills).values({
    userId,
    name: extracted.name,
    content: extracted.content,
    embedding: vector,
    contentHash,
    kind: extracted.kind,
    trigger: extracted.trigger,
    tags: extracted.tags,
    sourceThreadId: threadId,
  });

  console.log(`[skill] generated from conversation: ${extracted.name}`);
}
