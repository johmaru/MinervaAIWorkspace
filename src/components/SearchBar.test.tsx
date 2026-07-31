import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
import { SearchBar, type SearchResult } from "@/components/SearchBar";
import { I18nProvider } from "@/components/I18nProvider";

beforeEach(() => {
  localStorage.setItem("minerva-locale", "ja");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url === "/api/search") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve<{ results: SearchResult[] }>({
              results: [
                {
                  memoryId: "m1",
                  threadId: "t1",
                  threadTitle: "テストスレッド",
                  kind: "fact",
                  content: "ユーザーは日本人",
                  similarity: 0.85,
                },
                {
                  memoryId: "m2",
                  threadId: "t2",
                  threadTitle: "別スレッド",
                  kind: "working",
                  content: "チャット機能を実装中",
                  similarity: 0.72,
                },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderSearchBar(onSelectThread: (id: string) => void) {
  return render(<I18nProvider><SearchBar onSelectThread={onSelectThread} /></I18nProvider>);
}

describe("SearchBar — display", () => {
  it("renders the search input", () => {
    renderSearchBar(vi.fn());
    expect(screen.getByPlaceholderText("🔍 検索…")).toBeInTheDocument();
  });

  it("does not show results on empty input", () => {
    renderSearchBar(vi.fn());
    expect(screen.queryByText("結果なし")).not.toBeInTheDocument();
  });
});

describe("SearchBar — search", () => {
  it("displays search results on input", async () => {
    renderSearchBar(vi.fn());
    const input = screen.getByPlaceholderText("🔍 検索…");
    fireEvent.change(input, { target: { value: "こんにちは" } });

    await waitFor(() => {
      expect(screen.getByText("テストスレッド")).toBeInTheDocument();
      expect(screen.getByText("別スレッド")).toBeInTheDocument();
    });
  });

  it("displays similarity percentage", async () => {
    renderSearchBar(vi.fn());
    fireEvent.change(screen.getByPlaceholderText("🔍 検索…"), {
      target: { value: "テスト" },
    });
    await waitFor(() => {
      expect(screen.getByText("85%")).toBeInTheDocument();
      expect(screen.getByText("72%")).toBeInTheDocument();
    });
  });

  it("calls onSelectThread on result click", async () => {
    const onSelect = vi.fn();
    renderSearchBar(onSelect);
    fireEvent.change(screen.getByPlaceholderText("🔍 検索…"), {
      target: { value: "テスト" },
    });
    await waitFor(() => screen.getByText("テストスレッド"));
    fireEvent.click(screen.getByText("テストスレッド"));
    expect(onSelect).toHaveBeenCalledWith("t1");
  });

  it("clears results when input becomes empty", async () => {
    renderSearchBar(vi.fn());
    const input = screen.getByPlaceholderText("🔍 検索…");
    fireEvent.change(input, { target: { value: "テスト" } });
    await waitFor(() => screen.getByText("テストスレッド"));
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => {
      expect(screen.queryByText("テストスレッド")).not.toBeInTheDocument();
    });
  });
});

describe("SearchBar — web knowledge results", () => {
  it("displays page results in the 🌐 section", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [],
          pages: [
            {
              pageId: "pg1",
              url: "https://example.com/article",
              title: "Example Article",
              content: "This is article content",
              similarity: 0.88,
            },
          ],
        }),
    } as Response);

    renderSearchBar(vi.fn());
    fireEvent.change(screen.getByPlaceholderText("🔍 検索…"), {
      target: { value: "example" },
    });

    await waitFor(() => {
      expect(screen.getByText("Example Article")).toBeInTheDocument();
    });
    expect(screen.getByText("🌐 Web知識")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Example Article/ });
    expect(link).toHaveAttribute("href", "https://example.com/article");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("displays both page results and message results", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              memoryId: "m1",
              threadId: "t1",
              threadTitle: "Thread",
              kind: "fact",
              content: "msg content",
              similarity: 0.7,
            },
          ],
          pages: [
            {
              pageId: "pg1",
              url: "https://example.com",
              title: "Page",
              content: "page content",
              similarity: 0.9,
            },
          ],
        }),
    } as Response);

    renderSearchBar(vi.fn());
    fireEvent.change(screen.getByPlaceholderText("🔍 検索…"), {
      target: { value: "test" },
    });

    await waitFor(() => {
      expect(screen.getByText("Page")).toBeInTheDocument();
      expect(screen.getByText("Thread")).toBeInTheDocument();
    });
  });
});
