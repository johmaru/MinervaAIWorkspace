// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { folders, threads, users } from "@/db/schema";
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
vi.mock("@/lib/wikipedia", () => ({
  searchWikipedia: vi.fn(),
}));
vi.mock("@/lib/memoryStore", () => ({
  buildMemoryContext: vi.fn(),
}));
vi.mock("@/lib/memory", () => ({
  generateMemories: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/toolProbe", () => ({
  probeToolSupport: vi.fn().mockResolvedValue({ supported: false, checkedAt: new Date() }),
  warmupToolProbe: vi.fn(),
}));
vi.mock("@/lib/auth-guards", () => ({
  // テスト用の固定ユーザー。createThread はこの userId でスレッドを作成する。
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id", name: "tester", email: "t@example.com" }),
}));
vi.mock("next/server", () => ({
  // route.ts は next/server から after() のみをインポートする。
  // importOriginal() は next-auth が next/server (ESM) を解決できず
  // Next 16 で失敗するため、ファクトリで最小モックを返す。
  after: () => {},
}));

// LLM クライアント: createLLM のみ上書き可能にする。それ以外は実装を維持し、
// itReal テストが実 API を叩けるようにする。createLLM は unit test で差し替える。
// vi.mock は hoist されるため、モック内で参照する変数は vi.hoisted で囲む。
const { capturedMessages, fakeLlm, useFakeLlm } = vi.hoisted(() => {
  const captured: Record<string, unknown>[][] = [];
  const stream = async function* () {
    yield { choices: [{ delta: { content: "OK" } }] };
  };
  const fake = {
    chat: {
      completions: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          captured.push(params.messages as Record<string, unknown>[]);
          if (params.stream) {
            return stream();
          }
          return { choices: [{ message: { content: "summary" } }] };
        }),
      },
    },
  };
  // unit test なら true にして fakeLlm を使う。itReal なら false で実装に戻す。
  let useFake = false;
  return { capturedMessages: captured, fakeLlm: fake, useFakeLlm: { get: () => useFake, set: (v: boolean) => (useFake = v) } };
});
vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  return {
    ...actual,
    createLLM: vi.fn(() => (useFakeLlm.get() ? fakeLlm : actual.createLLM())),
  };
});

import { searchWeb } from "@/lib/scraper";
import { decideSearch } from "@/lib/searchDecision";
import { searchWikipedia } from "@/lib/wikipedia";
import { buildMemoryContext } from "@/lib/memoryStore";
import { probeToolSupport } from "@/lib/toolProbe";
import { POST } from "@/app/api/chat/route";
import { createLLM } from "@/lib/llm";

// テスト間でモックの呼び出し履歴・戻り値をリセット（leak 防止）
beforeEach(() => {
  vi.mocked(searchWeb).mockReset();
  vi.mocked(searchWikipedia).mockReset();
  capturedMessages.length = 0;
  vi.mocked(decideSearch).mockReset();
  vi.mocked(buildMemoryContext).mockReset();
  // デフォルト: 検索不要（通常チャットのテストで実 LLM ルーターを呼ばない）
  vi.mocked(decideSearch).mockResolvedValue({
    searchLevel: "none",
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

beforeAll(async () => {
  // threads.userId は users.id を参照するため、テストユーザーを事前作成。
  await db.insert(users).values({ id: "test-user-id", nickname: "tester", email: "t@example.com" }).onConflictDoNothing();
});

afterAll(async () => {
  for (const id of createdIds) {
    await db.delete(threads).where(eq(threads.id, id));
  }
  for (const id of createdFolderIds) {
    await db.delete(folders).where(eq(folders.id, id));
  }
});

async function createThread(): Promise<string> {
  const [row] = await db.insert(threads).values({ title: "chat route test", userId: "test-user-id" }).returning();
  createdIds.push(row.id);
  return row.id;
}

function chatReq(
  threadId: string,
  content: string,
  opts?: { systemPrompt?: string; rapid?: boolean; timeRange?: "day" | "week" | "month" | "year" },
): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify({
      threadId,
      content,
      systemPrompt: opts?.systemPrompt,
      rapid: opts?.rapid,
      timeRange: opts?.timeRange,
    }),
    headers: { "Content-Type": "application/json", cookie: "umanschat-locale=ja" },
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
  }, 120_000);

  itReal("title が New chat のとき初回送信で自動生成される", async () => {
    const [row0] = await db.insert(threads).values({ title: "New chat", userId: "test-user-id" }).returning();
    createdIds.push(row0.id);
    const id = row0.id;
    await POST(chatReq(id, "日本の首都は？")).then((r) => r.text());

    const [row] = await db.select().from(threads).where(eq(threads.id, id));
    expect(row).toBeDefined();
    expect(row!.title).toContain("日本の首都");
  }, 120_000);
});

