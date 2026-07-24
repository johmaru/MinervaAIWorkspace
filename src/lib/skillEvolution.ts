import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type OpenAI from "openai";
import { db } from "@/db";
import { skills, skillUsageEvents, skillEvolutionProposals, messages, threads } from "@/db/schema";
import { createLLM, defaultModel } from "@/lib/llm";
import { hashContent, embedText } from "@/lib/embed";
import { logger } from "@/lib/logger";

export const EVOLUTION_DEFAULTS = {
  minNetFailures: 3,
  minSamples: 5,
  maxFailureRate: 0.5,
  maxAbsCharsChanged: 500,
  maxFracChanged: 0.35,
  maxOpenDraftsPerSkill: 1,
  /** 提案生成クールダウン（proposals.createdAt 基準） */
  cooldownMs: 60 * 60 * 1000,
  /** force evolve 最短間隔 */
  forceMinIntervalMs: 5 * 60 * 1000,
  maxEvidenceEvents: 8,
  /** 1 evidence の user+assistant 合計上限のベース */
  maxSnippetChars: 2000,
  /** プロンプト全体の evidence セクション上限 */
  maxEvidencePromptChars: 6000,
} as const;

/** env ヘルパー */
export function isSkillEvolutionEnabled(): boolean {
  // 未設定 or 空 → true。明示 "false" / "0" のみオフ
  const v = process.env.SKILL_EVOLUTION_ENABLED?.trim().toLowerCase();
  return v !== "false" && v !== "0";
}

export function isSkillEvolutionAutoPropose(): boolean {
  // 既定 false（dogfood 後に true）。明示 "true" / "1" のみオン
  const v = process.env.SKILL_EVOLUTION_AUTO_PROPOSE?.trim().toLowerCase();
  return v === "true" || v === "1";
}

export function skillEvolutionModel(): string {
  return process.env.SKILL_EVOLUTION_MODEL?.trim() || defaultModel();
}

/**
 * 閾値は lifetime counters ではなく「進化ウィンドウ」内の event 集計。
 * windowStart = skill.lastEvolutionAt ?? skill.createdAt
 */
export function shouldProposeEvolution(stats: {
  windowSuccess: number;
  windowFailure: number;
  hasOpenDraft: boolean;
  cooldownActive: boolean;
}): boolean {
  if (stats.hasOpenDraft || stats.cooldownActive) return false;
  const s = stats.windowSuccess;
  const f = stats.windowFailure;
  const samples = s + f;
  const net = f - s;
  if (net >= EVOLUTION_DEFAULTS.minNetFailures) return true;
  if (samples >= EVOLUTION_DEFAULTS.minSamples && f / samples >= EVOLUTION_DEFAULTS.maxFailureRate) {
    return true;
  }
  return false;
}

/**
 * 唯一の差分メトリクス（Issue 11）:
 *   lcp = longest common prefix length (code units)
 *   lcs = longest common suffix length (code units), not overlapping lcp
 *   absChanged = |len(next)-len(prev)| + (len(prev) - lcp - lcs)
 *   fracChanged = absChanged / max(len(prev), 1)
 * cap: absChanged <= max(maxAbsCharsChanged, floor(len(prev) * maxFracChanged))
 */
export function measureContentDelta(previous: string, next: string) {
  const prev = previous;
  const nxt = next;
  let lcp = 0;
  const minLen = Math.min(prev.length, nxt.length);
  while (lcp < minLen && prev[lcp] === nxt[lcp]) lcp++;
  let lcs = 0;
  while (
    lcs < prev.length - lcp &&
    lcs < nxt.length - lcp &&
    prev[prev.length - 1 - lcs] === nxt[nxt.length - 1 - lcs]
  ) {
    lcs++;
  }
  const absChanged =
    Math.abs(nxt.length - prev.length) + (prev.length - lcp - lcs);
  const fracChanged = absChanged / Math.max(prev.length, 1);
  return { absChanged, fracChanged, lcp, lcs };
}

export function isBoundedEdit(
  previous: string,
  next: string,
  opts = EVOLUTION_DEFAULTS,
): boolean {
  if (!next.trim()) return false;
  const { absChanged } = measureContentDelta(previous, next);
  const cap = Math.max(
    opts.maxAbsCharsChanged,
    Math.floor(previous.length * opts.maxFracChanged),
  );
  return absChanged <= cap;
}

export type EvidenceItem = {
  usageEventId: string;
  outcome: string;
  similarity: number | null;
  activationType: string;
  /** 無ければ meta-only */
  userSnippet?: string;
  assistantSnippet?: string;
};

