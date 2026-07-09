import type OpenAI from "openai";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, skills, threads } from "@/db/schema";
import { embedText, hashContent } from "@/lib/embed";
import { logger } from "@/lib/logger";

/**
 * Skill generation — summarizes the entire conversation via the LLM and saves it as a reusable skill.
 *
 * Executed in the after() of the chat route when the user requests something like
 * "save the content so far as a skill." All messages in the conversation are passed to the LLM,
 * { name, content } JSON is extracted → embedding → duplicate avoidance via contentHash → INSERT.
 *
 * While memories are extracted per recent turn, skills are summaries from the
 * entire conversation. 1 conversation → 1 skill.
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
 * Parses ExtractedSkill from the LLM's raw response.
 * Removes markdown code fences and parses JSON.
 * Returns null on invalid input; the caller skips it.
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
    // The prompt requests an array, but a single object is also accepted (backward compatibility)
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
 * Extracts a skill from all messages in the thread and saves it.
 *
 * 1. Get messages in chronological order
 * 2. Extract { name, content } via LLM
 * 3. Vectorize via embedText(content, "document")
 * 4. Avoid duplicates via contentHash
 * 5. Insert into the skills table
 *
 * Skips if there are no user/assistant messages.
 * On embed failure, LLM failure, or duplicate, logs only and exits (does not throw).
 *
 * @param threadId Target thread
 * @param userId Skill owner
 * @param llm LLM client
 * @param model LLM model name
 */
export async function generateSkillFromConversation(
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

  // Extract skill via LLM
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
    logger.error("skill", "LLM extraction failed", { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (!extracted) {
    logger.info("skill", "extraction returned no result, skipping");
    return;
  }

  // Generate embedding: from the combined text of name + trigger + tags + content
  // to improve searchability (trigger/tags match queries more easily)
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
    logger.warn("skill", "embedding failed, skipping");
    return;
  }

  // Avoid duplicates via contentHash (content only)
  const contentHash = hashContent(extracted.content);
  const [dup] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.userId, userId), eq(skills.contentHash, contentHash)))
    .limit(1);
  if (dup) {
    logger.info("skill", "duplicate skill (same contentHash), skipping");
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

  logger.info("skill", "generated from conversation", { name: extracted.name });
}