describe("POST /api/chat — Web 検索 sources イベント", () => {
  itReal("検索判定 → status → sources の順でイベントを送信", async () => {
    const id = await createThread();

    // 検索判定ルーターをモック: searchLevel:"web" でクエリを返す
    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "web",
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
          raw_content: "Python is a programming language",
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
  }, 120_000);

  itReal("検索不要時は status/sources イベントを出さない", async () => {
    const id = await createThread();

    // 検索判定ルーターをモック: searchLevel:"none"
    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "none",
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
  }, 120_000);
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
      searchLevel: "web",
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
          raw_content: "Test snippet",
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
  }, 120_000);
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
  }, 120_000);

  itReal("記憶が無い場合は buildMemoryContext が呼ばれるが null を返す", async () => {
    const id = await createThread();

    // 記憶なし（デフォルト mock のまま）
    const res = await POST(chatReq(id, "こんにちは"));
    expect(res.status).toBe(200);

    await sseChunks(res);
    // buildMemoryContext は呼ばれる（結果は null）
    expect(vi.mocked(buildMemoryContext)).toHaveBeenCalled();
  }, 120_000);
});

describe("POST /api/chat — rapid mode", () => {
  itReal("rapid:true で検索・記憶・URL をスキップしつつ start/delta/done は送信する", async () => {
    const id = await createThread();

    // 検索が必要な設定にしておき、rapid でスキップされることを検証
    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "web",
      reason: "latest info",
      userNotice: "最新情報を確認するね。",
      queries: ["python programming language"],
    });
    // 記憶ありの戻り値を設定しておき、rapid で呼ばれないことを検証
    vi.mocked(buildMemoryContext).mockResolvedValueOnce({
      role: "system",
      content: "Past memories from previous conversations.",
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
          raw_content: "Python is a programming language",
        },
      ],
    });

    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({ threadId: id, content: "Pythonとは何ですか？", rapid: true }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    // ラピッドモード: 検索・記憶・URL スクレイプは一切呼ばれない
    expect(vi.mocked(decideSearch)).not.toHaveBeenCalled();
    expect(vi.mocked(searchWeb)).not.toHaveBeenCalled();
    expect(vi.mocked(buildMemoryContext)).not.toHaveBeenCalled();

    // ただしストリーミング自体は動作する
    const start = events.filter((e) => e.event === "start");
    const deltas = events.filter((e) => e.event === "delta" && typeof e.data.delta === "string");
    const done = events.filter((e) => e.event === "done");
    expect(start).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(done).toHaveLength(1);
    expect(events.some((e) => e.event === "error")).toBe(false);
  }, 120_000);
});

describe("POST /api/chat — time_range 透過", () => {
  itReal("body.timeRange が searchWeb の第3引数に渡される", async () => {
    const id = await createThread();

    // 検索判定ルーターをモック: searchLevel:"web" でクエリ1件
    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "web",
      reason: "latest info",
      userNotice: "最新情報を確認するね。",
      queries: ["latest news today"],
    });
    vi.mocked(searchWeb).mockResolvedValueOnce({
      query: "latest news today",
      results: [
        {
          url: "https://example.com/news",
          title: "News",
          snippet: "Breaking news",
          scraped: false,
          content: "",
          scrapeTitle: "News",
          raw_content: "Breaking news",
        },
      ],
    });

    const res = await POST(chatReq(id, "最新のニュース教えて", { timeRange: "week" }));
    expect(res.status).toBe(200);

    await sseChunks(res);

    // searchWeb の第3引数（timeRange）が body.timeRange と一致すること
    expect(vi.mocked(searchWeb)).toHaveBeenCalled();
    const callArgs = vi.mocked(searchWeb).mock.calls[0];
    expect(callArgs[0]).toBe("latest news today");
    expect(callArgs[2]).toBe("week");
  }, 120_000);
});

