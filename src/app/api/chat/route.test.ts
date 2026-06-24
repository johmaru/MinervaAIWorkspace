// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { folders, threads } from "@/db/schema";
import { eq } from "drizzle-orm";

// searchWeb / upsertPage / decideSearch をモック: SearXNG/DB/LLM副作用なしで sources イベントを検証
vi.mock("@/lib/scraper", () => ({
  searchWeb: vi.fn(),
  scrapeUrl: vi.fn(),
  normalizeUrl: (u: string) => u,
  SourceInfo: {} as never,
}));
vi.mock("@/lib/pageStore", () => ({
  upsertPage: vi.fn().mockResolvedValue("mock-page-id"),
}));
vi.mock("@/lib/searchDecision", () => ({
  decideSearch: vi.fn(),
}));
vi.mock("@/lib/memoryStore", () => ({
  buildMemoryContext: vi.fn(),
}));
vi.mock("@/lib/memory", () => ({
  generateMemories: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/toolProbe", () => ({
  probeToolSupport: vi.fn().mockResolvedValue({ supported: false, checkedAt: new Date() }),
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    // after() はリクエストスコープ外で呼ばれるとエラーになるため、
    // テストでは no-op にする（generateMemories は別途モック済み）。
    after: () => {},
  };
});

import { searchWeb } from "@/lib/scraper";
import { decideSearch } from "@/lib/searchDecision";
import { buildMemoryContext } from "@/lib/memoryStore";
import { POST } from "@/app/api/chat/route";

// テスト間でモックの呼び出し履歴・戻り値をリセット（leak 防止）
beforeEach(() => {
  vi.mocked(searchWeb).mockReset();
  vi.mocked(decideSearch).mockReset();
  vi.mocked(buildMemoryContext).mockReset();
  // デフォルト: 検索不要（通常チャットのテストで実 LLM ルーターを呼ばない）
  vi.mocked(decideSearch).mockResolvedValue({
    needsSearch: false,
    reason: "default mock",
    userNotice: null,
    queries: [],
  });
  // デフォルト: 記憶なし（null = 注入しない）
  vi.mocked(buildMemoryContext).mockResolvedValue(null);
});

// Phase 2: /api/chat は DB 永続化 + 実 API ストリーミング。
// .env の LLM_BASE_URL / LLM_API_KEY / LLM_MODEL を使用（vitest.setup.ts で読み込み済み）。
// テストごとにスレッドを作成し、afterAll で掃除。

const hasCreds = Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);
const itReal = hasCreds ? it : it.skip;

const createdIds: string[] = [];
const createdFolderIds: string[] = [];

afterAll(async () => {
  for (const id of createdIds) {
    await db.delete(threads).where(eq(threads.id, id));
  }
  for (const id of createdFolderIds) {
    await db.delete(folders).where(eq(folders.id, id));
  }
});

async function createThread(): Promise<string> {
  const [row] = await db.insert(threads).values({ title: "chat route test" }).returning();
  createdIds.push(row.id);
  return row.id;
}

function chatReq(threadId: string, content: string, opts?: { systemPrompt?: string }): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify({ threadId, content, systemPrompt: opts?.systemPrompt }),
    headers: { "Content-Type": "application/json" },
  });
}

function sseChunks(res: Response): Promise<string> {
  return res.text();
}

function parseEvents(raw: string): { event: string; data: Record<string, unknown> }[] {
  const out: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    let dataLine = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
    }
    if (!dataLine) continue;
    try {
      out.push({ event, data: JSON.parse(dataLine) });
    } catch {
      // 無視
    }
  }
  return out;
}

