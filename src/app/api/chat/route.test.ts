// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { folders, threads, users } from "@/db/schema";
import { eq } from "drizzle-orm";

// Mock searchWeb / upsertPage / decideSearch: verify sources event without SearXNG/DB/LLM side effects
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
  // Fixed test user. createThread creates a thread with this userId.
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id", name: "tester", email: "t@example.com" }),
}));
vi.mock("next/server", () => ({
  // route.ts only imports after() from next/server.
  // importOriginal() fails on Next 16 because next-auth cannot resolve
  // next/server (ESM), so the factory returns a minimal mock.
  after: () => {},
}));

// LLM client: only createLLM is overridable. Other implementations are kept as-is,
// so itReal tests can call the real API. createLLM is replaced in unit tests.
// vi.mock is hoisted, so variables referenced in mocks are wrapped with vi.hoisted.
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
  let useFake = false;
  // For unit tests, set to true to use fakeLlm. For itReal, set to false to use the real implementation.
  return { capturedMessages: captured, fakeLlm: fake, useFakeLlm: { get: () => useFake, set: (v: boolean) => (useFake = v) } };
});
vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  return {
    ...actual,
    createLLM: vi.fn(() => (useFakeLlm.get() ? fakeLlm : actual.createLLM())),
  };
});

import { searchWeb, scrapeUrl } from "@/lib/scraper";
import { decideSearch } from "@/lib/searchDecision";
import { searchWikipedia } from "@/lib/wikipedia";
import { buildMemoryContext } from "@/lib/memoryStore";
import { probeToolSupport } from "@/lib/toolProbe";
import { POST } from "@/app/api/chat/route";
import { createLLM } from "@/lib/llm";

// Reset mock call history and return values between tests (prevent leaks)
beforeEach(() => {
  vi.mocked(searchWeb).mockReset();
  vi.mocked(searchWikipedia).mockReset();
  capturedMessages.length = 0;
  vi.mocked(decideSearch).mockReset();
  vi.mocked(buildMemoryContext).mockReset();
  // Default: no search needed (don't call real LLM router in normal chat tests)
  vi.mocked(decideSearch).mockResolvedValue({
    searchLevel: "none",
    reason: "default mock",
    userNotice: null,
    queries: [],
  });
  // Default: no memory (null = not injected)
  vi.mocked(buildMemoryContext).mockResolvedValue(null);
});

// Phase 2: /api/chat uses DB persistence + real API streaming.
// Uses .env LLM_API_KEY / LLM_MODEL (loaded in vitest.setup.ts).
// Creates a thread per test, cleans up in afterAll.

const hasCreds = Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);
const itReal = hasCreds ? it : it.skip;

const createdIds: string[] = [];
const createdFolderIds: string[] = [];

beforeAll(async () => {
  // threads.userId references users.id, so create a test user beforehand.
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
  opts?: { systemPrompt?: string; rapid?: boolean; timeRange?: "day" | "week" | "month" | "year"; locale?: string },
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
    headers: { "Content-Type": "application/json", cookie: `umanschat-locale=${opts?.locale ?? "ja"}` },
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
      // Ignore
    }
  }
  return out;
}

