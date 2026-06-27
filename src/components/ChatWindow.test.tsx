import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/hooks/useChat";
import { ChatWindow } from "@/components/ChatWindow";
import { I18nProvider } from "@/components/I18nProvider";

// ChatWindow は useChat(threadId) に直接依存しているため、モックで決定的な状態を注入する。
// 実 API / SSE / DB の挙動は route.test.ts / useChat.test.ts で担保済み。

type UseChatReturn = {
  messages: ChatMessage[];
  thread: {
    id: string;
    title: string;
    systemPrompt: string | null;
    model: string;
    currentLeafId: string | null;
    responseMode: "single" | "dual";
    dualModelA: string | null;
    dualModelB: string | null;
    dualStrategy: "cross_review" | "debate";
    dualDebateRounds: number;
    globalInstructionId: string | null;
  } | null;
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  sources: { url: string; title: string; snippet: string }[];
  send: (input: string, opts?: { systemPrompt?: string; model?: string; attachmentIds?: string[]; rapid?: boolean; timeRange?: "day" | "week" | "month" | "year" }) => Promise<void>;
  stop: () => void;
  clear: () => void;
  updateThread: (patch: {
    systemPrompt?: string | null;
    model?: string;
    responseMode?: "single" | "dual";
    dualModelA?: string | null;
    dualModelB?: string | null;
    dualStrategy?: "cross_review" | "debate";
    dualDebateRounds?: number;
    globalInstructionId?: string | null;
  }) => Promise<void>;
  regenerate: (userMessageId: string) => Promise<void>;
  editMessage: (userMessageId: string, newContent: string) => Promise<void>;
  switchBranch: (messageId: string) => void;
  getSiblingInfo: (messageId: string) => { siblings: string[]; currentIndex: number };
  pendingAttachments: never[];
  uploadAttachment: (file: File) => Promise<unknown>;
  removeAttachment: (id: string) => void;
  rapid: boolean;
  setRapid: (v: boolean | ((prev: boolean) => boolean)) => void;
  timeRange: "day" | "week" | "month" | "year" | null;
  setTimeRange: (v: "day" | "week" | "month" | "year" | null) => void;
};

let mockState: UseChatReturn;

function mockThread(overrides: Partial<NonNullable<UseChatReturn["thread"]>> = {}): NonNullable<UseChatReturn["thread"]> {
  return {
    id: "t1",
    title: "x",
    systemPrompt: null,
    model: "gpt-4o-mini",
    currentLeafId: null,
    responseMode: "single",
    dualModelA: null,
    dualModelB: null,
    globalInstructionId: null,
    dualStrategy: "cross_review",
    dualDebateRounds: 2,
    ...overrides,
  };
}

vi.mock("@/hooks/useChat", () => ({
  useChat: (_threadId: string | null) => {
    void _threadId;
    return mockState;
  },
}));

vi.mock("@/components/ThreadSettings", () => ({
  ThreadSettings: () => null,
}));

beforeEach(() => {
  localStorage.setItem("umanschat-locale", "ja");
  mockState = {
    messages: [],
    thread: null,
    isStreaming: false,
    isLoading: false,
    error: null,
    sources: [],
    send: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
    updateThread: vi.fn(),
    regenerate: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    switchBranch: vi.fn(),
    getSiblingInfo: vi.fn().mockReturnValue({ siblings: [], currentIndex: 0 }),
    pendingAttachments: [],
    uploadAttachment: vi.fn().mockResolvedValue(null),
    removeAttachment: vi.fn(),
    rapid: false,
    setRapid: vi.fn(),
    timeRange: null,
    setTimeRange: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChatWindow — threadId がない状態", () => {
  it("NoThreadState を表示", () => {
    render(<I18nProvider><ChatWindow threadId={null} /></I18nProvider>);
    expect(
      screen.getByText("メッセージを送って、新しいスレッドを始めてください。"),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Enter で送信/)).toBeInTheDocument();
  });

  it("入力すると送信ボタンが有効化", () => {
    render(<I18nProvider><ChatWindow threadId={null} /></I18nProvider>);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    expect(screen.getByRole("button", { name: "メッセージを送信" })).not.toBeDisabled();
  });

  it("送信すると onCreateThread が呼ばれ、threadId 切替後に send する", async () => {
    const onCreateThread = vi.fn().mockResolvedValue("t-new");
    const send = vi.fn().mockResolvedValue(undefined);
    mockState.send = send;
    const { rerender } = render(<I18nProvider><ChatWindow threadId={null} onCreateThread={onCreateThread} /></I18nProvider>);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "メッセージを送信" }));
    await waitFor(() => expect(onCreateThread).toHaveBeenCalled());
    rerender(<I18nProvider><ChatWindow threadId="t-new" onCreateThread={onCreateThread} /></I18nProvider>);
    await waitFor(() => expect(send).toHaveBeenCalledWith("hello"));
  });

  it("onCreateThread が失敗すると send は呼ばれない", async () => {
    const onCreateThread = vi.fn().mockResolvedValue(null);
    const send = vi.fn().mockResolvedValue(undefined);
    mockState.send = send;
    render(<I18nProvider><ChatWindow threadId={null} onCreateThread={onCreateThread} /></I18nProvider>);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "メッセージを送信" }));
    await waitFor(() => expect(onCreateThread).toHaveBeenCalled());
    expect(send).not.toHaveBeenCalled();
    expect(ta.value).toBe("hello");
  });
});

describe("ChatWindow — 空状態（threadId あり）", () => {
  it("メッセージ0件のとき EmptyState を表示", () => {
    mockState.thread = mockThread();
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(
      screen.getByText("メッセージを送って会話を始めてください。"),
    ).toBeInTheDocument();
  });

  it("プレースホルダと送信ボタンを表示", () => {
    mockState.thread = mockThread();
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByPlaceholderText(/Enter で送信/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "メッセージを送信" })).toBeDisabled();
  });

  it("isLoading 中は読み込み中表示", () => {
    mockState.isLoading = true;
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText("読み込み中…")).toBeInTheDocument();
  });
});