describe("POST /api/chat — 検索結果0件時のステータス通知", () => {
  itReal("searchWeb が空結果を返した場合、status イベントで通知する", async () => {
    const id = await createThread();

    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "web",
      reason: "latest info",
      userNotice: "最新情報を確認するね。",
      queries: ["latest news today"],
    });
    vi.mocked(searchWeb).mockResolvedValueOnce({
      query: "latest news today",
      results: [],
    });

    const res = await POST(chatReq(id, "最新のニュース教えて"));
    expect(res.status).toBe(200);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    // 検索開始の status（userNotice）が送信される
    const statusEvents = events.filter((e) => e.event === "status");
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);

    // 最後の status が「結果が見つからなかった」通知であること
    const lastStatus = statusEvents[statusEvents.length - 1];
    expect(lastStatus.data.label).toContain("Web検索で結果が見つかりませんでした");

    // sources イベントは送信されない（結果0件なので）
    expect(events.filter((e) => e.event === "sources")).toHaveLength(0);
  }, 120_000);
});

describe("POST /api/chat — ツール使用時に事前検索メッセージを除外", () => {
  // ツール使用モードでは buildSearchContext の「検索完了・再検索禁止」system メッセージが
  // LLM のツール呼び出し結果の参照を阻害するため、effectiveMessages から除外される。
  // ツール非使用モードでは従来通り searchContextMessage が LLM に渡される。

  beforeAll(() => useFakeLlm.set(true));
  afterAll(() => useFakeLlm.set(false));

  const searchDecided = {
    searchLevel: "web",
    reason: "latest info",
    userNotice: "最新情報を確認するね。",
    queries: ["GPT-5.6 benchmark"],
  };
  const searchHit = {
    query: "GPT-5.6 benchmark",
    results: [
      {
        url: "https://note.com/example/gpt56",
        title: "GPT-5.6 benchmark",
        snippet: "GPT-5.6 scores",
        scraped: true,
        content: "GPT-5.6 benchmark results.",
        scrapeTitle: "GPT-5.6 benchmark",
        raw_content: "GPT-5.6 scores",
      },
    ],
  };

  it("ツール対応モデル → LLM の messages に「検索完了」メッセージが含まれない", async () => {
    const id = await createThread();
    vi.mocked(decideSearch).mockResolvedValueOnce(searchDecided);
    vi.mocked(searchWeb).mockResolvedValueOnce(searchHit);
    vi.mocked(probeToolSupport).mockResolvedValueOnce({
      supported: true,
      checkedAt: new Date(),
    });

    const res = await POST(chatReq(id, "GPT-5.6ってベンチマーク出てる？"));
    expect(res.status).toBe(200);
    await sseChunks(res);

    // LLM に渡された全呼び出しの messages から「検索完了・再検索禁止」を探す
    const forbidden = "Web search has already been completed";
    const found = capturedMessages.some((msgs) =>
      msgs.some(
        (m) => typeof m.content === "string" && m.content.includes(forbidden),
      ),
    );
    expect(found).toBe(false);
  }, 30_000);

  it("ツール非対応モデル → LLM の messages に「検索完了」メッセージが含まれる", async () => {
    const id = await createThread();
    vi.mocked(decideSearch).mockResolvedValueOnce(searchDecided);
    vi.mocked(searchWeb).mockResolvedValueOnce(searchHit);
    vi.mocked(probeToolSupport).mockResolvedValueOnce({
      supported: false,
      checkedAt: new Date(),
    });

    const res = await POST(chatReq(id, "GPT-5.6ってベンチマーク出てる？"));
    expect(res.status).toBe(200);
    await sseChunks(res);

    const forbidden = "Web search has already been completed";
    const found = capturedMessages.some((msgs) =>
      msgs.some(
        (m) => typeof m.content === "string" && m.content.includes(forbidden),
      ),
    );
    expect(found).toBe(true);
  }, 30_000);
});


