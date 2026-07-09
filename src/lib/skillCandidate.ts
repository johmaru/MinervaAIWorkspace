import type OpenAI from "openai";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, skillCandidates, threads } from "@/db/schema";
import { logger } from "@/lib/logger";

/**
 * Skill candidate extraction — automatically extracts reusable skill candidates from conversations.
 *
 * When the user explicitly says "save as skill", generateSkillFromConversation
 * creates the skill directly, but this module automatically extracts candidates
 * after every conversation and saves them as skills only after user approval
 * (approval-based learning loop).
 *
 * If the LLM does not recognize a concrete reusable skill, no candidate is created.
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
 * Parses ExtractedCandidate array from the LLM's raw response.
 * Removes markdown code fences and parses JSON.
 * Returns null on invalid input; the caller skips it.
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
 * Extracts skill candidates from a thread's conversation and saves them as drafts.
 *
 * 1. Verify userId from threads
 * 2. Get messages in chronological order
 * 3. Extract candidates via LLM (do nothing if [])
 * 4. Insert each candidate into the skill_candidates table as a draft
 *
 * Skips on LLM failure, empty array, or parse failure (does not throw).
 */
export async function extractSkillCandidates(
  threadId: string,
  userId: string,
  llm: OpenAI,
  model: string,
): Promise<void> {
  // Verify thread owner
  const [thread] = await db
    .select({ userId: threads.userId })
    .from(threads)
    .where(eq(threads.id, threadId));
  if (!thread || thread.userId !== userId) return;

  // Get all messages in chronological order
  const allMessages = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  const hasUser = allMessages.some((m) => m.role === "user");
  const hasAssistant = allMessages.some((m) => m.role === "assistant");
  if (!hasUser || !hasAssistant || allMessages.length === 0) return;

  // Extract candidates via LLM
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
    logger.error("skill-candidate", "LLM extraction failed", { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (!candidates || candidates.length === 0) return;

  // Insert each candidate as a draft
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
      logger.error("skill-candidate", "failed to insert candidate", { name: c.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  logger.info("skill-candidate", "extracted candidates", { count: candidates.length, threadId });
}
