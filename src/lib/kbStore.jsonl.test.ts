// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db } from "@/db";
import { knowledgeBases, kbDocuments, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createKnowledgeBase, ingestJsonlFile } from "./kbStore";

vi.mock("@/lib/embed", () => ({
  embedText: vi.fn(async () => Array.from({ length: 8 }, (_, i) => i * 0.01)),
  embedTexts: vi.fn(async (texts: string[]) =>
    texts.map((_, ti) => Array.from({ length: 8 }, (__, i) => (ti + 1) * 0.01 + i * 0.001)),
  ),
  hashContent: (s: string) => `hash:${s.length}:${s.slice(0, 24)}`,
}));

const USER = "test-user-id";
const prevHost = process.env.WORKSPACE_HOST_PATH;
let wsRoot: string;
let kbId: string;

describe("ingestJsonlFile", () => {
  beforeAll(async () => {
    delete process.env.WORKSPACE_HOST_PATH;
    await db.insert(users).values({ id: USER, nickname: "t", email: "t@example.com" }).onConflictDoNothing();
    const kb = await createKnowledgeBase(USER, "jsonl-test-kb");
    kbId = kb.id;
    // Isolate workspace under tmp via getUserDataRoot mock? workspace uses getUserDataRoot when HOST unset.
    // Ensure files under the user's workspace path.
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
  });

  it("rejects paths outside workspace", async () => {
    await expect(ingestJsonlFile(kbId, "../etc/passwd", USER)).rejects.toThrow(/outside the workspace/i);
  });
});
