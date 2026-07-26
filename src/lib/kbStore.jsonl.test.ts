// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db } from "@/db";
import { knowledgeBases, kbDocuments, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  createKnowledgeBase,
  ingestJsonlFile,
  searchKnowledgeBases,
  buildKnowledgeContextMessage,
} from "./kbStore";

vi.mock("@/lib/embed", () => ({
  // Fixed non-zero vector so query and stored chunks share high cosine similarity.
  embedText: vi.fn(async () => Array.from({ length: 8 }, (_, i) => 0.1 + i * 0.01)),
  embedTexts: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 8 }, (_, i) => 0.1 + i * 0.01)),
  ),
  hashContent: (s: string) => `hash:${s.length}:${s.slice(0, 24)}`,
}));

const USER = "jsonl-test-user";
const prevHost = process.env.WORKSPACE_HOST_PATH;
let wsRoot: string;
let kbId: string;

describe("ingestJsonlFile", () => {
  beforeAll(async () => {
    delete process.env.WORKSPACE_HOST_PATH;
    await db
      .insert(users)
      .values({ id: USER, nickname: "jsonl", email: "jsonl@example.com" })
      .onConflictDoNothing();
    const kb = await createKnowledgeBase(USER, "jsonl-test-kb");
    kbId = kb.id;
    const { getWorkspaceRoot } = await import("@/lib/workspace");
    wsRoot = getWorkspaceRoot(USER);
    mkdirSync(join(wsRoot, "rag"), { recursive: true });
    writeFileSync(
      join(wsRoot, "rag", "chars.jsonl"),
      [
        JSON.stringify({ name: "小美山愛", character_id: "char-ai", content: "私、サンバです。はまってます。" }),
        JSON.stringify({ title: "井川葵", content: "今日のレッスン、集中できた。" }),
        JSON.stringify({ name: "empty", content: "   " }),
        "{not-json",
      ].join("\n"),
      "utf8",
    );
  });

  afterAll(async () => {
    if (prevHost === undefined) delete process.env.WORKSPACE_HOST_PATH;
    else process.env.WORKSPACE_HOST_PATH = prevHost;
    await db.delete(knowledgeBases).where(eq(knowledgeBases.id, kbId));
    try {
      rmSync(wsRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("ingests one document per valid JSONL line", async () => {
    const result = await ingestJsonlFile(kbId, "rag/chars.jsonl", USER);
    expect(result.ingested).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.titles).toEqual(expect.arrayContaining(["小美山愛", "井川葵"]));

    const docs = await db
      .select({ title: kbDocuments.title })
      .from(kbDocuments)
      .where(eq(kbDocuments.knowledgeBaseId, kbId));
    expect(docs.map((d) => d.title).sort()).toEqual(["井川葵", "小美山愛"].sort());

    const { listKnowledgeBases } = await import("./kbStore");
    const listed = await listKnowledgeBases(USER);
    const row = listed.find((k) => k.id === kbId);
    expect(row?.documentCount).toBe(2);
  });

  it("rejects paths outside workspace", async () => {
    await expect(ingestJsonlFile(kbId, "../etc/passwd", USER)).rejects.toThrow(/outside the workspace/i);
  });

  it("searchKnowledgeBases returns hits (IN clause must be parenthesized)", async () => {
    // Ensure data exists even if previous test order changes
    await ingestJsonlFile(kbId, "rag/chars.jsonl", USER);

    // Single-id IN (?) — previously generated bare IN ? → SQLite "near ?": syntax error
    const hits = await searchKnowledgeBases("はまってる サンバ", [kbId], USER, 5, 0.1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toMatch(/愛|葵/);
    expect(hits[0]!.text.length).toBeGreaterThan(0);
    expect(hits[0]!.similarity).toBeGreaterThan(0.1);

    // Multi-id IN (?, ?) path
    const hitsMulti = await searchKnowledgeBases("はまってる", [kbId, "nonexistent-kb-id"], USER, 5, 0.1);
    expect(hitsMulti.length).toBeGreaterThan(0);

    // Speaker re-rank: question about 愛 should prefer 小美山愛 title over others when present
    const byAi = await searchKnowledgeBases("愛がはまってるって言ってた物は何？", [kbId], USER, 5, 0.1);
    expect(byAi.length).toBeGreaterThan(0);
    expect(byAi[0]!.title).toMatch(/小美山愛/);

    // Ownership: other user sees nothing
    const none = await searchKnowledgeBases("はまってる", [kbId], "other-user", 5, 0.1);
    expect(none).toEqual([]);

    const ctx = await buildKnowledgeContextMessage("愛がはまってる", [kbId], USER);
    expect(ctx).not.toBeNull();
    expect(ctx!.role).toBe("system");
    expect(ctx!.content).toMatch(/speaker|小美山|はまって|サンバ/i);
  });
});
