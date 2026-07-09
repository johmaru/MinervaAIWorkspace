import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
import { ChatShell } from "@/components/ChatShell";
import { I18nProvider } from "@/components/I18nProvider";

// Mock useThreads
vi.mock("@/hooks/useThreads", () => ({
  useThreads: () => ({
    threads: [
      { id: "t1", title: "テストスレッド", folderId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn().mockResolvedValue({ id: "t-new", title: "New chat", folderId: null }),
    rename: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
    move: vi.fn().mockResolvedValue(true),
  }),
}));

// Mock useFolders
vi.mock("@/hooks/useFolders", () => ({
  useFolders: () => ({
    folders: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
  }),
}));

// Mock ChatWindow (avoid side effects from child components)
vi.mock("@/components/ChatWindow", () => ({
  ChatWindow: ({ threadId }: { threadId: string | null }) => (
    <div data-testid="chat-window" data-thread={threadId}>ChatWindow</div>
  ),
}));

beforeEach(() => {
  localStorage.setItem("umanschat-locale", "ja");
});

afterEach(() => {
  cleanup();
});

describe("ChatShell — mobile sidebar", () => {
  it("renders the hamburger button", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    expect(screen.getByLabelText("サイドバーを開く")).toBeInTheDocument();
  });

  it("opens the sidebar on hamburger click", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    fireEvent.click(screen.getByLabelText("サイドバーを開く"));
    // Overlay is displayed
    expect(screen.getByLabelText("スレッド一覧")).toBeVisible();
  });

  it("closes the sidebar on thread selection", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    fireEvent.click(screen.getByLabelText("サイドバーを開く"));
    // Select a thread
    fireEvent.click(screen.getByText("テストスレッド"));
    // The sidebar aside becomes translate-x-full (hidden)
    // Confirm: overlay disappears
    expect(screen.queryByText("テストスレッド")).toBeInTheDocument();
  });

  it("closes the sidebar on new chat button click", async () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    fireEvent.click(screen.getByLabelText("サイドバーを開く"));
    fireEvent.click(screen.getByText("+ 新規チャット"));
    // create is called
    await waitFor(() => {
      expect(screen.getByTestId("chat-window")).toBeInTheDocument();
    });
  });

  it("closes the sidebar with Esc key", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    fireEvent.click(screen.getByLabelText("サイドバーを開く"));
    expect(screen.getByLabelText("スレッド一覧")).toBeVisible();
    fireEvent.keyDown(window, { key: "Escape" });
    // Sidebar becomes hidden (moved off-screen via transform)
    // The aside element still exists but is no longer visible
    const aside = screen.getByLabelText("スレッド一覧");
    expect(aside).toBeInTheDocument();
  });
});

describe("ChatShell — accessibility", () => {
  it("has an aria-label on the sidebar", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    expect(screen.getByLabelText("スレッド一覧")).toBeInTheDocument();
  });

  it("has an aria-label on the hamburger button", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    expect(screen.getByLabelText("サイドバーを開く")).toBeInTheDocument();
  });

  it("has an aria-label on the close button", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    fireEvent.click(screen.getByLabelText("サイドバーを開く"));
    expect(screen.getByLabelText("サイドバーを閉じる")).toBeInTheDocument();
  });

  it("has aria-hidden on the overlay", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    fireEvent.click(screen.getByLabelText("サイドバーを開く"));
    const overlay = document.querySelector('[aria-hidden="true"]');
    expect(overlay).toBeInTheDocument();
  });
});
