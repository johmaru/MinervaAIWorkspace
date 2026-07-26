/**
 * Server-side builder for per-character dialogue RAG JSONL.
 *
 * Emits one document per conversation unit (message thread / home talk) plus
 * one profile doc per character — better retrieval than one giant blob per char.
 *
 * Dialogue lines are attributed by detail.characterId / homeTalk.characterId so
 * lines spoken in another character's thread still land on the correct speaker.
 */

import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  resolveWorkspacePath,
  writeWorkspaceFile,
} from "@/lib/workspace";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  ingestJsonlFile,
  listKnowledgeBases,
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
  homeTalkId?: string;
  characterId?: string;
  title?: string;
  managerText?: string;
  choiceText?: string;
  characterTalks?: Array<{ text?: string }>;
};

type MessageRow = {
  id?: string;
  characterId?: string;
  name?: string;
  details?: Array<{
    messageDetailId?: string;
    characterId?: string;
    text?: string;
    nextMessageDetailIds?: string[];
  }>;
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
  return s.replace(/\r\n/g, "\n").trim();
}

function detailSortKey(id: string | undefined): number {
  if (!id) return 0;
  const n = Number(id);
  return Number.isFinite(n) ? n : 0;
}

/** Parse tool args that may be a comma-separated string or string[]. */
export function parseFilterList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => String(v).trim())
      .filter((s) => s.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[,、\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Match a character against id/name filters.
 * Name needles match full name, substring (愛 → 小美山愛), or case-insensitive en.
 */
export function characterMatchesFilter(
  c: { id?: string; name?: string },
  characterIds: string[],
  characterNames: string[],
): boolean {
  if (characterIds.length === 0 && characterNames.length === 0) return true;
  if (c.id) {
    const id = c.id.trim();
    if (characterIds.some((x) => x === id || x.toLowerCase() === id.toLowerCase())) {
      return true;
    }
  }
  if (c.name && characterNames.length > 0) {
    const name = c.name.trim();
    const nameLower = name.toLowerCase();
    for (const needle of characterNames) {
      const n = needle.trim();
      if (!n) continue;
      const nl = n.toLowerCase();
      if (name === n || nameLower === nl) return true;
      if (name.includes(n) || n.includes(name)) return true;
      if (nameLower.includes(nl)) return true;
    }
  }
  return false;
}

function safeLabelFromFilter(ids: string[], names: string[]): string {
  const raw = [...names, ...ids].join("-") || "filtered";
  return raw
    .replace(/[^\w一-龯ぁ-んァ-ヶー-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "filtered";
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
  messageDocs: number;
  homeTalkDocs: number;
  profileDocs: number;
  totalBytes: number;
  sampleNames: string[];
};

type JsonlDoc = {
  character_id: string;
  name: string;
  title: string;
  content: string;
  kind: "profile" | "message" | "home_talk";
};

/**
 * Build JSONL: profile doc + one doc per message thread + one per home talk.
 * Paths are workspace-relative.
 *
 * Optional characterIds / characterNames limit output to matching speakers only
 * (e.g. Ai-only KB: characterNames=["小美山愛"] or characterIds=["char-ai"]).
 */
export async function buildCharacterDialogueJsonl(
  userId: string,
  args: {
    characterPath: string;
    messagePath: string;
    homeTalkPath: string;
    outputPath: string;
    characterIds?: string[];
    characterNames?: string[];
  },
): Promise<BuildCharacterDialogueJsonlResult> {
  const charAbs = resolveWorkspacePath(args.characterPath, userId);
  const msgAbs = resolveWorkspacePath(args.messagePath, userId);
  const homeAbs = resolveWorkspacePath(args.homeTalkPath, userId);
  const outAbs = resolveWorkspacePath(args.outputPath, userId);

  const allCharacters = readJsonArray(charAbs, "Character.json") as CharRow[];
  const messages = readJsonArray(msgAbs, "Message.json") as MessageRow[];
  const homeTalks = readJsonArray(homeAbs, "HomeTalk.json") as HomeTalkRow[];

  const characterIds = args.characterIds ?? [];
  const characterNames = args.characterNames ?? [];
  const hasFilter = characterIds.length > 0 || characterNames.length > 0;
  const characters = hasFilter
    ? allCharacters.filter((c) => characterMatchesFilter(c, characterIds, characterNames))
    : allCharacters;
  if (hasFilter && characters.length === 0) {
    throw new Error(
      `No characters matched filter ids=[${characterIds.join(",")}] names=[${characterNames.join(",")}]. ` +
        `Use Character.json ids (e.g. char-ai) or names (e.g. 小美山愛 / 愛).`,
    );
  }

  const charName = new Map<string, string>();
  for (const c of allCharacters) {
    if (c.id) charName.set(c.id, c.name?.trim() || c.id);
  }
  const allowedIds = hasFilter
    ? new Set(characters.map((c) => c.id).filter((id): id is string => Boolean(id)))
    : null;

  // Speakers in messages: group by detail.characterId (not only message owner)
  // so lines spoken in another character's thread still attach to the speaker.
  type MsgBucket = {
    messageId: string;
    messageName: string;
    ownerId: string;
    lines: string[];
  };
  const msgDocsByChar = new Map<string, MsgBucket[]>();

  for (const m of messages) {
    const ownerId = m.characterId ?? "";
    const mname = m.name?.trim() || "(メッセージ)";
    const mid = m.id || mname;
    const details = [...(m.details ?? [])].sort(
      (a, b) => detailSortKey(a.messageDetailId) - detailSortKey(b.messageDetailId),
    );

    // Collect lines per speaking character within this message
    const bySpeaker = new Map<string, string[]>();
    for (const d of details) {
      const speaker = (d.characterId || "").trim();
      if (!speaker) continue; // skip pure player choices
      const txt = cleanText(d.text ?? "");
      if (!txt) continue;
      const list = bySpeaker.get(speaker) ?? [];
      list.push(txt);
      bySpeaker.set(speaker, list);
    }

    for (const [speaker, lines] of bySpeaker) {
      if (lines.length === 0) continue;
      if (allowedIds && !allowedIds.has(speaker)) continue;
      const bucket: MsgBucket = {
        messageId: mid,
        messageName: mname,
        ownerId,
        lines,
      };
      const arr = msgDocsByChar.get(speaker) ?? [];
      arr.push(bucket);
      msgDocsByChar.set(speaker, arr);
    }
  }

  const homeByChar = new Map<string, HomeTalkRow[]>();
  for (const ht of homeTalks) {
    const cid = ht.characterId;
    if (!cid) continue;
    if (allowedIds && !allowedIds.has(cid)) continue;
    const list = homeByChar.get(cid) ?? [];
    list.push(ht);
    homeByChar.set(cid, list);
  }

  const docs: JsonlDoc[] = [];
  let withDialogue = 0;
  let profileOnly = 0;
  let messageDocs = 0;
  let homeTalkDocs = 0;
  let profileDocs = 0;
  const sampleNames: string[] = [];

  for (const c of characters) {
    const cid = c.id;
    if (!cid) continue;
    const name = c.name?.trim() || cid;
    if (sampleNames.length < 8) sampleNames.push(name);

    const profile = buildProfileBlock(c);
    docs.push({
      character_id: cid,
      name,
      title: `${name} | プロフィール`,
      content: `【キャラクター】${name}（${cid}）\n\n【プロフィール】\n${profile}`,
      kind: "profile",
    });
    profileDocs++;

    const msgBuckets = msgDocsByChar.get(cid) ?? [];
    const homeList = homeByChar.get(cid) ?? [];
    if (msgBuckets.length + homeList.length > 0) withDialogue++;
    else profileOnly++;

    for (const mb of msgBuckets) {
      const header =
        `【キャラクター】${name}（${cid}）\n` +
        `【種別】メッセージ\n` +
        `【タイトル】${mb.messageName}\n` +
        (mb.ownerId && mb.ownerId !== cid
          ? `【スレッド所有者】${charName.get(mb.ownerId) || mb.ownerId}\n`
          : "") +
        `\n【セリフ】\n`;
      const body = mb.lines.map((l) => `${name}: ${l}`).join("\n");
      docs.push({
        character_id: cid,
        name,
        title: `${name} | メッセージ | ${mb.messageName}`,
        content: header + body,
        kind: "message",
      });
      messageDocs++;
    }

    for (const ht of homeList) {
      const title = ht.title?.trim() || "(ホーム会話)";
      const segs: string[] = [];
      if (ht.managerText?.trim()) {
        segs.push(`マネージャー: ${cleanText(ht.managerText)}`);
      }
      if (ht.choiceText?.trim() && ht.choiceText !== ht.managerText) {
        segs.push(`選択肢: ${cleanText(ht.choiceText)}`);
      }
      for (const t of ht.characterTalks ?? []) {
        const txt = cleanText(t.text ?? "");
        if (txt) segs.push(`${name}: ${txt}`);
      }
      if (segs.length === 0) continue;
      const header =
        `【キャラクター】${name}（${cid}）\n` +
        `【種別】ホーム会話\n` +
        `【タイトル】${title}\n\n【セリフ】\n`;
      docs.push({
        character_id: cid,
        name,
        title: `${name} | ホーム会話 | ${title}`,
        content: header + segs.join("\n"),
        kind: "home_talk",
      });
      homeTalkDocs++;
    }
  }

  mkdirSync(dirname(outAbs), { recursive: true });
  const body =
    docs.map((d) => JSON.stringify(d)).join("\n") + (docs.length ? "\n" : "");
  await writeWorkspaceFile(args.outputPath, body, userId);

  return {
    outputPath: args.outputPath,
    lineCount: docs.length,
    charactersWithDialogue: withDialogue,
    charactersProfileOnly: profileOnly,
    messageDocs,
    homeTalkDocs,
    profileDocs,
    totalBytes: Buffer.byteLength(body, "utf8"),
    sampleNames,
  };
}

export type BuildAndIngestCharacterDialogueResult = {
  build: BuildCharacterDialogueJsonlResult;
  kbId: string;
  kbName: string;
  ingest: JsonlIngestResult;
  deletedSameNameKbIds: string[];
  filter?: { characterIds: string[]; characterNames: string[]; sourceJsonlPath?: string };
  verify?: { query: string; results: KbSearchResult[] };
};

/**
 * Filter an existing character-dialogue JSONL by character id/name.
 * Streaming-friendly (line by line) — use instead of read_file on multi-MB JSONL.
 */
export async function filterCharacterDialogueJsonl(
  userId: string,
  args: {
    sourcePath: string;
    outputPath: string;
    characterIds?: string[];
    characterNames?: string[];
  },
): Promise<BuildCharacterDialogueJsonlResult> {
  const characterIds = args.characterIds ?? [];
  const characterNames = args.characterNames ?? [];
  if (characterIds.length === 0 && characterNames.length === 0) {
    throw new Error("filterCharacterDialogueJsonl requires characterIds and/or characterNames");
  }

  const abs = resolveWorkspacePath(args.sourcePath, userId);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`JSONL not found: ${args.sourcePath}`);
  }

  const kept: JsonlDoc[] = [];
  let profileDocs = 0;
  let messageDocs = 0;
  let homeTalkDocs = 0;
  const sampleNames: string[] = [];
  const seenNames = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const cid = typeof obj.character_id === "string" ? obj.character_id : "";
    const name = typeof obj.name === "string" ? obj.name : "";
    if (!characterMatchesFilter({ id: cid, name }, characterIds, characterNames)) continue;

    const content =
      (typeof obj.content === "string" && obj.content) ||
      (typeof obj.text === "string" && obj.text) ||
      "";
    if (!content.trim()) continue;
    const title =
      (typeof obj.title === "string" && obj.title) ||
      `${name || cid || "doc"}`;
    const kindRaw = typeof obj.kind === "string" ? obj.kind : "message";
    const kind: JsonlDoc["kind"] =
      kindRaw === "profile" || kindRaw === "home_talk" || kindRaw === "message"
        ? kindRaw
        : "message";

    kept.push({
      character_id: cid || "unknown",
      name: name || cid || "unknown",
      title,
      content,
      kind,
    });
    if (kind === "profile") profileDocs++;
    else if (kind === "home_talk") homeTalkDocs++;
    else messageDocs++;
    if (name && !seenNames.has(name) && sampleNames.length < 8) {
      seenNames.add(name);
      sampleNames.push(name);
    }
  }

  if (kept.length === 0) {
    throw new Error(
      `No JSONL lines matched filter ids=[${characterIds.join(",")}] names=[${characterNames.join(",")}] ` +
        `in ${args.sourcePath}`,
    );
  }

  const body = kept.map((d) => JSON.stringify(d)).join("\n") + "\n";
  await writeWorkspaceFile(args.outputPath, body, userId);

  return {
    outputPath: args.outputPath,
    lineCount: kept.length,
    charactersWithDialogue: sampleNames.length,
    charactersProfileOnly: 0,
    messageDocs,
    homeTalkDocs,
    profileDocs,
    totalBytes: Buffer.byteLength(body, "utf8"),
    sampleNames,
  };
}

/**
 * One-shot: JSONL build + create KB + bulk ingest + optional verify search.
 * Deletes existing KBs with the same name for this user (keeps a single latest).
 *
 * Single-character (or few-character) KBs:
 * - characterIds: ["char-ai"] and/or characterNames: ["小美山愛","愛"]
 * - optional sourceJsonlPath: filter existing full JSONL (skip re-parsing master JSON)
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
    /** When true (default), remove prior KBs with the same name before create. */
    replaceExisting?: boolean;
    characterIds?: string[] | string;
    characterNames?: string[] | string;
    /**
     * If set, filter this workspace JSONL instead of rebuilding from Character/Message/HomeTalk.
     * Faster when full `rag/character_dialogue.jsonl` already exists.
     */
    sourceJsonlPath?: string;
    onProgress?: (done: number, total: number, phase: "parse" | "embed" | "write") => void;
  },
): Promise<BuildAndIngestCharacterDialogueResult> {
  const characterIds = parseFilterList(args.characterIds);
  const characterNames = parseFilterList(args.characterNames);
  const hasFilter = characterIds.length > 0 || characterNames.length > 0;
  const label = hasFilter ? safeLabelFromFilter(characterIds, characterNames) : "";

  const characterPath = args.characterPath?.trim() || "ipr-master-diff/Character.json";
  const messagePath = args.messagePath?.trim() || "ipr-master-diff/Message.json";
  const homeTalkPath = args.homeTalkPath?.trim() || "ipr-master-diff/HomeTalk.json";
  const outputPath =
    args.outputPath?.trim() ||
    (hasFilter ? `rag/character_dialogue_${label}.jsonl` : "rag/character_dialogue.jsonl");
  const kbName =
    args.kbName?.trim() ||
    (hasFilter ? `ipr-dialogue-${label}` : "ipr-character-dialogue");
  const replaceExisting = args.replaceExisting !== false;
  const sourceJsonlPath = args.sourceJsonlPath?.trim();

  let build: BuildCharacterDialogueJsonlResult;
  if (sourceJsonlPath) {
    if (!hasFilter) {
      throw new Error(
        "source_jsonl_path requires character_ids and/or character_names to filter",
      );
    }
    build = await filterCharacterDialogueJsonl(userId, {
      sourcePath: sourceJsonlPath,
      outputPath,
      characterIds,
      characterNames,
    });
  } else {
    build = await buildCharacterDialogueJsonl(userId, {
      characterPath,
      messagePath,
      homeTalkPath,
      outputPath,
      characterIds: hasFilter ? characterIds : undefined,
      characterNames: hasFilter ? characterNames : undefined,
    });
  }

  const deletedSameNameKbIds: string[] = [];
  if (replaceExisting) {
    const existing = await listKnowledgeBases(userId);
    for (const kb of existing) {
      if (kb.name === kbName) {
        const ok = await deleteKnowledgeBase(kb.id, userId);
        if (ok) deletedSameNameKbIds.push(kb.id);
      }
    }
  }

  const desc = hasFilter
    ? `Character dialogue RAG filtered to: ${[...characterNames, ...characterIds].join(", ")}`
    : "Character dialogue RAG (profile + message + home talk units from Message/HomeTalk)";

  const kb = await createKnowledgeBase(userId, kbName, desc);

  const ingest = await ingestJsonlFile(kb.id, outputPath, userId, {
    maxLines: 20_000,
    onProgress: args.onProgress,
  });

  let verify: BuildAndIngestCharacterDialogueResult["verify"];
  if (args.verifyQuery?.trim()) {
    const results = await searchKnowledgeBases(
      args.verifyQuery.trim(),
      [kb.id],
      userId,
      8,
      0.22,
    );
    verify = { query: args.verifyQuery.trim(), results };
  }

  return {
    build,
    kbId: kb.id,
    kbName,
    ingest,
    deletedSameNameKbIds,
    filter: hasFilter
      ? { characterIds, characterNames, sourceJsonlPath: sourceJsonlPath || undefined }
      : undefined,
    verify,
  };
}
