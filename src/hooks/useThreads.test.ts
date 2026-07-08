import { act, renderHook as rtlRenderHook, waitFor } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
import { createElement, type ReactNode } from "react";
import { db } from "@/db";
import { threads } from "@/db/schema";
import { eq } from "drizzle-orm";
import { useThreads } from "@/hooks/useThreads";
import { I18nProvider } from "@/components/I18nProvider";

const wrapper = ({ children }: { children: ReactNode }) => createElement(I18nProvider, null, children);
function renderHook<T>(callback: () => T) {
  return rtlRenderHook(callback, { wrapper });
}

// useThreads は /api/threads の CRUD を叩く。
// fetch をモックして決定的な応答を返す。
// DB との統合は route.test.ts で担保済み。

const createdThreadIds: string[] = [];

afterAll(async () => {
  for (const id of createdThreadIds) {
    await db.delete(threads).where(eq(threads.id, id));
  }
});

const originalFetch = globalThis.fetch;

function fetchMock(): Mock {
  return globalThis.fetch as unknown as Mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

const sampleThread = {
  id: "sample-id",
  title: "Sample",
  folderId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("useThreads — 初回ロード", () => {
  it("マウントで GET /api/threads を呼ぶ", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleThread]));
    const { result } = renderHook(() => useThreads());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock()).toHaveBeenCalledWith("/api/threads", undefined);
    expect(result.current.threads).toHaveLength(1);
    expect(result.current.threads[0].title).toBe("Sample");
  });

  it("ロード失敗は error に設定", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ error: "x" }, 500));
    const { result } = renderHook(() => useThreads());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toMatch(/HTTP 500/);
  });
});

describe("useThreads — create", () => {
  it("POST で新規スレッドを作り一覧に先頭挿入", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleThread]));
    const { result } = renderHook(() => useThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    const newThread = { ...sampleThread, id: "new-id", title: "New" };
    fetchMock().mockResolvedValue(jsonResponse(newThread, 201));

    let created: unknown;
    await act(async () => {
      created = await result.current.create();
    });
    expect(created).toEqual(newThread);
    expect(result.current.threads[0].id).toBe("new-id");
  });

  it("create 失敗は null を返し error に設定", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleThread]));
    const { result } = renderHook(() => useThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    fetchMock().mockResolvedValue(jsonResponse({ error: "x" }, 500));
    let created: unknown;
    await act(async () => {
      created = await result.current.create();
    });
    expect(created).toBeNull();
    expect(result.current.error).toMatch(/HTTP 500/);
  });
});

describe("useThreads — rename", () => {
  it("PATCH で title を更新し一覧に反映", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleThread]));
    const { result } = renderHook(() => useThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    const renamed = { ...sampleThread, title: "Renamed" };
    fetchMock().mockResolvedValue(jsonResponse(renamed));

    let ok: boolean;
    await act(async () => {
      ok = await result.current.rename("sample-id", "Renamed");
    });
    expect(ok!).toBe(true);
    expect(result.current.threads[0].title).toBe("Renamed");
  });

  it("rename 失敗は false を返し error に設定", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleThread]));
    const { result } = renderHook(() => useThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    fetchMock().mockResolvedValue(jsonResponse({ error: "x" }, 500));
    let ok: boolean;
    await act(async () => {
      ok = await result.current.rename("sample-id", "Renamed");
    });
    expect(ok!).toBe(false);
    expect(result.current.error).toMatch(/HTTP 500/);
  });
});

describe("useThreads — move", () => {
  it("PATCH で folderId を更新し一覧に反映", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleThread]));
    const { result } = renderHook(() => useThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    const moved = { ...sampleThread, folderId: "folder-9" };
    fetchMock().mockResolvedValue(jsonResponse(moved));

    let ok: boolean;
    await act(async () => {
      ok = await result.current.move("sample-id", "folder-9");
    });
    expect(ok!).toBe(true);
    expect(result.current.threads[0].folderId).toBe("folder-9");

    // PATCH の URL と body
    const call = fetchMock().mock.calls[1];
    expect(call[0]).toBe("/api/threads?id=sample-id");
    expect(call[1].method).toBe("PATCH");
    expect(JSON.parse(call[1].body)).toEqual({ folderId: "folder-9" });
  });

  it("move で folderId に null を設定（フォルダから外す）", async () => {
    const inFolder = { ...sampleThread, folderId: "folder-1" };
    fetchMock().mockResolvedValue(jsonResponse([inFolder]));
    const { result } = renderHook(() => useThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    const moved = { ...sampleThread, folderId: null };
    fetchMock().mockResolvedValue(jsonResponse(moved));

    let ok: boolean;
    await act(async () => {
      ok = await result.current.move("sample-id", null);
    });
    expect(ok!).toBe(true);
    expect(result.current.threads[0].folderId).toBeNull();
  });

  it("move 失敗は false を返し error に設定", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleThread]));
    const { result } = renderHook(() => useThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    fetchMock().mockResolvedValue(jsonResponse({ error: "x" }, 500));
    let ok: boolean;
    await act(async () => {
      ok = await result.current.move("sample-id", "folder-9");
    });
    expect(ok!).toBe(false);
    expect(result.current.error).toMatch(/HTTP 500/);
  });

  it("成功後は前の error がクリアされる", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleThread]));
    const { result } = renderHook(() => useThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    // まず失敗させて error を設定
    fetchMock().mockResolvedValue(jsonResponse({ error: "x" }, 500));
    await act(async () => {
      await result.current.move("sample-id", "bad");
    });
    expect(result.current.error).toMatch(/HTTP 500/);

    // 次に成功させると error がクリアされる
    const moved = { ...sampleThread, folderId: "folder-9" };
    fetchMock().mockResolvedValue(jsonResponse(moved));
    await act(async () => {
      await result.current.move("sample-id", "folder-9");
    });
    expect(result.current.error).toBeNull();
  });
});

describe("useThreads — remove", () => {
  it("DELETE で一覧から除外", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleThread]));
    const { result } = renderHook(() => useThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    fetchMock().mockResolvedValue(emptyResponse(204));
    let ok: boolean;
    await act(async () => {
      ok = await result.current.remove("sample-id");
    });
    expect(ok!).toBe(true);
    expect(result.current.threads).toHaveLength(0);
  });
});

describe("useThreads — refresh", () => {
  it("refresh で一覧を再取得", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleThread]));
    const { result } = renderHook(() => useThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    fetchMock().mockResolvedValue(
      jsonResponse([sampleThread, { ...sampleThread, id: "second" }]),
    );
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.threads).toHaveLength(2);
  });
});