/**
 * Load evidence snippets for not_helpful events.
 * Prioritizes not_helpful, fetches user+assistant content via messageId,
 * truncates to maxSnippetChars/2 each.
 */
export async function loadEvidenceSnippets(
  events: Array<{ id: string; messageId: string | null; similarity: number | null; activationType: string; outcome: string }>,
  userId: string,
): Promise<EvidenceItem[]> {
  const items: EvidenceItem[] = [];
  let totalChars = 0;

  for (const ev of events.slice(0, EVOLUTION_DEFAULTS.maxEvidenceEvents)) {
    const item: EvidenceItem = {
      usageEventId: ev.id,
      outcome: ev.outcome,
      similarity: ev.similarity,
      activationType: ev.activationType,
    };

    if (ev.messageId) {
      try {
        // Fetch assistant message, verifying ownership via thread
        const [assistantMsg] = await db
          .select({ id: messages.id, content: messages.content, parentId: messages.parentId, threadId: messages.threadId })
          .from(messages)
          .where(eq(messages.id, ev.messageId))
          .limit(1);

        if (assistantMsg) {
          // Verify thread ownership
          const [thread] = await db
            .select({ id: threads.id, userId: threads.userId })
            .from(threads)
            .where(eq(threads.id, assistantMsg.threadId))
            .limit(1);

          if (thread && thread.userId === userId) {
            const half = Math.floor(EVOLUTION_DEFAULTS.maxSnippetChars / 2);
            item.assistantSnippet = assistantMsg.content.slice(0, half);

            // Fetch parent user message
            if (assistantMsg.parentId) {
              const [userMsg] = await db
                .select({ content: messages.content })
                .from(messages)
                .where(eq(messages.id, assistantMsg.parentId))
                .limit(1);
              if (userMsg) {
                item.userSnippet = userMsg.content.slice(0, half);
              }
            }
          }
        }
      } catch {
        // Message missing or cross-user → meta only
      }
    }

    const itemChars = (item.userSnippet?.length ?? 0) + (item.assistantSnippet?.length ?? 0);
    if (totalChars + itemChars > EVOLUTION_DEFAULTS.maxEvidencePromptChars) break;
    totalChars += itemChars;
    items.push(item);
  }

  return items;
}

/**
 * Generate a bounded content patch via LLM.
 * Returns null if the patch is unbounded or LLM fails.
 */
