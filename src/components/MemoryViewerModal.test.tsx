import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryViewerModal } from "@/components/MemoryViewerModal";
import { I18nProvider } from "@/components/I18nProvider";

// Mock fetch for /api/memories, /api/threads
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
  localStorage.setItem("minerva-locale", "ja");
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
  it("does not display content when closed", () => {
    renderModal(false);
    expect(screen.queryByText("User likes tea")).not.toBeInTheDocument();
  });

  it("displays memory list when opened", async () => {
    renderModal(true);
    await waitFor(() => {
      expect(screen.getByText("User likes tea")).toBeInTheDocument();
      expect(screen.getByText("Working on memory viewer")).toBeInTheDocument();
    });
  });

  it("filters by search", async () => {
    renderModal(true);
    await waitFor(() => {
      expect(screen.getByText("User likes tea")).toBeInTheDocument();
    });
    const search = screen.getByPlaceholderText("検索...");
    fireEvent.change(search, { target: { value: "tea" } });
    expect(screen.getByText("User likes tea")).toBeInTheDocument();
    expect(screen.queryByText("Working on memory viewer")).not.toBeInTheDocument();
  });

  it("fact filter shows only fact entries", async () => {
    renderModal(true);
    await waitFor(() => {
      expect(screen.getByText("User likes tea")).toBeInTheDocument();
    });
    // Change filter select to "fact"
    const select = screen.getAllByRole("combobox")[0];
    fireEvent.change(select, { target: { value: "fact" } });
    expect(screen.getByText("User likes tea")).toBeInTheDocument();
    expect(screen.queryByText("Working on memory viewer")).not.toBeInTheDocument();
  });

  it("working filter shows only working entries", async () => {
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
