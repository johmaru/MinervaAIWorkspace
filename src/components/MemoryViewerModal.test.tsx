import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryViewerModal } from "@/components/MemoryViewerModal";
import { I18nProvider } from "@/components/I18nProvider";

// /api/memories, /api/threads の fetch をモック
const mockMemories = [
  {
    id: "m1",
    threadId: "t1",
    threadTitle: "Test thread",
    kind: "fact" as const,
    content: "User likes tea",
    importance: 0.8,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "m2",
    threadId: "t1",
    threadTitle: "Test thread",
    kind: "working" as const,
    content: "Working on memory viewer",
    importance: 0.5,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

const mockThreads = [{ id: "t1", title: "Test thread" }];

beforeEach(() => {
  localStorage.setItem("umanschat-locale", "ja");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url === "/api/memories") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockMemories),
        });
      }
      if (url === "/api/threads") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockThreads),
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

function renderModal(open = true) {
  const onClose = vi.fn();
  return {
    onClose,
    ...render(
      <I18nProvider>
        <MemoryViewerModal open={open} onClose={onClose} />
      </I18nProvider>,
    ),
  };
}

describe("MemoryViewerModal", () => {
  it("閉じている時は内容が表示されない", () => {
    renderModal(false);
    expect(screen.queryByText("User likes tea")).not.toBeInTheDocument();
  });

  it("開くとメモリ一覧が表示される", async () => {
    renderModal(true);
    await waitFor(() => {
      expect(screen.getByText("User likes tea")).toBeInTheDocument();
      expect(screen.getByText("Working on memory viewer")).toBeInTheDocument();
    });
  });

  it("検索でフィルタされる", async () => {
    renderModal(true);
    await waitFor(() => {
      expect(screen.getByText("User likes tea")).toBeInTheDocument();
    });
    const search = screen.getByPlaceholderText("検索...");
    fireEvent.change(search, { target: { value: "tea" } });
    expect(screen.getByText("User likes tea")).toBeInTheDocument();
    expect(screen.queryByText("Working on memory viewer")).not.toBeInTheDocument();
  });

  it("fact フィルタで fact のみ表示", async () => {
    renderModal(true);
    await waitFor(() => {
      expect(screen.getByText("User likes tea")).toBeInTheDocument();
    });
    // フィルタ select を "fact" に変更
    const select = screen.getAllByRole("combobox")[0];
    fireEvent.change(select, { target: { value: "fact" } });
    expect(screen.getByText("User likes tea")).toBeInTheDocument();
    expect(screen.queryByText("Working on memory viewer")).not.toBeInTheDocument();
  });

  it("working フィルタで working のみ表示", async () => {
    renderModal(true);
    await waitFor(() => {
      expect(screen.getByText("Working on memory viewer")).toBeInTheDocument();
    });
    const select = screen.getAllByRole("combobox")[0];
    fireEvent.change(select, { target: { value: "working" } });
    expect(screen.queryByText("User likes tea")).not.toBeInTheDocument();
    expect(screen.getByText("Working on memory viewer")).toBeInTheDocument();
  });
});