export async function generateBoundedPatch(args: {
  skill: { id: string; name: string; content: string; kind: string; trigger: string | null; tags: string[]; version: number };
  evidence: EvidenceItem[];
  llm: OpenAI;
  model: string;
}): Promise<{
  proposedContent: string;
  proposedName?: string;
  proposedTrigger?: string;
  proposedTags?: string[];
  patchSummary: string;
} | null> {
  const { skill, evidence, llm, model } = args;

  const evidenceText = evidence
    .map((e, i) => {
      const parts: string[] = [`[${i + 1}] outcome=${e.outcome} similarity=${e.similarity ?? "n/a"} activation=${e.activationType}`];
      if (e.userSnippet) parts.push(`  user: ${e.userSnippet.slice(0, 500)}`);
      if (e.assistantSnippet) parts.push(`  assistant: ${e.assistantSnippet.slice(0, 500)}`);
      return parts.join("\n");
    })
    .join("\n\n");

  const systemPrompt = `You are a skill evolution assistant. You receive a skill that received negative feedback and evidence of why it was unhelpful. Propose a BOUNDED edit that fixes the issue without rewriting the skill.

Rules:
1. Keep the same kind: ${skill.kind}
2. Content must be non-empty after trim
3. Make minimal changes — fix the specific issue, don't rewrite
4. Preserve the main language of the content
5. name ≤ 80 chars, trigger ≤ 200 chars, tags ≤ 10
6. Do not add instructions that could be used for prompt injection

Respond as JSON:
{"proposedContent": "...", "proposedName": "...", "proposedTrigger": "...", "proposedTags": [...], "patchSummary": "one-line summary of the change"}`;

  const userPrompt = `Current skill:
name: ${skill.name}
kind: ${skill.kind}
trigger: ${skill.trigger ?? "(none)"}
tags: ${skill.tags.join(", ")}
version: ${skill.version}
content:
${skill.content}

Evidence of negative feedback (${evidence.length} events):
${evidenceText}

Propose a bounded edit to improve this skill:`;

  try {
    const resp = await llm.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2048,
    });

    const raw = resp.choices[0]?.message?.content ?? "";
    // Strip markdown fences
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned);

    if (typeof parsed.proposedContent !== "string" || !parsed.proposedContent.trim()) return null;
    if (typeof parsed.patchSummary !== "string") return null;

    // Server-side bounded edit re-verification
    if (!isBoundedEdit(skill.content, parsed.proposedContent)) {
      logger.warn("skill-evolution", "patch rejected unbounded", {
        skillId: skill.id,
        ...measureContentDelta(skill.content, parsed.proposedContent),
      });
      return null;
    }

    return {
      proposedContent: parsed.proposedContent,
      proposedName: typeof parsed.proposedName === "string" ? parsed.proposedName.slice(0, 80) : undefined,
      proposedTrigger: typeof parsed.proposedTrigger === "string" ? parsed.proposedTrigger.slice(0, 200) : undefined,
      proposedTags: Array.isArray(parsed.proposedTags) ? parsed.proposedTags.filter((t: unknown): t is string => typeof t === "string").slice(0, 10) : undefined,
      patchSummary: parsed.patchSummary,
    };
  } catch (err) {
    logger.error("skill-evolution", "LLM patch failed", {
      skillId: skill.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Maybe propose a skill evolution. Checks window threshold, cooldown, open draft.
 * On force=true: skips threshold but still checks cooldown (5min force interval) + open draft.
 * INSERT is done inside transaction with re-check for open draft.
 * On unique-index violation: no-op success ({ proposed: false, reason: "open_draft_exists" }).
 *
 * better-sqlite3 is a sync driver: transaction callback must be sync.
 * LLM call is OUTSIDE the transaction to avoid long locks.
 */
export async function maybeProposeSkillEvolution(args: {
  skillId: string;
  userId: string;
  force?: boolean;
}): Promise<{ proposed: boolean; proposalId?: string; reason?: string }> {
  const { skillId, userId, force } = args;

  // Load skill
  const [skill] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, skillId), eq(skills.userId, userId)))
    .limit(1);

  if (!skill) return { proposed: false, reason: "skill_not_found" };
  if (skill.status === "archived") return { proposed: false, reason: "skill_archived" };

  // Check open draft (pre-filter)
  const [existingDraft] = await db
    .select({ id: skillEvolutionProposals.id })
    .from(skillEvolutionProposals)
    .where(
      and(
        eq(skillEvolutionProposals.userId, userId),
        eq(skillEvolutionProposals.skillId, skillId),
        eq(skillEvolutionProposals.status, "draft"),
      ),
    )
    .limit(1);

  if (existingDraft) {
    return { proposed: false, reason: "open_draft_exists", proposalId: existingDraft.id };
  }

  // Cooldown check: any proposal created within cooldownMs
  const cooldownCutoff = new Date(Date.now() - EVOLUTION_DEFAULTS.cooldownMs);
  const [recentProposal] = await db
    .select({ id: skillEvolutionProposals.id })
    .from(skillEvolutionProposals)
    .where(
      and(
        eq(skillEvolutionProposals.userId, userId),
        eq(skillEvolutionProposals.skillId, skillId),
        gt(skillEvolutionProposals.createdAt, cooldownCutoff),
      ),
    )
    .limit(1);

  if (recentProposal && !force) {
    return { proposed: false, reason: "cooldown_active" };
  }

  // Force rate limit (5min)
  if (force) {
    const forceCutoff = new Date(Date.now() - EVOLUTION_DEFAULTS.forceMinIntervalMs);
    const [forceRecent] = await db
      .select({ id: skillEvolutionProposals.id })
      .from(skillEvolutionProposals)
      .where(
        and(
          eq(skillEvolutionProposals.userId, userId),
          eq(skillEvolutionProposals.skillId, skillId),
          gt(skillEvolutionProposals.createdAt, forceCutoff),
        ),
      )
      .limit(1);

    if (forceRecent) {
      return { proposed: false, reason: "force_rate_limited" };
    }
  }

  // Window threshold (skip on force)
  if (!force) {
    const windowStart = skill.lastEvolutionAt ?? skill.createdAt;
    const windowEvents = await db
      .select({ outcome: skillUsageEvents.outcome })
      .from(skillUsageEvents)
      .where(
        and(
          eq(skillUsageEvents.skillId, skillId),
          eq(skillUsageEvents.userId, userId),
          gt(skillUsageEvents.createdAt, windowStart),
          inArray(skillUsageEvents.outcome, ["helpful", "not_helpful"]),
        ),
      );

    const windowSuccess = windowEvents.filter((e) => e.outcome === "helpful").length;
    const windowFailure = windowEvents.filter((e) => e.outcome === "not_helpful").length;

    if (!shouldProposeEvolution({ windowSuccess, windowFailure, hasOpenDraft: false, cooldownActive: false })) {
      return { proposed: false, reason: "threshold_not_met" };
    }
  }

  // Load evidence snippets (not_helpful events in window)
  const windowStart = skill.lastEvolutionAt ?? skill.createdAt;
  const evidenceEvents = await db
    .select({
      id: skillUsageEvents.id,
      messageId: skillUsageEvents.messageId,
      similarity: skillUsageEvents.similarity,
      activationType: skillUsageEvents.activationType,
      outcome: skillUsageEvents.outcome,
    })
    .from(skillUsageEvents)
    .where(
      and(
        eq(skillUsageEvents.skillId, skillId),
        eq(skillUsageEvents.userId, userId),
        eq(skillUsageEvents.outcome, "not_helpful"),
        gt(skillUsageEvents.createdAt, windowStart),
      ),
    )
    .limit(EVOLUTION_DEFAULTS.maxEvidenceEvents);

  const evidence = await loadEvidenceSnippets(evidenceEvents, userId);

  // LLM call (outside transaction)
  const llm = createLLM();
  const model = skillEvolutionModel();
  const patch = await generateBoundedPatch({
    skill: {
      id: skill.id,
      name: skill.name,
      content: skill.content,
      kind: skill.kind,
      trigger: skill.trigger,
      tags: skill.tags,
      version: skill.version,
    },
    evidence,
    llm,
    model,
  });

  if (!patch) {
    return { proposed: false, reason: "patch_generation_failed" };
  }

  // ContentHash dedup: check against other active skills
  const newHash = hashContent(patch.proposedContent);
  if (newHash === skill.contentHash) {
    return { proposed: false, reason: "same_content_hash" };
  }

  const [hashConflict] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.userId, userId),
        eq(skills.status, "active"),
        eq(skills.contentHash, newHash),
      ),
    )
    .limit(1);

  if (hashConflict) {
    return { proposed: false, reason: "content_hash_conflict" };
  }

  // INSERT inside transaction with re-check for open draft
  try {
    const result = db.transaction((tx) => {
      // Re-check open draft inside tx
      const [openDraft] = tx
        .select({ id: skillEvolutionProposals.id })
        .from(skillEvolutionProposals)
        .where(
          and(
            eq(skillEvolutionProposals.userId, userId),
            eq(skillEvolutionProposals.skillId, skillId),
            eq(skillEvolutionProposals.status, "draft"),
          ),
        )
        .limit(1)
        .all();

      if (openDraft) {
        return { proposed: false as const, reason: "open_draft_exists", proposalId: openDraft.id };
      }

      const [row] = tx
        .insert(skillEvolutionProposals)
        .values({
          userId,
          skillId,
          baseVersion: skill.version,
          previousContent: skill.content,
          proposedContent: patch.proposedContent,
          proposedName: patch.proposedName,
          proposedTrigger: patch.proposedTrigger,
          proposedTags: patch.proposedTags,
          patchSummary: patch.patchSummary,
          evidenceEventIds: evidenceEvents.map((e) => e.id),
          contentHash: newHash,
          status: "draft",
        })
        .returning({ id: skillEvolutionProposals.id })
        .all();

      return { proposed: true as const, proposalId: row.id };
    });

    if (result.proposed) {
      logger.info("skill-evolution", "proposal created", {
        proposalId: result.proposalId,
        skillId,
        baseVersion: skill.version,
        ...measureContentDelta(skill.content, patch.proposedContent),
      });
    }

    return result;
  } catch (err) {
    // Unique index violation → no-op success
    if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
      return { proposed: false, reason: "open_draft_exists" };
    }
    logger.error("skill-evolution", "proposal insert failed", {
      skillId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { proposed: false, reason: "insert_failed" };
  }
}