describe("POST /api/chat — バリデーション", () => {
  it("空ボディは 400", async () => {
    const res = await POST(new Request("http://localhost/api/chat", { method: "POST" }));
    expect(res.status).toBe(400);
  });

  it("不正 JSON は 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("threadId 未指定は 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({ content: "hi" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("content 未指定は 400", async () => {
    const id = await createThread();
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({ threadId: id }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("存在しない threadId は 404", async () => {
    const res = await POST(chatReq("00000000-0000-0000-0000-000000000000", "hi"));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/chat — 実 API ストリーミング + DB 永続化", () => {
  itReal("SSE で start/delta/done を返し user/assistant を DB に保存", async () => {
    const id = await createThread();
    const res = await POST(chatReq(id, "「OK」とだけ2文字で返して。"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.body).toBeInstanceOf(ReadableStream);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    const start = events.filter((e) => e.event === "start");
    const deltas = events.filter((e) => e.event === "delta" && typeof e.data.delta === "string");
    const done = events.filter((e) => e.event === "done");

    expect(start).toHaveLength(1);
    expect(typeof start[0].data.userMessageId).toBe("string");
    expect(deltas.length).toBeGreaterThan(0);
    expect(done).toHaveLength(1);
    expect(typeof done[0].data.assistantMessageId).toBe("string");
    expect(typeof done[0].data.model).toBe("string");
    expect(typeof done[0].data.elapsedMs).toBe("number");
    expect(events.some((e) => e.event === "error")).toBe(false);

    const text = deltas.map((e) => e.data.delta as string).join("");
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  itReal("title が New chat のとき初回送信で自動生成される", async () => {
    const [row0] = await db.insert(threads).values({ title: "New chat" }).returning();
    createdIds.push(row0.id);
    const id = row0.id;
    await POST(chatReq(id, "日本の首都は？")).then((r) => r.text());

    const [row] = await db.select().from(threads).where(eq(threads.id, id));
    expect(row).toBeDefined();
    expect(row!.title).toContain("日本の首都");
  }, 60_000);
});

describe("POST /api/chat — Web 検索 sources イベント", () => {
  itReal("検索判定 → status → sources の順でイベントを送信", async () => {
    const id = await createThread();

    // 検索判定ルーターをモック: needsSearch:true でクエリを返す
    vi.mocked(decideSearch).mockResolvedValueOnce({
      needsSearch: true,
      reason: "latest info",
      userNotice: "最新情報を確認するね。",
      queries: ["python programming language"],
    });

    vi.mocked(searchWeb).mockResolvedValueOnce({
      query: "python programming language",
      results: [
        {
          url: "https://example.com/python",
          title: "Python",
          snippet: "Python is a programming language",
          scraped: true,
          content: "Python is a high-level programming language.",
          scrapeTitle: "Python",
        },
      ],
    });

    const res = await POST(chatReq(id, "Pythonとは何ですか？"));
    expect(res.status).toBe(200);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    // status イベント（userNotice）が送信される
    const statusEvents = events.filter((e) => e.event === "status");
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    expect(statusEvents[0].data.label).toBe("最新情報を確認するね。");

    // sources イベント
    const sources = events.filter((e) => e.event === "sources");
    expect(sources).toHaveLength(1);
    const srcs = sources[0].data.sources as Array<{ url: string; title: string }>;
    expect(srcs).toHaveLength(1);
    expect(srcs[0].url).toBe("https://example.com/python");
    expect(srcs[0].title).toBe("Python");

    // start → status → sources → ... → done の順序
    const startIdx = events.findIndex((e) => e.event === "start");
    const statusIdx = events.findIndex((e) => e.event === "status");
    const sourcesIdx = events.findIndex((e) => e.event === "sources");
    expect(statusIdx).toBeGreaterThan(startIdx);
    expect(sourcesIdx).toBeGreaterThan(statusIdx);
  }, 60_000);

  itReal("検索不要時は status/sources イベントを出さない", async () => {
    const id = await createThread();

    // 検索判定ルーターをモック: needsSearch:false
    vi.mocked(decideSearch).mockResolvedValueOnce({
      needsSearch: false,
      reason: "stable knowledge",
      userNotice: null,
      queries: [],
    });

    const res = await POST(chatReq(id, "Pythonのリスト内包表記を教えて"));
    expect(res.status).toBe(200);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    // status / sources は出ない
    expect(events.filter((e) => e.event === "status")).toHaveLength(0);
    expect(events.filter((e) => e.event === "sources")).toHaveLength(0);
    // searchWeb は呼ばれない
    expect(vi.mocked(searchWeb)).not.toHaveBeenCalled();
  }, 60_000);
});

describe("POST /api/chat — WEB_SEARCH_MODEL で decideSearch を呼ぶ", () => {
  const origSearchModel = process.env.WEB_SEARCH_MODEL;

  afterEach(() => {
    if (origSearchModel === undefined) delete process.env.WEB_SEARCH_MODEL;
    else process.env.WEB_SEARCH_MODEL = origSearchModel;
  });

  itReal("検索必要時 → WEB_SEARCH_MODEL で decideSearch を呼ぶ", async () => {
    process.env.WEB_SEARCH_MODEL = "umans-test-search";

    vi.mocked(decideSearch).mockResolvedValueOnce({
      needsSearch: true,
      reason: "latest info",
      userNotice: "最新情報を確認するね。",
      queries: ["test query"],
    });
    vi.mocked(searchWeb).mockResolvedValueOnce({
      query: "test query",
      results: [
        {
          url: "https://example.com/test",
          title: "Test",
          snippet: "Test snippet",
          scraped: false,
          content: "",
          scrapeTitle: "Test",
        },
      ],
    });

    const id = await createThread();
    const res = await POST(chatReq(id, "最新のニュース教えて"));
    expect(res.status).toBe(200);

    await sseChunks(res);

    // decideSearch の第2引数（model）が WEB_SEARCH_MODEL の値であること
    expect(vi.mocked(decideSearch)).toHaveBeenCalled();
    const callArgs = vi.mocked(decideSearch).mock.calls[0];
    expect(callArgs[1]).toBe("umans-test-search");
    // searchWeb も呼ばれる（SearXNG パス経由）
    expect(vi.mocked(searchWeb)).toHaveBeenCalled();
  }, 60_000);
});

describe("POST /api/chat — 記憶注入", () => {
  itReal("記憶がある場合、LLM への messages に memory system message が含まれる", async () => {
    const id = await createThread();

    // 記憶注入をモック: 記憶あり
    vi.mocked(buildMemoryContext).mockResolvedValueOnce({
      role: "system",
      content: "Past memories from previous conversations. Use these to provide context for the user's question. If the user asks what you discussed before, summarize the relevant memories.\n- [fact] User uses FPGA",
    });

    const res = await POST(chatReq(id, "私の得意分野は？"));
    expect(res.status).toBe(200);

    // ストリームを消費してからアサート（buildMemoryContext は start() 内で呼ばれる）
    await sseChunks(res);

    // buildMemoryContext が呼ばれた
    expect(vi.mocked(buildMemoryContext)).toHaveBeenCalled();
  }, 60_000);

  itReal("記憶が無い場合は buildMemoryContext が呼ばれるが null を返す", async () => {
    const id = await createThread();

    // 記憶なし（デフォルト mock のまま）
    const res = await POST(chatReq(id, "こんにちは"));
    expect(res.status).toBe(200);

    await sseChunks(res);
    // buildMemoryContext は呼ばれる（結果は null）
    expect(vi.mocked(buildMemoryContext)).toHaveBeenCalled();
  }, 60_000);
});
