import { act, renderHook, waitFor } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFolders } from "@/hooks/useFolders";

// useFolders は /api/folders の CRUD を叩く。fetch をモックして決定的な応答を返す。

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

const sampleFolder = {
  id: "folder-1",
  name: "仕事",
  instruction: null,
  memoryScope: "global" as const,
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

describe("useFolders — 初回ロード", () => {
  it("マウントで GET /api/folders を呼ぶ", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock()).toHaveBeenCalledWith("/api/folders");
    expect(result.current.folders).toHaveLength(1);
    expect(result.current.folders[0].name).toBe("仕事");
  });

  it("ロード失敗は error に設定", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ error: "x" }, 500));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toMatch(/HTTP 500/);
  });
});

describe("useFolders — create", () => {
  it("POST で新規フォルダを作り一覧に先頭挿入", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.folders).toHaveLength(1));

    const newFolder = { ...sampleFolder, id: "new-id", name: "新規" };
    fetchMock().mockResolvedValue(jsonResponse(newFolder, 201));

    let created: unknown;
    await act(async () => {
      created = await result.current.create({ name: "新規" });
    });
    expect(created).toEqual(newFolder);
    expect(result.current.folders[0].id).toBe("new-id");

    // POST の body に name が含まれる
    const call = fetchMock().mock.calls[1];
    expect(call[0]).toBe("/api/folders");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({ name: "新規" });
  });

  it("create 引数なしは空 body で POST", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.folders).toHaveLength(1));

    fetchMock().mockResolvedValue(
      jsonResponse({ ...sampleFolder, id: "new2" }, 201),
    );

    await act(async () => {
      await result.current.create();
    });

    const call = fetchMock().mock.calls[1];
    expect(JSON.parse(call[1].body)).toEqual({});
  });

  it("create 失敗は null を返し error に設定", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.folders).toHaveLength(1));

    fetchMock().mockResolvedValue(jsonResponse({ error: "x" }, 500));
    let created: unknown;
    await act(async () => {
      created = await result.current.create({ name: "失敗" });
    });
    expect(created).toBeNull();
    expect(result.current.error).toMatch(/HTTP 500/);

    // 次に成功すると error がクリアされる
    const newFolder = { ...sampleFolder, id: "recovered", name: "復帰" };
    fetchMock().mockResolvedValue(jsonResponse(newFolder, 201));
    await act(async () => {
      created = await result.current.create({ name: "復帰" });
    });
    expect(result.current.error).toBeNull();
  });
});

describe("useFolders — update", () => {
  it("PATCH で name を更新し一覧に反映", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.folders).toHaveLength(1));

    const renamed = { ...sampleFolder, name: "改名後" };
    fetchMock().mockResolvedValue(jsonResponse(renamed));

    let ok: boolean;
    await act(async () => {
      ok = await result.current.update("folder-1", { name: "改名後" });
    });
    expect(ok!).toBe(true);
    expect(result.current.folders[0].name).toBe("改名後");

    // PATCH の URL と body
    const call = fetchMock().mock.calls[1];
    expect(call[0]).toBe("/api/folders?id=folder-1");
    expect(call[1].method).toBe("PATCH");
    expect(JSON.parse(call[1].body)).toEqual({ name: "改名後" });
  });

  it("memoryScope を更新", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.folders).toHaveLength(1));

    const updated = { ...sampleFolder, memoryScope: "folder" as const };
    fetchMock().mockResolvedValue(jsonResponse(updated));

    await act(async () => {
      await result.current.update("folder-1", { memoryScope: "folder" });
    });
    expect(result.current.folders[0].memoryScope).toBe("folder");
  });

  it("update 失敗後の成功で error がクリアされる", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.folders).toHaveLength(1));

    // まず失敗させて error を設定
    fetchMock().mockResolvedValue(jsonResponse({ error: "x" }, 500));
    let ok: boolean;
    await act(async () => {
      ok = await result.current.update("folder-1", { name: "失敗" });
    });
    expect(ok!).toBe(false);
    expect(result.current.error).toMatch(/HTTP 500/);

    // 次に成功すると error がクリアされる
    const renamed = { ...sampleFolder, name: "復帰" };
    fetchMock().mockResolvedValue(jsonResponse(renamed));
    await act(async () => {
      ok = await result.current.update("folder-1", { name: "復帰" });
    });
    expect(ok!).toBe(true);
    expect(result.current.error).toBeNull();
  });
});

describe("useFolders — remove", () => {
  it("DELETE で一覧から除外", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.folders).toHaveLength(1));

    fetchMock().mockResolvedValue(emptyResponse(204));
    let ok: boolean;
    await act(async () => {
      ok = await result.current.remove("folder-1");
    });
    expect(ok!).toBe(true);
    expect(result.current.folders).toHaveLength(0);

    const call = fetchMock().mock.calls[1];
    expect(call[0]).toBe("/api/folders/folder-1");
    expect(call[1].method).toBe("DELETE");
  });

  it("remove 失敗後の成功で error がクリアされる", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.folders).toHaveLength(1));

    // まず失敗させて error を設定
    fetchMock().mockResolvedValue(jsonResponse({ error: "x" }, 500));
    let ok: boolean;
    await act(async () => {
      ok = await result.current.remove("folder-1");
    });
    expect(ok!).toBe(false);
    expect(result.current.error).toMatch(/HTTP 500/);

    // 次に成功すると error がクリアされる
    fetchMock().mockResolvedValue(emptyResponse(204));
    await act(async () => {
      ok = await result.current.remove("folder-1");
    });
    expect(ok!).toBe(true);
    expect(result.current.error).toBeNull();
  });
});

describe("useFolders — refresh", () => {
  it("refresh で一覧を再取得", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.folders).toHaveLength(1));

    fetchMock().mockResolvedValue(
      jsonResponse([sampleFolder, { ...sampleFolder, id: "second" }]),
    );
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.folders).toHaveLength(2);
  });
});
