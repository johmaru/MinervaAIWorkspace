// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/db";
import { knowledgeBases, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  buildCharacterDialogueJsonl,
  buildAndIngestCharacterDialogueRag,
} from "./characterDialogueRag";

vi.mock("@/lib/embed", () => ({
  embedText: vi.fn(async () => Array.from({ length: 8 }, (_, i) => i * 0.01)),
  embedTexts: vi.fn(async (texts: string[]) =>
    texts.map((_, ti) => Array.from({ length: 8 }, (__, i) => (ti + 1) * 0.01 + i * 0.001)),
  ),
  hashContent: (s: string) => `hash:${s.length}:${s.slice(0, 32)}`,
}));

const USER = "char-dialogue-rag-user";
const prevHost = process.env.WORKSPACE_HOST_PATH;
let wsRoot: string;
const createdKbIds: string[] = [];

describe("characterDialogueRag", () => {
  beforeAll(async () => {
    delete process.env.WORKSPACE_HOST_PATH;
    await db
      .insert(users)
      .values({ id: USER, nickname: "cdr", email: "cdr@example.com" })
      .onConflictDoNothing();
    const { getWorkspaceRoot } = await import("@/lib/workspace");
    wsRoot = getWorkspaceRoot(USER);
    mkdirSync(join(wsRoot, "ipr-master-diff"), { recursive: true });

    writeFileSync(
      join(wsRoot, "ipr-master-diff", "Character.json"),
      JSON.stringify([
        {
          id: "char-ai",
          name: "小美山愛",
          enName: "AI KOMIYAMA",
          cv: "寿美菜子",
          profile: "アイドル",
        },
        { id: "char-aoi", name: "井川葵", profile: "リーダー" },
      ]),
      "utf8",
    );
    writeFileSync(
      join(wsRoot, "ipr-master-diff", "Message.json"),
      JSON.stringify([
        {
          id: "message-1",
          name: "湯けむり",
          characterId: "char-ai",
          details: [
            { characterId: "char-ai", text: "私、サンバにはまってるんです" },
            { characterId: "", text: "そうなのか？" },
            { characterId: "char-ai", text: "はい！" },
          ],
        },
      ]),
      "utf8",
    );
    writeFileSync(
      join(wsRoot, "ipr-master-diff", "HomeTalk.json"),
      JSON.stringify([
        {
          homeTalkId: "ht-1",
          characterId: "char-ai",
          title: "ホーム",
          managerText: "どうした？",
          characterTalks: [{ text: "最近ハマってることがあって" }],
        },
      ]),
      "utf8",
    );
  });

  afterAll(async () => {
    if (prevHost === undefined) delete process.env.WORKSPACE_HOST_PATH;
    else process.env.WORKSPACE_HOST_PATH = prevHost;
    for (const id of createdKbIds) {
      await db.delete(knowledgeBases).where(eq(knowledgeBases.id, id));
    }
    try {
      rmSync(wsRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("buildCharacterDialogueJsonl writes one line per character with dialogue", async () => {
    const result = await buildCharacterDialogueJsonl(USER, {
      characterPath: "ipr-master-diff/Character.json",
      messagePath: "ipr-master-diff/Message.json",
      homeTalkPath: "ipr-master-diff/HomeTalk.json",
      outputPath: "rag/character_dialogue.jsonl",
    });
    expect(result.lineCount).toBe(2);
    expect(result.charactersWithDialogue).toBe(1);
    expect(result.charactersProfileOnly).toBe(1);

    const raw = readFileSync(join(wsRoot, "rag", "character_dialogue.jsonl"), "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as { name: string; content: string });
    const ai = lines.find((l) => l.name === "小美山愛");
    expect(ai?.content).toContain("サンバにはまってる");
    expect(ai?.content).toContain("最近ハマってることがあって");
    expect(ai?.content).not.toContain("そうなのか？"); // player choice skipped
  });

  it("buildAndIngestCharacterDialogueRag creates KB and ingests", async () => {
    // Skip verify_query here: searchKnowledgeBases needs real embedding dims / sqlite-vec.
    const result = await buildAndIngestCharacterDialogueRag(USER, {
      kbName: "test-char-rag",
      outputPath: "rag/character_dialogue2.jsonl",
    });
    createdKbIds.push(result.kbId);
    expect(result.kbId).toBeTruthy();
    expect(result.ingest.ingested).toBeGreaterThanOrEqual(1);
    expect(result.build.lineCount).toBe(2);
    expect(result.verify).toBeUndefined();
  });
});