/**
 * Apply an evolution proposal: update skill content + version bump + re-embed.
 * On version conflict: mark proposal as conflict, return error.
 * On archived skill: return error (feedback allowed, apply not).
 *
 * better-sqlite3 is a sync driver: transaction callback must be sync.
 */
export async function applyEvolutionProposal(args: {
  proposalId: string;
  userId: string;
  overrides?: { proposedContent?: string; proposedName?: string; proposedTrigger?: string; proposedTags?: string[] };
}): Promise<{ skillId: string; version: number } | { error: string; status: number }> {
  const { proposalId, userId, overrides } = args;

  // Pre-read proposal for override computation (LLM embed is outside tx)
  const [proposal] = await db
    .select()
    .from(skillEvolutionProposals)
    .where(
      and(
        eq(skillEvolutionProposals.id, proposalId),
        eq(skillEvolutionProposals.userId, userId),
      ),
    )
    .limit(1);

  if (!proposal) return { error: "Not found", status: 404 };

  const [skill] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, proposal.skillId), eq(skills.userId, userId)))
    .limit(1);

  if (!skill) return { error: "skill_not_found", status: 404 };
  if (skill.status === "archived") return { error: "skill_archived", status: 409 };

  const effectiveContent = (overrides?.proposedContent ?? proposal.proposedContent).trim();
  const effectiveName = overrides?.proposedName ?? proposal.proposedName ?? skill.name;
  const effectiveTrigger = overrides?.proposedTrigger ?? proposal.proposedTrigger ?? skill.trigger ?? "";
  const effectiveTags = overrides?.proposedTags ?? proposal.proposedTags ?? skill.tags;

  // Server-side bounded edit re-verification
  if (!isBoundedEdit(skill.content, effectiveContent)) {
    return { error: "unbounded_edit", status: 400 };
  }

  // Re-embed (same source as PATCH route) — outside transaction
  const embedSource = [effectiveName, effectiveTrigger, effectiveTags.join(", "), effectiveContent]
    .filter(Boolean)
    .join("\n");
  const vector = await embedText(embedSource, "document");
  if (vector.length === 0) {
    return { error: "embedding_failed", status: 503 };
  }

  const newHash = hashContent(effectiveContent);
  const newVersion = skill.version + 1;

  // Transaction: re-check status + version inside tx, then update atomically
  const result = db.transaction((tx) => {
    // Re-read proposal inside tx to prevent TOCTOU race
    const [currentProposal] = tx
      .select({ status: skillEvolutionProposals.status })
      .from(skillEvolutionProposals)
      .where(eq(skillEvolutionProposals.id, proposalId))
      .limit(1)
      .all();

    if (!currentProposal) return { error: "Not found" as const, status: 404 };
    if (currentProposal.status !== "draft") return { error: "proposal_not_draft" as const, status: 409 };

    // Re-read skill version inside tx to detect concurrent version bump
    const [currentSkill] = tx
      .select({ version: skills.version, status: skills.status })
      .from(skills)
      .where(and(eq(skills.id, proposal.skillId), eq(skills.userId, userId)))
      .limit(1)
      .all();

    if (!currentSkill) return { error: "skill_not_found" as const, status: 404 };
    if (currentSkill.status === "archived") return { error: "skill_archived" as const, status: 409 };
    if (currentSkill.version !== proposal.baseVersion) {
      // Mark as conflict
      tx.update(skillEvolutionProposals)
        .set({ status: "conflict", updatedAt: new Date() })
        .where(eq(skillEvolutionProposals.id, proposalId))
        .run();
      return { error: "version_conflict" as const, status: 409 };
    }

    tx.update(skills)
      .set({
        content: effectiveContent,
        name: effectiveName,
        trigger: effectiveTrigger,
        tags: effectiveTags,
        embedding: vector,
        contentHash: newHash,
        version: newVersion,
        lastEvolutionAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(skills.id, proposal.skillId), eq(skills.userId, userId)))
      .run();

    tx.update(skillEvolutionProposals)
      .set({
        status: "approved",
        appliedVersion: newVersion,
        proposedContent: effectiveContent,
        proposedName: effectiveName,
        proposedTrigger: effectiveTrigger,
        proposedTags: effectiveTags,
        contentHash: newHash,
        updatedAt: new Date(),
      })
      .where(eq(skillEvolutionProposals.id, proposalId))
      .run();

    // Supersede other drafts for this skill
    tx.update(skillEvolutionProposals)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(
        and(
          eq(skillEvolutionProposals.userId, userId),
          eq(skillEvolutionProposals.skillId, proposal.skillId),
          eq(skillEvolutionProposals.status, "draft"),
        ),
      )
      .run();

    return { skillId: proposal.skillId, version: newVersion };
  });

  if ("error" in result) {
    logger.info("skill-evolution", "proposal approve rejected", {
      proposalId,
      error: result.error,
    });
    return result;
  }

  logger.info("skill-evolution", "proposal approved", {
    proposalId,
    skillId: result.skillId,
    appliedVersion: result.version,
  });

  return result;
}