describe("POST /api/chat — validation", () => {
  it("empty body returns 400", async () => {
    const res = await POST(new Request("http://localhost/api/chat", { method: "POST" }));
    expect(res.status).toBe(400);
  });

  it("invalid JSON returns 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("missing threadId returns 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({ content: "hi" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("missing content returns 400", async () => {
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

  it("nonexistent threadId returns 404", async () => {
    const res = await POST(chatReq("00000000-0000-0000-0000-000000000000", "hi"));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/chat — real API streaming + DB persistence", () => {
  itReal("returns start/delta/done via SSE and saves user/assistant to DB", async () => {
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

  itReal("title auto-generated on first send when title is 'New chat'", async () => {
    const [row0] = await db.insert(threads).values({ title: "New chat", userId: "test-user-id" }).returning();
    createdIds.push(row0.id);
    const id = row0.id;
    await POST(chatReq(id, "日本の首都は？")).then((r) => r.text());

    const [row] = await db.select().from(threads).where(eq(threads.id, id));
    expect(row).toBeDefined();
    expect(row!.title).toContain("日本の首都");
  }, 120_000);
});

describe("POST /api/chat — Web search sources event", () => {
  itReal("sends events in order: search decision → status → sources", async () => {
    const id = await createThread();

    // Mock search decision router: returns searchLevel:"web" with a query
    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "web",
      reason: "latest info",
      userNotice: "最新情報を確認するね。",
      queries: [{ query: "python programming language", time_range: null }],
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

    // status event (userNotice) is sent
    const statusEvents = events.filter((e) => e.event === "status");
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    expect(statusEvents[0].data.label).toBe("最新情報を確認するね。");
    // sources event
    const sources = events.filter((e) => e.event === "sources");
    expect(sources).toHaveLength(1);
    const srcs = sources[0].data.sources as Array<{ url: string; title: string }>;
    expect(srcs).toHaveLength(1);
    expect(srcs[0].url).toBe("https://example.com/python");
    expect(srcs[0].title).toBe("Python");

    // Order: start → status → sources → ... → done
    const startIdx = events.findIndex((e) => e.event === "start");
    const statusIdx = events.findIndex((e) => e.event === "status");
    const sourcesIdx = events.findIndex((e) => e.event === "sources");
    expect(statusIdx).toBeGreaterThan(startIdx);
    expect(sourcesIdx).toBeGreaterThan(statusIdx);
  }, 120_000);
  itReal("does not send status/sources events when search is unnecessary", async () => {
    const id = await createThread();
    // Mock search decision router: searchLevel:"none"
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

    // status / sources are not sent
    expect(events.filter((e) => e.event === "status")).toHaveLength(0);
    expect(events.filter((e) => e.event === "sources")).toHaveLength(0);
    // searchWeb is not called
    expect(vi.mocked(searchWeb)).not.toHaveBeenCalled();
  }, 120_000);
});

describe("POST /api/chat — calls decideSearch with WEB_SEARCH_MODEL", () => {
  const origSearchModel = process.env.WEB_SEARCH_MODEL;

  afterEach(() => {
    if (origSearchModel === undefined) delete process.env.WEB_SEARCH_MODEL;
    else process.env.WEB_SEARCH_MODEL = origSearchModel;
  });

  itReal("when search needed → calls decideSearch with WEB_SEARCH_MODEL", async () => {
    process.env.WEB_SEARCH_MODEL = "umans-test-search";

    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "web",
      reason: "latest info",
      userNotice: "最新情報を確認するね。",
      queries: [{ query: "test query", time_range: null }],
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

    // Verify decideSearch's 2nd argument (model) equals the WEB_SEARCH_MODEL value
    expect(vi.mocked(decideSearch)).toHaveBeenCalled();
    const callArgs = vi.mocked(decideSearch).mock.calls[0];
    expect(callArgs[1]).toBe("umans-test-search");
    // searchWeb is also called (via SearXNG path)
    expect(vi.mocked(searchWeb)).toHaveBeenCalled();
  }, 120_000);
});

describe("POST /api/chat — memory injection", () => {
  itReal("when memories exist, LLM messages include a memory system message", async () => {
    const id = await createThread();

    // Mock memory injection: with memories
    vi.mocked(buildMemoryContext).mockResolvedValueOnce({
      role: "system",
      content: "Past memories from previous conversations. Use these to provide context for the user's question. If the user asks what you discussed before, summarize the relevant memories.\n- [fact] User uses FPGA",
    });

    const res = await POST(chatReq(id, "私の得意分野は？"));
    expect(res.status).toBe(200);

    // Consume stream before asserting (buildMemoryContext is called inside start())
    await sseChunks(res);

    // buildMemoryContext was called
    expect(vi.mocked(buildMemoryContext)).toHaveBeenCalled();
  }, 120_000);

  itReal("when no memories, buildMemoryContext is called but returns null", async () => {
    const id = await createThread();

    // No memories (default mock)
    const res = await POST(chatReq(id, "こんにちは"));
    expect(res.status).toBe(200);

    await sseChunks(res);
    // buildMemoryContext is called (result is null)
    expect(vi.mocked(buildMemoryContext)).toHaveBeenCalled();
  }, 120_000);
});

describe("POST /api/chat — rapid mode", () => {
  itReal("rapid:true skips search/memory/URL while still sending start/delta/done", async () => {
    const id = await createThread();

    // Set up search-needed config to verify it's skipped in rapid mode
    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "web",
      reason: "latest info",
      userNotice: "最新情報を確認するね。",
      queries: [{ query: "python programming language", time_range: null }],
    });
    // Set up memory-present return to verify it's not called in rapid mode
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

    // Rapid mode: search/memory/URL scrape are never called
    expect(vi.mocked(decideSearch)).not.toHaveBeenCalled();
    expect(vi.mocked(searchWeb)).not.toHaveBeenCalled();
    expect(vi.mocked(buildMemoryContext)).not.toHaveBeenCalled();

    // But streaming itself still works
    const start = events.filter((e) => e.event === "start");
    const deltas = events.filter((e) => e.event === "delta" && typeof e.data.delta === "string");
    const done = events.filter((e) => e.event === "done");
    expect(start).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(done).toHaveLength(1);
    expect(events.some((e) => e.event === "error")).toBe(false);
  }, 120_000);
});

describe("POST /api/chat — time_range passthrough", () => {
  itReal("body.timeRange is passed as the 3rd argument to searchWeb", async () => {
    const id = await createThread();

    // Mock search decision router: searchLevel:"web" with 1 query
    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "web",
      reason: "latest info",
      userNotice: "最新情報を確認するね。",
      queries: [{ query: "latest news today", time_range: null }],
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

    // Verify searchWeb's 3rd argument (timeRange) matches body.timeRange
    // and 4th argument (language) is derived from locale (default "ja" → "ja-JP")
    expect(vi.mocked(searchWeb)).toHaveBeenCalled();
    const callArgs = vi.mocked(searchWeb).mock.calls[0];
    expect(callArgs[0]).toBe("latest news today");
    expect(callArgs[2]).toBe("week");
    expect(callArgs[3]).toBe("ja-JP");
  }, 120_000);
});

describe("POST /api/chat — status notification when search returns 0 results", () => {
  itReal("when searchWeb returns empty results, sends a status event notification", async () => {
    const id = await createThread();

    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "web",
      reason: "latest info",
      userNotice: "最新情報を確認するね。",
      queries: [{ query: "latest news today", time_range: null }],
    });
    vi.mocked(searchWeb).mockResolvedValueOnce({
      query: "latest news today",
      results: [],
    });

    const res = await POST(chatReq(id, "最新のニュース教えて"));
    expect(res.status).toBe(200);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    // Search start status (userNotice) is sent
    const statusEvents = events.filter((e) => e.event === "status");
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);

    // The last status should be a "no results found" notification
    const lastStatus = statusEvents[statusEvents.length - 1];
    expect(lastStatus.data.label).toContain("Web検索で結果が見つかりませんでした");

    // sources event is not sent (0 results)
    expect(events.filter((e) => e.event === "sources")).toHaveLength(0);
  }, 120_000);
});

describe("POST /api/chat — exclude pre-search message during tool use", () => {
  // In tool-use mode, buildSearchContext's "search complete, do not re-search" system message
  // hinders the LLM's tool call result reference, so it is excluded from effectiveMessages.
  // In non-tool-use mode, searchContextMessage is passed to the LLM as before.

  beforeAll(() => useFakeLlm.set(true));
  afterAll(() => useFakeLlm.set(false));

  const searchDecided = {
    searchLevel: "web",
    reason: "latest info",
    userNotice: "最新情報を確認するね。",
    queries: [{ query: "GPT-5.6 benchmark", time_range: null }],
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

  it("tool-supporting model → LLM messages do not contain 'search complete' message", async () => {
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

    // Search all LLM call messages for "search complete, do not re-search"
    const forbidden = "Web search has already been completed";
    const found = capturedMessages.some((msgs) =>
      msgs.some(
        (m) => typeof m.content === "string" && m.content.includes(forbidden),
      ),
    );
    expect(found).toBe(false);
  }, 30_000);

  it("non-tool-supporting model → LLM messages contain 'search complete' message", async () => {
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

describe("POST /api/chat — Wikipedia lookup with searchLevel:wiki", () => {
  beforeAll(() => useFakeLlm.set(true));
  afterAll(() => useFakeLlm.set(false));

  it("searchLevel:wiki → searchWikipedia is called, searchWeb is not", async () => {
    const id = await createThread();

    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "wiki",
      reason: "named entity lookup",
      userNotice: "Wikipediaで調べます。",
      queries: [{ query: "マグナ・カルタ", time_range: null }],
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

    // searchWikipedia is called
    expect(vi.mocked(searchWikipedia)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(searchWikipedia).mock.calls[0][0]).toBe("マグナ・カルタ");
    // searchWeb is not called (does not enter the full web search path)
    expect(vi.mocked(searchWeb)).not.toHaveBeenCalled();

    // sources event sends the Wikipedia URL
    const sources = events.filter((e) => e.event === "sources");
    expect(sources).toHaveLength(1);
    const srcs = sources[0].data.sources as Array<{ url: string }>;
    expect(srcs[0].url).toBe("https://ja.wikipedia.org/wiki/マグナ・カルタ");
  }, 30_000);

  it("searchLevel:wiki with no Wikipedia article → does not call searchWeb, answers from knowledge", async () => {
    const id = await createThread();

    vi.mocked(decideSearch).mockResolvedValueOnce({
      searchLevel: "wiki",
      reason: "named entity lookup",
      userNotice: "Wikipediaで調べます。",
      queries: [{ query: "存在しない架空の概念XYZ", time_range: null }],
    });
    vi.mocked(searchWikipedia).mockResolvedValueOnce(null);

    const res = await POST(chatReq(id, "存在しない架空の概念XYZとは？"));
    expect(res.status).toBe(200);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    // searchWikipedia is called but returns null
    expect(vi.mocked(searchWikipedia)).toHaveBeenCalledTimes(1);
    // Does not fall back to searchWeb
    expect(vi.mocked(searchWeb)).not.toHaveBeenCalled();
    // sources event is not sent (no article)
    expect(events.filter((e) => e.event === "sources")).toHaveLength(0);
    // A "no article found" status notification appears
    const statusEvents = events.filter((e) => e.event === "status");
    expect(statusEvents.some((e) => e.data.label.includes("Wikipediaに該当記事が見つかりません"))).toBe(true);
  }, 30_000);
});

describe("POST /api/chat — English locale status labels", () => {
  beforeAll(() => useFakeLlm.set(true));
  afterAll(() => useFakeLlm.set(false));
  // Regression: hardcoded Japanese status labels must be localized via t(locale, ...).
  // Exercises buildUrlContext with locale=en and asserts the newly-i18n'd
  // statusUrlFetch label is English ("Fetching URL content…").
  it("URL scraping sends an English status label when locale=en", async () => {
    const id = await createThread();

    vi.mocked(scrapeUrl).mockResolvedValueOnce({
      url: "https://example.com/article",
      title: "Example Article",
      content: "This is the article body.",
    });

    const res = await POST(chatReq(id, "Check this out: https://example.com/article", { locale: "en" }));
    expect(res.status).toBe(200);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    const statusEvents = events.filter((e) => e.event === "status");
    const fetchStatus = statusEvents.find(
      (e) => e.data.label === "Fetching URL content…",
    );
    expect(fetchStatus).toBeDefined();
  }, 10_000);
});

describe("POST /api/chat — Hyper Thinking mode", () => {
  beforeAll(() => useFakeLlm.set(true));
  afterAll(() => useFakeLlm.set(false));
  beforeEach(() => {
    vi.mocked(fakeLlm.chat.completions.create).mockClear();
  });

  it("sends hyper_trace event with correct rounds structure", async () => {
    // Create a thread with responseMode="hyper" and hyperRounds=3
    const [row] = await db
      .insert(threads)
      .values({
        title: "hyper mode test",
        userId: "test-user-id",
        responseMode: "hyper",
        hyperRounds: 3,
      })
      .returning();
    createdIds.push(row.id);
    const id = row.id;

    const res = await POST(chatReq(id, "量子コンピュータの基本原理を説明して"));
    expect(res.status).toBe(200);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    // hyper_trace event is sent
    const hyperTraceEvents = events.filter((e) => e.event === "hyper_trace");
    expect(hyperTraceEvents).toHaveLength(1);
    const trace = hyperTraceEvents[0].data.hyperTrace as {
      rounds: { perspective: string; draft: string; critique: string; revised: string }[];
      finalModel: string;
    };
    expect(trace.rounds).toHaveLength(3);
    expect(typeof trace.finalModel).toBe("string");
    // Each round has all four fields
    for (const round of trace.rounds) {
      expect(typeof round.perspective).toBe("string");
      expect(round.perspective.length).toBeGreaterThan(0);
      expect(typeof round.draft).toBe("string");
      expect(typeof round.critique).toBe("string");
      expect(typeof round.revised).toBe("string");
    }

    // delta events are sent (final streaming)
    const deltas = events.filter((e) => e.event === "delta" && typeof e.data.delta === "string");
    expect(deltas.length).toBeGreaterThan(0);

    // done event is sent
    const done = events.filter((e) => e.event === "done");
    expect(done).toHaveLength(1);
    expect(events.some((e) => e.event === "error")).toBe(false);

    // LLM call count: at least 2*rounds+1 non-streaming (1 draft + 3*(critique+revised) = 7)
    // plus exactly 1 streaming call for the final answer.
    const createCalls = vi.mocked(fakeLlm.chat.completions.create).mock.calls;
    const nonStreaming = createCalls.filter((args) => !args[0]?.stream).length;
    const streaming = createCalls.filter((args) => args[0]?.stream).length;
    expect(nonStreaming).toBeGreaterThanOrEqual(7);
    expect(streaming).toBe(1);
  }, 30_000);

  it("hyperRounds=1 produces 1 round", async () => {
    const [row] = await db
      .insert(threads)
      .values({
        title: "hyper mode 1-round test",
        userId: "test-user-id",
        responseMode: "hyper",
        hyperRounds: 1,
      })
      .returning();
    createdIds.push(row.id);
    const id = row.id;

    const res = await POST(chatReq(id, "Hello"));
    expect(res.status).toBe(200);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    const hyperTraceEvents = events.filter((e) => e.event === "hyper_trace");
    expect(hyperTraceEvents).toHaveLength(1);
    const trace = hyperTraceEvents[0].data.hyperTrace as {
      rounds: unknown[];
      finalModel: string;
    };
    expect(trace.rounds).toHaveLength(1);

    // 1 (draft) + 1*(critique+revised) = 3 non-streaming + 1 streaming
    const createCalls = vi.mocked(fakeLlm.chat.completions.create).mock.calls;
    const nonStreaming = createCalls.filter((args) => !args[0]?.stream).length;
    const streaming = createCalls.filter((args) => args[0]?.stream).length;
    expect(nonStreaming).toBeGreaterThanOrEqual(3);
    expect(streaming).toBe(1);
  }, 30_000);
});

describe("POST /api/chat — TTFT model fallback", () => {
  const origFallbackModel = process.env.LLM_FALLBACK_MODEL;
  const origFallbackTimeout = process.env.LLM_FALLBACK_TIMEOUT_MS;

  afterEach(() => {
    vi.mocked(createLLM).mockReset();
    if (origFallbackModel === undefined) delete process.env.LLM_FALLBACK_MODEL;
    else process.env.LLM_FALLBACK_MODEL = origFallbackModel;
    if (origFallbackTimeout === undefined) delete process.env.LLM_FALLBACK_TIMEOUT_MS;
    else process.env.LLM_FALLBACK_TIMEOUT_MS = origFallbackTimeout;
  });

  it("first token timeout → falls back to fallback model", async () => {
    const id = await createThread();
    process.env.LLM_FALLBACK_MODEL = "gpt-4o-mini";
    process.env.LLM_FALLBACK_TIMEOUT_MS = "100";

    // 1回目: signalがabortされるまでチャンクを返さない遅延ストリーム
    // 2回目: 即座にコンテンツを返すストリーム
    let callCount = 0;
    vi.mocked(createLLM).mockReturnValue({
      chat: {
        completions: {
          create: vi.fn(async (params: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
            callCount++;
            if (params.stream) {
              if (callCount === 1) {
                // 最初の呼び出し: signalがabortされるまで待機し、AbortErrorを投げる
                const { promise, resolve } = Promise.withResolvers<void>();
                const signal = opts?.signal;
                if (signal) {
                  if (signal.aborted) resolve();
                  else signal.addEventListener("abort", () => resolve(), { once: true });
                }
                await promise;
                throw new DOMException("The user aborted a request", "AbortError");
              }
              // 2回目: フォールバックモデルで即座にコンテンツを返す
              return (async function* () {
                yield { choices: [{ delta: { content: "Fallback response." } }] };
              })();
            }
            return { choices: [{ message: { content: "summary" } }] };
          }),
        },
      },
    } as never);

    const res = await POST(chatReq(id, "テスト", { rapid: true }));
    expect(res.status).toBe(200);
    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    const statusEvents = events.filter((e) => e.event === "status");
    expect(statusEvents.some((e) => {
      const label = e.data.label as string;
      return label && label.includes("gpt-4o-mini");
    })).toBe(true);

    // doneイベントのmodelがフォールバックモデル
    const done = events.filter((e) => e.event === "done");
    expect(done).toHaveLength(1);
    expect(done[0].data.model).toBe("gpt-4o-mini");

    // エラーイベントがない
    expect(events.some((e) => e.event === "error")).toBe(false);
  }, 30_000);

  it("first token arrives within timeout → no fallback", async () => {
    const id = await createThread();
    process.env.LLM_FALLBACK_MODEL = "gpt-4o-mini";
    process.env.LLM_FALLBACK_TIMEOUT_MS = "30000"; // 十分に長い

    let callCount = 0;
    vi.mocked(createLLM).mockReturnValue({
      chat: {
        completions: {
          create: vi.fn(async (params: Record<string, unknown>) => {
            callCount++;
            if (params.stream) {
              return (async function* () {
                yield { choices: [{ delta: { content: "Quick response." } }] };
              })();
            }
            return { choices: [{ message: { content: "summary" } }] };
          }),
        },
      },
    } as never);

    const res = await POST(chatReq(id, "テスト", { rapid: true }));
    expect(res.status).toBe(200);
    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    // フォールバックstatusイベントがない
    const statusEvents = events.filter((e) => e.event === "status");
    expect(statusEvents.some((e) => {
      const label = e.data.label as string;
      return label && label.includes("gpt-4o-mini");
    })).toBe(false);

    // doneイベントのmodelがプライマリモデル
    const done = events.filter((e) => e.event === "done");
    expect(done).toHaveLength(1);
    expect(done[0].data.model).not.toBe("gpt-4o-mini");

    // LLM呼び出しは1回のみ（フォールバックしていない）
    expect(callCount).toBe(1);
  }, 30_000);

  it("LLM_FALLBACK_MODEL unset → no fallback behavior", async () => {
    const id = await createThread();
    delete process.env.LLM_FALLBACK_MODEL;

    let callCount = 0;
    vi.mocked(createLLM).mockReturnValue({
      chat: {
        completions: {
          create: vi.fn(async (params: Record<string, unknown>) => {
            callCount++;
            if (params.stream) {
              return (async function* () {
                yield { choices: [{ delta: { content: "Normal response." } }] };
              })();
            }
            return { choices: [{ message: { content: "summary" } }] };
          }),
        },
      },
    } as never);

    const res = await POST(chatReq(id, "テスト", { rapid: true }));
    expect(res.status).toBe(200);
    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    // フォールバックstatusがない
    const statusEvents = events.filter((e) => e.event === "status");
    expect(statusEvents.some((e) => {
      const label = e.data.label as string;
      return label && label.includes("fallback");
    })).toBe(false);

    // doneイベントのmodelがプライマリモデル
    const done = events.filter((e) => e.event === "done");
    expect(done).toHaveLength(1);

    // LLM呼び出しは1回のみ
    expect(callCount).toBe(1);
  }, 30_000);
});