describe("ChatWindow — 送信操作", () => {
  beforeEach(() => {
    mockState.thread = mockThread();
  });

  it("入力すると送信ボタンが有効化", () => {
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    expect(screen.getByRole("button", { name: "メッセージを送信" })).not.toBeDisabled();
  });

  it("送信ボタン押下で send を呼び入力をクリア", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mockState.send = send;
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "メッセージを送信" }));
    expect(send).toHaveBeenCalledWith("hello", { attachmentIds: [] });
    expect(ta.value).toBe("");
  });

  it("Enter で送信、Shift+Enter は改行", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mockState.send = send;
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });

    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled();

    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    expect(send).toHaveBeenCalledWith("hello", { attachmentIds: [] });
  });

  it("onConversationEnded は送信完了後に呼ばれる", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mockState.send = send;
    const onEnded = vi.fn();
    render(<I18nProvider><ChatWindow threadId="t1" onConversationEnded={onEnded} /></I18nProvider>);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "メッセージを送信" }));
    // send の .then で呼ばれるので microtask 待ち
    await Promise.resolve();
    await Promise.resolve();
    expect(onEnded).toHaveBeenCalled();
  });
});

describe("ChatWindow — ストリーミング状態", () => {
  beforeEach(() => {
    mockState.thread = mockThread();
  });

  it("isStreaming 時は停止ボタンに切替", () => {
    const stop = vi.fn();
    mockState.isStreaming = true;
    mockState.stop = stop;
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByRole("button", { name: "生成を停止" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "メッセージを送信" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "生成を停止" }));
    expect(stop).toHaveBeenCalled();
  });

  it("assistant の空バブルはスピナーと待機ラベルを表示", () => {
    mockState.isStreaming = true;
    mockState.messages = [
      { id: "u1", role: "user", content: "hi", parentId: null },
      { id: "a1", role: "assistant", content: "", parentId: null },
    ];
    const { container } = render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText(/応答を待っています/)).toBeInTheDocument();
    // reduce 環境でも回転を維持するための復元クラスが付与されていること
    expect(container.querySelector(".loading-spinner")).toBeInTheDocument();
  });

  it("thinking 受信中も statusLabel があれば進捗ラベルとスピナーを表示", () => {
    mockState.isStreaming = true;
    mockState.messages = [
      { id: "u1", role: "user", content: "hi", parentId: null },
      { id: "a1", role: "assistant", content: "", thinking: "推論中…", statusLabel: "考え中…", parentId: null },
    ];
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText("考え中…")).toBeInTheDocument();
    // スピナー（aria-label="応答を待っています"）は thinking ありでは出ない
    expect(screen.queryByLabelText("応答を待っています")).not.toBeInTheDocument();
  });
});

describe("ChatWindow — メッセージ描画", () => {
  beforeEach(() => {
    mockState.thread = mockThread();
  });

  it("user / assistant の内容を描画", () => {
    mockState.messages = [
      { id: "u1", role: "user", content: "こんにちは", parentId: null },
      { id: "a1", role: "assistant", content: "どうも", parentId: null },
    ];
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText("こんにちは")).toBeInTheDocument();
    expect(screen.getByText("どうも")).toBeInTheDocument();
  });

  it("assistant の thinking 部分は折りたためる思考ブロック内に表示", () => {
    mockState.messages = [
      { id: "a1", role: "assistant", content: "<thinking>We need answer greeting in Japanese.</thinking>\nこんにちは！お元気ですか？", parentId: null },
    ];
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText("We need answer greeting in Japanese.")).toBeInTheDocument();
    expect(screen.getByText("こんにちは！お元気ですか？")).toBeInTheDocument();
    const thinking = screen.getByText("We need answer greeting in Japanese.").closest("details");
    expect(thinking).toBeInTheDocument();
    expect(thinking).not.toHaveAttribute("open");
  });

  it("thinking フィールドがあるとき折りたたみ思考ブロックとして表示", () => {
    mockState.messages = [
      {
        id: "a2",
        role: "assistant",
        content: "こんにちは！お元気ですか？",
        thinking: "User said こんにちは. Respond friendly in Japanese.",
        parentId: null,
      },
    ];
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText("User said こんにちは. Respond friendly in Japanese.")).toBeInTheDocument();
    expect(screen.getByText("こんにちは！お元気ですか？")).toBeInTheDocument();
    const thinking = screen.getByText("User said こんにちは. Respond friendly in Japanese.").closest("details");
    expect(thinking).toBeInTheDocument();
    expect(thinking).not.toHaveAttribute("open");
  });

  it("デュアルモデル詳細を折りたたみで表示", () => {
    mockState.messages = [
      {
        id: "a-dual",
        role: "assistant",
        content: "統合結論です。",
        parentId: null,
        metadata: {
          dualTrace: {
            strategy: "cross_review",
            modelA: "model-a",
            modelB: "model-b",
            finalModel: "final-model",
            answerA: "Aの回答",
            answerB: "Bの回答",
            reviewA: "Aのレビュー",
            reviewB: "Bのレビュー",
          },
        },
      },
    ];
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText("統合結論です。")).toBeInTheDocument();
    expect(screen.getByText("デュアルモデル詳細")).toBeInTheDocument();
    expect(screen.getByText("Aの回答")).toBeInTheDocument();
    expect(screen.getByText("Bのレビュー")).toBeInTheDocument();
  });

  it("error があるときエラー文を表示", () => {
    mockState.error = "boom";
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
});
