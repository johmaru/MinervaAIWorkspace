import type OpenAI from "openai";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { memories, threads } from "@/db/schema";
import { embedText, hashContent } from "@/lib/embed";

/**
 * 記憶システム — アシスタント応答完了後に会話を要約・分類して保存。
 *
 * フロー:
 * 1. generateMemories: 直近ターンを LLM に渡し fact/working で分類 + new/replace/merge を判定。
 * 2. findRelevantMemories (memoryStore.ts): 次回送信時に pgvector 検索 → LLM rerank → recency top-5。
 * 3. chat route が system context に注入。
 *
 * replace/merge で古い記憶は suppressedAt で論理削除（物理削除しない）。
 */

export type MemoryKind = "fact" | "working";

export type ExtractedMemory = {
  kind: MemoryKind;
  content: string;
  importance?: number;
  action: "new" | "replace" | "merge";
  /** replace/merge 時、既存記憶の content（類似検索で特定用） */
  targetContent?: string;
};

const SYSTEM_PROMPT = `You are a memory extractor. Analyze the conversation and extract durable memories.

Classify each memory as:
- "fact": unchanging user info, environment, preferences, identity, goals
- "working": current task, temporary context, recent decisions that may change

For each memory, decide an action:
- "new": no similar existing memory exists
- "replace": supersedes an existing memory that is now outdated or wrong
- "merge": combines with an existing memory to form a richer one

When action is "replace" or "merge", set targetContent to the EXACT content string of the existing memory you are replacing or merging with.

Write each memory's content as a concise, search-friendly sentence (not a full transcript). Prefer facts over chatter. Skip trivial pleasantries.

If there is nothing worth remembering, return an empty array.

Return ONLY valid JSON (no markdown fences):
[{"kind": "fact"|"working", "content": "...", "importance": 0.0-1.0, "action": "new"|"replace"|"merge", "targetContent": "... (only for replace/merge)"}]`;

/**
 * generateMemories で LLM に送る messages を構築。
 * 直近ターン + 既存アクティブ記憶リストを提示。
 */
