/**
 * Server-side builder for per-character dialogue RAG JSONL.
 *
 * Agents frequently fail when asked to invent large Python scripts inside
 * sandbox_run / thinking (stream cuts mid-plan). This module implements the
 * stable pipeline: Character + Message + HomeTalk → one JSONL line per character
 * → optional KB create + bulk ingest + verify search.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import {
  resolveWorkspacePath,
  writeWorkspaceFile,
} from "@/lib/workspace";
import {
  createKnowledgeBase,
  ingestJsonlFile,
  searchKnowledgeBases,
  type JsonlIngestResult,
  type KbSearchResult,
} from "@/lib/kbStore";

type CharRow = {
  id?: string;
  name?: string;
  enName?: string;
  cv?: string;
  age?: string;
  birthday?: string;
  height?: string;
  weight?: string;
  zodiacSign?: string;
  hometown?: string;
  favorite?: string;
  unfavorite?: string;
  profile?: string;
  catchphrase?: string;
  shortProfile?: string;
};

type HomeTalkRow = {
  characterId?: string;
  title?: string;
  managerText?: string;
  choiceText?: string;
  characterTalks?: Array<{ text?: string }>;
};

type MessageRow = {
  characterId?: string;
  name?: string;
  details?: Array<{ characterId?: string; text?: string }>;
};

function readJsonArray(absPath: string, label: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    throw new Error(`${label} not found at workspace path (resolved: ${absPath})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return data;
}

function cleanText(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\n+/g, " ").trim();
}

function buildProfileBlock(c: CharRow): string {
  const lines: string[] = [];
  if (c.name) lines.push(`名前: ${c.name}`);
  if (c.enName) lines.push(`英名: ${c.enName}`);
  if (c.cv) lines.push(`CV: ${c.cv}`);
  if (c.age) lines.push(`年齢: ${c.age}`);
  if (c.birthday) lines.push(`誕生日: ${c.birthday}`);
  if (c.height) lines.push(`身長: ${c.height}`);
  if (c.weight) lines.push(`体重: ${c.weight}`);
  if (c.zodiacSign) lines.push(`星座: ${c.zodiacSign}`);
  if (c.hometown) lines.push(`出身: ${c.hometown}`);
  if (c.favorite) lines.push(`好き: ${c.favorite}`);
  if (c.unfavorite) lines.push(`嫌い: ${c.unfavorite}`);
  if (c.catchphrase) lines.push(`キャッチフレーズ: ${c.catchphrase}`);
  if (c.shortProfile) lines.push(`概要: ${c.shortProfile}`);
  if (c.profile) lines.push(`プロフィール: ${c.profile}`);
  return lines.join("\n");
}

export type BuildCharacterDialogueJsonlResult = {
  outputPath: string;
  lineCount: number;
  charactersWithDialogue: number;
  charactersProfileOnly: number;
  totalBytes: number;
  sampleNames: string[];
};

/**
 * Build one JSONL line per character from game master-data style files.
 * Paths are workspace-relative.
 */
