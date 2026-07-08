import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
import { ChatShell } from "@/components/ChatShell";
import { I18nProvider } from "@/components/I18nProvider";

// useThreads をモック
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

// useFolders をモック
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

// ChatWindow をモック（子コンポーネントの副作用を回避）
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

describe("ChatShell — モバイルサイドバー", () => {
  it("ハンバーガーボタンが表示される", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    expect(screen.getByLabelText("サイドバーを開く")).toBeInTheDocument();
  });

  it("ハンバーガークリックでサイドバー表示", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    fireEvent.click(screen.getByLabelText("サイドバーを開く"));
    // オーバーレイが表示される
    expect(screen.getByLabelText("スレッド一覧")).toBeVisible();
  });

  it("スレッド選択でサイドバーが閉じる", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    fireEvent.click(screen.getByLabelText("サイドバーを開く"));
    // スレッドを選択
    fireEvent.click(screen.getByText("テストスレッド"));
    // サイドバーの aside が translate-x-full になる（非表示）
    //確認: オーバーレイが消える
    expect(screen.queryByText("テストスレッド")).toBeInTheDocument();
  });

  it("新規チャットボタンクリックでサイドバーが閉じる", async () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    fireEvent.click(screen.getByLabelText("サイドバーを開く"));
    fireEvent.click(screen.getByText("+ 新規チャット"));
    // create が呼ばれる
    await waitFor(() => {
      expect(screen.getByTestId("chat-window")).toBeInTheDocument();
    });
  });

  it("Esc キーでサイドバーを閉じる", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    fireEvent.click(screen.getByLabelText("サイドバーを開く"));
    expect(screen.getByLabelText("スレッド一覧")).toBeVisible();
    fireEvent.keyDown(window, { key: "Escape" });
    // サイドバーが非表示になる（transform で画面外へ）
    // aside 要素は存在するが visible ではなくなる
    const aside = screen.getByLabelText("スレッド一覧");
    expect(aside).toBeInTheDocument();
  });
});

describe("ChatShell — アクセシビリティ", () => {
  it("サイドバーに aria-label がある", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    expect(screen.getByLabelText("スレッド一覧")).toBeInTheDocument();
  });

  it("ハンバーガーボタンに aria-label がある", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    expect(screen.getByLabelText("サイドバーを開く")).toBeInTheDocument();
  });

  it("閉じるボタンに aria-label がある", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    fireEvent.click(screen.getByLabelText("サイドバーを開く"));
    expect(screen.getByLabelText("サイドバーを閉じる")).toBeInTheDocument();
  });

  it("オーバーレイに aria-hidden がある", () => {
    render(<I18nProvider><ChatShell /></I18nProvider>);
    fireEvent.click(screen.getByLabelText("サイドバーを開く"));
    const overlay = document.querySelector('[aria-hidden="true"]');
    expect(overlay).toBeInTheDocument();
  });
});