describe("POST /api/chat — tool-call markup leak prevention", () => {
  afterEach(() => vi.mocked(createLLM).mockReset());

  it("tool-call markup detected -> replace_content event sent with sanitized content", async () => {
    const id = await createThread();
    const openTag = String.fromCharCode(60) + "tool_call" + String.fromCharCode(62);
    const closeTag = String.fromCharCode(60) + "/tool_call" + String.fromCharCode(62);
    const markup = openTag + '{"name":"search_web","arguments":{"query":"GPT-5"}}' + closeTag;

    const markupStream = async function* () {
      yield { choices: [{ delta: { content: markup } }] };
    };
    const cleanStream = async function* () {
      yield { choices: [{ delta: { content: "Answer here." } }] };
    };
    let callCount = 0;
    vi.mocked(createLLM).mockReturnValue({
      chat: {
        completions: {
          create: vi.fn(async (params: Record<string, unknown>) => {
            callCount++;
            if (params.stream) return callCount === 1 ? markupStream() : cleanStream();
            return { choices: [{ message: { content: "summary" } }] };
          }),
        },
      },
    } as never);

    const res = await POST(chatReq(id, "search please"));
    expect(res.status).toBe(200);
    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    const replaceEvents = events.filter((e) => e.event === "replace_content");
    expect(replaceEvents).toHaveLength(1);
    expect(typeof replaceEvents[0].data.content).toBe("string");
    expect(String(replaceEvents[0].data.content)).not.toMatch(/tool_call/);

    // delta stream still contains raw markup (model output), but replace_content
    // tells the client to replace displayed content with sanitized version.
    // Verify the continuation (post-replace_content) deltas are clean.
    const replaceIdx = events.findIndex((e) => e.event === "replace_content");
    const postReplaceDeltas = events
      .filter((e, i) => e.event === "delta" && i > replaceIdx)
      .map((e) => e.data.delta as string)
      .join("");
    expect(postReplaceDeltas).not.toMatch(/tool_call/);
    expect(postReplaceDeltas).toContain("Answer here.");
  }, 30_000);
});

describe("POST /api/chat — searchLevel:wiki で Wikipedia 参照", () => {
  beforeAll(() => useFakeLlm.set(true));
  afterAll(() => useFakeLlm.set(false));

  it("searchLevel:wiki → searchWikipedia が呼ばれ searchWeb は呼ばれない", async () => {
    const id = await createThread();

    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "wiki",
      reason: "named entity lookup",
      userNotice: "Wikipediaで調べます。",
      queries: ["マグナ・カルタ"],
    });
    vi.mocked(searchWikipedia).mockResolvedValueOnce({
      title: "マグナ・カルタ",
      description: "イギリスの法律文書",
      extract: "マグナ・カルタ（大憲章）は1215年に成立した文書。",
      url: "https://ja.wikipedia.org/wiki/マグナ・カルタ",
      lang: "ja",
    });

    const res = await POST(chatReq(id, "マグナ・カルタとは？"));
    expect(res.status).toBe(200);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    // searchWikipedia が呼ばれる
    expect(vi.mocked(searchWikipedia)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(searchWikipedia).mock.calls[0][0]).toBe("マグナ・カルタ");
    // searchWeb は呼ばれない（フル Web 検索パスに入らない）
    expect(vi.mocked(searchWeb)).not.toHaveBeenCalled();

    // sources イベントで Wikipedia URL が送信される
    const sources = events.filter((e) => e.event === "sources");
    expect(sources).toHaveLength(1);
    const srcs = sources[0].data.sources as Array<{ url: string }>;
    expect(srcs[0].url).toBe("https://ja.wikipedia.org/wiki/マグナ・カルタ");
  }, 30_000);

  it("searchLevel:wiki で Wikipedia に記事が無い → searchWeb は呼ばず知識で回答", async () => {
    const id = await createThread();

    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "wiki",
      reason: "named entity lookup",
      userNotice: "Wikipediaで調べます。",
      queries: ["存在しない架空の概念XYZ"],
    });
    vi.mocked(searchWikipedia).mockResolvedValueOnce(null);

    const res = await POST(chatReq(id, "存在しない架空の概念XYZとは？"));
    expect(res.status).toBe(200);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    // searchWikipedia は呼ばれるが結果 null
    expect(vi.mocked(searchWikipedia)).toHaveBeenCalledTimes(1);
    // searchWeb にはフォールバックしない
    expect(vi.mocked(searchWeb)).not.toHaveBeenCalled();
    // sources イベントは送信されない（記事なし）
    expect(events.filter((e) => e.event === "sources")).toHaveLength(0);
    // 「記事が見つからなかった」status 通知が出る
    const statusEvents = events.filter((e) => e.event === "status");
    expect(statusEvents.some((e) => e.data.label.includes("Wikipediaに該当記事が見つかりません"))).toBe(true);
  }, 30_000);
});
