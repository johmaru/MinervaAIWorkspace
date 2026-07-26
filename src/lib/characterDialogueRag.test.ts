// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/db";
import { knowledgeBases, users, kbDocuments } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  buildCharacterDialogueJsonl,
  buildAndIngestCharacterDialogueRag,
} from "./characterDialogueRag";
import { listKnowledgeBases } from "./kbStore";

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
            { messageDetailId: "1", characterId: "char-ai", text: "私、サンバにはまってるんです" },
            { messageDetailId: "2", characterId: "", text: "そうなのか？" },
            { messageDetailId: "3", characterId: "char-ai", text: "はい！" },
            // Spoken by aoi inside ai's thread — must go to aoi's docs
            { messageDetailId: "4", characterId: "char-aoi", text: "愛、それはいいね" },
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

  it("emits profile + message + home units with correct speaker attribution", async () => {
    const result = await buildCharacterDialogueJsonl(USER, {
      characterPath: "ipr-master-diff/Character.json",
      messagePath: "ipr-master-diff/Message.json",
      homeTalkPath: "ipr-master-diff/HomeTalk.json",
      outputPath: "rag/character_dialogue.jsonl",
    });
    // 2 profiles + 2 message docs (ai + aoi lines) + 1 home talk
    expect(result.profileDocs).toBe(2);
    expect(result.messageDocs).toBe(2);
    expect(result.homeTalkDocs).toBe(1);
    expect(result.lineCount).toBe(5);
    expect(result.charactersWithDialogue).toBe(2);

    const raw = readFileSync(join(wsRoot, "rag", "character_dialogue.jsonl"), "utf8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { title: string; name: string; content: string; character_id: string });

    const aiMsg = lines.find((l) => l.title.includes("メッセージ") && l.character_id === "char-ai");
    expect(aiMsg?.content).toContain("サンバにはまってる");
    expect(aiMsg?.content).not.toContain("そうなのか？");
    expect(aiMsg?.content).not.toContain("愛、それはいいね"); // aoi's line

    const aoiMsg = lines.find((l) => l.title.includes("メッセージ") && l.character_id === "char-aoi");
    expect(aoiMsg?.content).toContain("愛、それはいいね");
    expect(aoiMsg?.content).toContain("スレッド所有者");
  });

  it("buildAndIngest creates KB, replaces same name, and documentCount is accurate", async () => {
    const first = await buildAndIngestCharacterDialogueRag(USER, {
      kbName: "test-char-rag",
      outputPath: "rag/character_dialogue_a.jsonl",
    });
    createdKbIds.push(first.kbId);
    expect(first.ingest.ingested).toBe(5);

    const second = await buildAndIngestCharacterDialogueRag(USER, {
      kbName: "test-char-rag",
      outputPath: "rag/character_dialogue_b.jsonl",
    });
    createdKbIds.push(second.kbId);
    expect(second.deletedSameNameKbIds).toContain(first.kbId);

    const listed = await listKnowledgeBases(USER);
    const ragKbs = listed.filter((k) => k.name === "test-char-rag");
    expect(ragKbs).toHaveLength(1);
    expect(ragKbs[0]!.documentCount).toBe(5);

    const docs = await db
      .select({ title: kbDocuments.title })
      .from(kbDocuments)
      .where(eq(kbDocuments.knowledgeBaseId, second.kbId));
    expect(docs.length).toBe(5);
  });

  it("filters to a single character by name or id", async () => {
    const byName = await buildCharacterDialogueJsonl(USER, {
      characterPath: "ipr-master-diff/Character.json",
      messagePath: "ipr-master-diff/Message.json",
      homeTalkPath: "ipr-master-diff/HomeTalk.json",
      outputPath: "rag/ai_only.jsonl",
      characterNames: ["愛"],
    });
    expect(byName.profileDocs).toBe(1);
    expect(byName.sampleNames).toEqual(["小美山愛"]);
    // ai message + home; aoi lines excluded
    expect(byName.messageDocs).toBe(1);
    expect(byName.homeTalkDocs).toBe(1);
    expect(byName.lineCount).toBe(3);

    const raw = readFileSync(join(wsRoot, "rag", "ai_only.jsonl"), "utf8");
    for (const line of raw.trim().split("\n")) {
      const o = JSON.parse(line) as { character_id: string; name: string };
      expect(o.character_id).toBe("char-ai");
      expect(o.name).toBe("小美山愛");
    }

    const byId = await buildAndIngestCharacterDialogueRag(USER, {
      characterIds: "char-ai",
      kbName: "test-ai-only",
      outputPath: "rag/ai_only_ingest.jsonl",
      verifyQuery: "サンバ",
    });
    createdKbIds.push(byId.kbId);
    expect(byId.filter?.characterIds).toEqual(["char-ai"]);
    expect(byId.ingest.ingested).toBe(3);
    expect(byId.build.sampleNames).toEqual(["小美山愛"]);
    expect(byId.verify?.results.some((r) => r.title.includes("小美山愛"))).toBe(true);

    // Filter existing full JSONL without re-parse of master
    const full = await buildCharacterDialogueJsonl(USER, {
      characterPath: "ipr-master-diff/Character.json",
      messagePath: "ipr-master-diff/Message.json",
      homeTalkPath: "ipr-master-diff/HomeTalk.json",
      outputPath: "rag/full_for_filter.jsonl",
    });
    expect(full.lineCount).toBe(5);

    const filtered = await buildAndIngestCharacterDialogueRag(USER, {
      sourceJsonlPath: "rag/full_for_filter.jsonl",
      characterNames: ["小美山愛"],
      kbName: "test-ai-from-jsonl",
      outputPath: "rag/ai_from_full.jsonl",
    });
    createdKbIds.push(filtered.kbId);
    expect(filtered.ingest.ingested).toBe(3);
    expect(filtered.filter?.sourceJsonlPath).toBe("rag/full_for_filter.jsonl");
  });
});
