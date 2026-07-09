import { act, renderHook as rtlRenderHook, waitFor } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
import { createElement, type ReactNode } from "react";
import { useFolders } from "@/hooks/useFolders";
import { I18nProvider } from "@/components/I18nProvider";

const wrapper = ({ children }: { children: ReactNode }) => createElement(I18nProvider, null, children);
function renderHook<T>(callback: () => T) {
  return rtlRenderHook(callback, { wrapper });
}

// useFolders calls CRUD on /api/folders. Mock fetch to return deterministic responses.

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

describe("useFolders — initial load", () => {
  it("calls GET /api/folders on mount", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock()).toHaveBeenCalledWith("/api/folders", undefined);
    expect(result.current.folders).toHaveLength(1);
    expect(result.current.folders[0].name).toBe("仕事");
  });

  it("sets error on load failure", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ error: "x" }, 500));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toMatch(/HTTP 500/);
  });
});

describe("useFolders — create", () => {
  it("creates a new folder via POST and inserts it at the top", async () => {
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

    // POST body includes name
    const call = fetchMock().mock.calls[1];
    expect(call[0]).toBe("/api/folders");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({ name: "新規" });
  });

  it("create with no arguments sends empty body via POST", async () => {
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

  it("create failure returns null and sets error", async () => {
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

    // Subsequent success clears error
    const newFolder = { ...sampleFolder, id: "recovered", name: "復帰" };
    fetchMock().mockResolvedValue(jsonResponse(newFolder, 201));
    await act(async () => {
      created = await result.current.create({ name: "復帰" });
    });
    expect(result.current.error).toBeNull();
  });
});

describe("useFolders — update", () => {
  it("updates name via PATCH and reflects in the list", async () => {
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

    // PATCH URL and body
    const call = fetchMock().mock.calls[1];
    expect(call[0]).toBe("/api/folders?id=folder-1");
    expect(call[1].method).toBe("PATCH");
    expect(JSON.parse(call[1].body)).toEqual({ name: "改名後" });
  });

  it("updates memoryScope", async () => {
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

  it("clears error on success after update failure", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.folders).toHaveLength(1));

    // First fail to set error
    fetchMock().mockResolvedValue(jsonResponse({ error: "x" }, 500));
    let ok: boolean;
    await act(async () => {
      ok = await result.current.update("folder-1", { name: "失敗" });
    });
    expect(ok!).toBe(false);
    expect(result.current.error).toMatch(/HTTP 500/);

    // Subsequent success clears error
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
  it("removes from the list via DELETE", async () => {
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

  it("clears error on success after remove failure", async () => {
    fetchMock().mockResolvedValue(jsonResponse([sampleFolder]));
    const { result } = renderHook(() => useFolders());
    await waitFor(() => expect(result.current.folders).toHaveLength(1));

    // First fail to set error
    fetchMock().mockResolvedValue(jsonResponse({ error: "x" }, 500));
    let ok: boolean;
    await act(async () => {
      ok = await result.current.remove("folder-1");
    });
    expect(ok!).toBe(false);
    expect(result.current.error).toMatch(/HTTP 500/);

    // Subsequent success clears error
    fetchMock().mockResolvedValue(emptyResponse(204));
    await act(async () => {
      ok = await result.current.remove("folder-1");
    });
    expect(ok!).toBe(true);
    expect(result.current.error).toBeNull();
  });
});

describe("useFolders — refresh", () => {
  it("re-fetches the list on refresh", async () => {
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