export async function buildCharacterDialogueJsonl(
  userId: string,
  args: {
    characterPath: string;
    messagePath: string;
    homeTalkPath: string;
    outputPath: string;
  },
): Promise<BuildCharacterDialogueJsonlResult> {
  const charAbs = resolveWorkspacePath(args.characterPath, userId);
  const msgAbs = resolveWorkspacePath(args.messagePath, userId);
  const homeAbs = resolveWorkspacePath(args.homeTalkPath, userId);
  const outAbs = resolveWorkspacePath(args.outputPath, userId);

  const characters = readJsonArray(charAbs, "Character.json") as CharRow[];
  const messages = readJsonArray(msgAbs, "Message.json") as MessageRow[];
  const homeTalks = readJsonArray(homeAbs, "HomeTalk.json") as HomeTalkRow[];

  const homeByChar = new Map<string, HomeTalkRow[]>();
  for (const ht of homeTalks) {
    const cid = ht.characterId;
    if (!cid) continue;
    const list = homeByChar.get(cid) ?? [];
    list.push(ht);
    homeByChar.set(cid, list);
  }

  const msgByChar = new Map<string, MessageRow[]>();
  for (const m of messages) {
    const cid = m.characterId;
    if (!cid) continue;
    const list = msgByChar.get(cid) ?? [];
    list.push(m);
    msgByChar.set(cid, list);
  }

  const linesOut: string[] = [];
  let withDialogue = 0;
  let profileOnly = 0;
  const sampleNames: string[] = [];

  for (const c of characters) {
    const cid = c.id;
    if (!cid) continue;
    const name = c.name?.trim() || cid;

    const profile = buildProfileBlock(c);
    const talkLines: string[] = [];
    for (const ht of homeByChar.get(cid) ?? []) {
      const title = ht.title?.trim() || "(ホーム会話)";
      const segs: string[] = [];
      if (ht.managerText?.trim()) segs.push(`[マネージャー] ${cleanText(ht.managerText)}`);
      if (ht.choiceText?.trim() && ht.choiceText !== ht.managerText) {
        segs.push(`[選択肢] ${cleanText(ht.choiceText)}`);
      }
      for (const t of ht.characterTalks ?? []) {
        const txt = cleanText(t.text ?? "");
        if (txt) segs.push(txt);
      }
      if (segs.length > 0) talkLines.push(`[${title}] ${segs.join(" / ")}`);
    }

    const msgLines: string[] = [];
    for (const m of msgByChar.get(cid) ?? []) {
      const mname = m.name?.trim() || "(メッセージ)";
      const segs: string[] = [];
      for (const d of m.details ?? []) {
        // Keep lines spoken by this character (skip pure player choices)
        if (d.characterId && d.characterId !== cid) continue;
        if (!d.characterId && !d.text) continue;
        // Player choice rows often have empty characterId — skip those
        if (!d.characterId) continue;
        const txt = cleanText(d.text ?? "");
        if (txt) segs.push(txt);
      }
      if (segs.length > 0) msgLines.push(`[${mname}] ${segs.join(" / ")}`);
    }

    const parts: string[] = [`【プロフィール】\n${profile}`];
    if (talkLines.length > 0) {
      parts.push(`【ホーム会話セリフ】\n${talkLines.join("\n")}`);
    }
    if (msgLines.length > 0) {
      parts.push(`【メッセージセリフ】\n${msgLines.join("\n")}`);
    }

    if (talkLines.length + msgLines.length > 0) withDialogue++;
    else profileOnly++;

    const content = parts.join("\n\n");
    linesOut.push(
      JSON.stringify({
        character_id: cid,
        name,
        content,
      }),
    );
    if (sampleNames.length < 8) sampleNames.push(name);
  }

  mkdirSync(dirname(outAbs), { recursive: true });
  const body = linesOut.join("\n") + (linesOut.length ? "\n" : "");
  await writeWorkspaceFile(args.outputPath, body, userId);

  return {
    outputPath: args.outputPath,
    lineCount: linesOut.length,
    charactersWithDialogue: withDialogue,
    charactersProfileOnly: profileOnly,
    totalBytes: Buffer.byteLength(body, "utf8"),
    sampleNames,
  };
}

export type BuildAndIngestCharacterDialogueResult = {
  build: BuildCharacterDialogueJsonlResult;
  kbId: string;
  kbName: string;
  ingest: JsonlIngestResult;
  verify?: { query: string; results: KbSearchResult[] };
};

/**
 * One-shot: JSONL build + create KB + bulk ingest + optional verify search.
 * Prefer this for agent reliability over multi-step sandbox Python plans.
 */
export async function buildAndIngestCharacterDialogueRag(
  userId: string,
  args: {
    characterPath?: string;
    messagePath?: string;
    homeTalkPath?: string;
    outputPath?: string;
    kbName?: string;
    verifyQuery?: string;
  },
): Promise<BuildAndIngestCharacterDialogueResult> {
  const characterPath = args.characterPath?.trim() || "ipr-master-diff/Character.json";
  const messagePath = args.messagePath?.trim() || "ipr-master-diff/Message.json";
  const homeTalkPath = args.homeTalkPath?.trim() || "ipr-master-diff/HomeTalk.json";
  const outputPath = args.outputPath?.trim() || "rag/character_dialogue.jsonl";
  const kbName = args.kbName?.trim() || "ipr-character-dialogue";

  const build = await buildCharacterDialogueJsonl(userId, {
    characterPath,
    messagePath,
    homeTalkPath,
    outputPath,
  });

  const kb = await createKnowledgeBase(
    userId,
    kbName,
    "Per-character dialogue from Message.json + HomeTalk.json (auto-built)",
  );

  const ingest = await ingestJsonlFile(kb.id, outputPath, userId, { maxLines: 500 });

  let verify: BuildAndIngestCharacterDialogueResult["verify"];
  if (args.verifyQuery?.trim()) {
    const results = await searchKnowledgeBases(
      args.verifyQuery.trim(),
      [kb.id],
      userId,
      5,
      0.25,
    );
    verify = { query: args.verifyQuery.trim(), results };
  }

  return { build, kbId: kb.id, kbName, ingest, verify };
}