function buildExtractionMessages(
  recentTurns: { role: string; content: string }[],
  existingMemories: { id: string; content: string }[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const conversation = recentTurns
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");

  const existingList =
    existingMemories.length > 0
      ? existingMemories
          .map((m, i) => `${i}: ${m.content}`)
          .join("\n")
      : "(none)";

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Recent conversation:\n${conversation}\n\nExisting active memories:\n${existingList}\n\nExtract memories as JSON array.`,
    },
  ];
}

/**
 * LLM の生レスポンスから ExtractedMemory 配列をパース。
 * 不正な場合は null を返し、呼び出し元でスキップ。
 */
function parseExtraction(raw: string | null | undefined): ExtractedMemory[] | null {
  if (!raw || !raw.trim()) return null;
  // markdown コードフェンスを除去
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((m): m is ExtractedMemory => {
        if (typeof m !== "object" || m === null) return false;
        const kind = (m as ExtractedMemory).kind;
        const action = (m as ExtractedMemory).action;
        const content = (m as ExtractedMemory).content;
        if (kind !== "fact" && kind !== "working") return false;
        if (action !== "new" && action !== "replace" && action !== "merge") return false;
        if (typeof content !== "string" || !content.trim()) return false;
        return true;
      })
      .map((m) => ({
        kind: m.kind,
        content: m.content.trim(),
        importance: typeof m.importance === "number" ? m.importance : 0.5,
        action: m.action,
        targetContent: m.targetContent,
      }));
  } catch {
    return null;
  }
}

/**
 * targetContent で既存アクティブ記憶を検索。
 * 完全一致で最も古い1件を返す。見つからなければ null。
 */
async function findExistingMemory(
  threadId: string,
  targetContent: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.threadId, threadId),
        eq(memories.content, targetContent),
        isNull(memories.suppressedAt),
      ),
    )
    .orderBy(asc(memories.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * 既存記憶の content を LLM で再統合。
 * mergeContents は LLM 呼び出し1回で統合テキストを返す。
 */
async function mergeContents(
  existing: string,
  incoming: string,
  llm: OpenAI,
  model: string,
): Promise<string> {
  const completion = await llm.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "Merge two memories into one concise, search-friendly sentence. Preserve all key facts. Return only the merged sentence, no explanation.",
      },
      {
        role: "user",
        content: `Existing: ${existing}\nNew: ${incoming}\nMerged:`,
      },
    ],
  });
  const merged = completion.choices[0]?.message?.content?.trim();
  return merged || incoming;
}

/**
 * 直近ターンから記憶を抽出し memories テーブルに保存。
 *
 * - LLM が JSON を返さない → スキップ（console.error のみ）
 * - targetContent で既存記憶が見つからない → new にフォールバック
 * - embed が空配列（モデルロード中など）→ 記憶保存スキップ
 * - replace/merge で複数ヒット → 最も古い1件を対象
 *
 * @param threadId 対象スレッド
 * @param recentTurns 直近の会話（user + assistant ペア）
 * @param llm LLM クライアント（テスト注入可）
 * @param model LLM モデル id
 */
export async function generateMemories(
  threadId: string,
  recentTurns: { role: string; content: string }[],
  llm: OpenAI,
  model: string,
): Promise<void> {
  // user/assistant ペアが無い場合は早期リターン
  const hasUser = recentTurns.some((t) => t.role === "user");
  const hasAssistant = recentTurns.some((t) => t.role === "assistant");
  if (!hasUser || !hasAssistant || recentTurns.length === 0) return;

  // threads から folderId を取得
  const [thread] = await db
    .select({ folderId: threads.folderId })
    .from(threads)
    .where(eq(threads.id, threadId));
  const folderId = thread?.folderId ?? null;

  // 既存アクティブ記憶を取得（LLM へ提示用）
  const existing = await db
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(and(eq(memories.threadId, threadId), isNull(memories.suppressedAt)))
    .orderBy(asc(memories.createdAt));

  // LLM で記憶抽出
  let extracted: ExtractedMemory[] | null;
  try {
    const completion = await llm.chat.completions.create({
      model,
      messages: buildExtractionMessages(recentTurns, existing),
    });
    extracted = parseExtraction(completion.choices[0]?.message?.content);
  } catch (err) {
    console.error("[memory] LLM extraction failed:", err);
    return;
  }

  if (!extracted || extracted.length === 0) return;

  const embedModel = process.env.EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";

  for (const mem of extracted) {
    try {
      if (mem.action === "replace" && mem.targetContent) {
        const target = await findExistingMemory(threadId, mem.targetContent);
        if (target) {
          await db
            .update(memories)
            .set({ suppressedAt: new Date(), updatedAt: new Date() })
            .where(eq(memories.id, target.id));
        }
        // targetContent が見つからなくても新記憶として保存（フォールバック）
      } else if (mem.action === "merge" && mem.targetContent) {
        const target = await findExistingMemory(threadId, mem.targetContent);
        if (target) {
          const existingContent =
            existing.find((m) => m.id === target.id)?.content ?? mem.targetContent;
          const mergedContent = await mergeContents(existingContent, mem.content, llm, model);
          const vector = await embedText(mergedContent, "document");
          if (vector.length === 0) continue; // embed 失敗 → スキップ
          await db
            .update(memories)
            .set({
              content: mergedContent,
              embedding: vector,
              contentHash: hashContent(mergedContent),
              importance: mem.importance ?? 0.5,
              updatedAt: new Date(),
            })
            .where(eq(memories.id, target.id));
          continue; // merge 完了、新規 INSERT しない
        }
        // targetContent が見つからない → new にフォールバック
      }

      // action === "new" または フォールバック
      const vector = await embedText(mem.content, "document");
      if (vector.length === 0) continue; // embed 失敗 → スキップ

      const contentHash = hashContent(mem.content);
      // contentHash で重複回避（既存ならスキップ）
      const [dup] = await db
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.threadId, threadId),
            eq(memories.contentHash, contentHash),
            isNull(memories.suppressedAt),
          ),
        )
        .limit(1);
      if (dup) continue;

      await db.insert(memories).values({
        threadId,
        folderId,
        kind: mem.kind,
        content: mem.content,
        embedding: vector,
        contentHash,
        model: embedModel,
        importance: mem.importance ?? 0.5,
      });
    } catch (err) {
      console.error("[memory] failed to save memory:", mem.content, err);
    }
  }
}

