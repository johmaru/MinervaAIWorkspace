import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
import type { ChatMessage } from "@/hooks/useChat";
import { ChatWindow } from "@/components/ChatWindow";
import { I18nProvider } from "@/components/I18nProvider";

// ChatWindow depends directly on useChat(threadId), so we inject deterministic state via mock.
// Real API / SSE / DB behavior is covered by route.test.ts / useChat.test.ts.

type UseChatReturn = {
  messages: ChatMessage[];
  thread: {
    id: string;
    title: string;
    systemPrompt: string | null;
    model: string;
    currentLeafId: string | null;
    responseMode: "single" | "dual" | "hyper" | "council";
    dualModelA: string | null;
    dualModelB: string | null;
    dualStrategy: "cross_review" | "debate";
    dualDebateRounds: number;
    hyperRounds: number;
    councilSize: number;
    councilTimeLimit: number;
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
    responseMode?: "single" | "dual" | "hyper" | "council";
    dualModelA?: string | null;
    dualModelB?: string | null;
    dualStrategy?: "cross_review" | "debate";
    dualDebateRounds?: number;
    globalInstructionId?: string | null;
    hyperRounds?: number;
    councilSize?: number;
    councilTimeLimit?: number;
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
    hyperRounds: 3,
    councilSize: 3,
    councilTimeLimit: 60,
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

describe("ChatWindow — no threadId state", () => {
  it("renders NoThreadState", () => {
    render(<I18nProvider><ChatWindow threadId={null} /></I18nProvider>);
    expect(
      screen.getByText("メッセージを送って、新しいスレッドを始めてください。"),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Enter で送信/)).toBeInTheDocument();
  });

  it("enables the send button on input", () => {
    render(<I18nProvider><ChatWindow threadId={null} /></I18nProvider>);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    expect(screen.getByRole("button", { name: "メッセージを送信" })).not.toBeDisabled();
  });

  it("calls onCreateThread on send, then sends after threadId switches", async () => {
    const onCreateThread = vi.fn().mockResolvedValue("t-new");
    const send = vi.fn().mockResolvedValue(undefined);
    mockState.send = send;
    const { rerender } = render(<I18nProvider><ChatWindow threadId={null} onCreateThread={onCreateThread} /></I18nProvider>);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "メッセージを送信" }));
    await waitFor(() => expect(onCreateThread).toHaveBeenCalled());
    mockState.thread = mockThread({ id: "t-new" });
    rerender(<I18nProvider><ChatWindow threadId="t-new" onCreateThread={onCreateThread} /></I18nProvider>);
    await waitFor(() => expect(send).toHaveBeenCalledWith("hello", {}));
  });

  it("does not call send when onCreateThread fails", async () => {
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

describe("ChatWindow — empty state (with threadId)", () => {
  it("renders EmptyState when there are no messages", () => {
    mockState.thread = mockThread();
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(
      screen.getByText("メッセージを送って会話を始めてください。"),
    ).toBeInTheDocument();
  });

  it("renders placeholder and send button", () => {
    mockState.thread = mockThread();
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByPlaceholderText(/Enter で送信/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "メッセージを送信" })).toBeDisabled();
  });

  it("shows loading indicator while isLoading", () => {
    mockState.isLoading = true;
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText("読み込み中…")).toBeInTheDocument();
  });
});

describe("ChatWindow — send operations", () => {
  beforeEach(() => {
    mockState.thread = mockThread();
  });

  it("enables the send button on input", () => {
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    expect(screen.getByRole("button", { name: "メッセージを送信" })).not.toBeDisabled();
  });

  it("calls send on button click and clears input", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mockState.send = send;
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "メッセージを送信" }));
    expect(send).toHaveBeenCalledWith("hello", { attachmentIds: [] });
    expect(ta.value).toBe("");
  });

  it("sends on Enter, inserts newline on Shift+Enter", () => {
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

  it("calls onConversationEnded after send completes", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mockState.send = send;
    const onEnded = vi.fn();
    render(<I18nProvider><ChatWindow threadId="t1" onConversationEnded={onEnded} /></I18nProvider>);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "メッセージを送信" }));
    // Called in send's .then, so wait a microtask
    await Promise.resolve();
    await Promise.resolve();
    expect(onEnded).toHaveBeenCalled();
  });
});

describe("ChatWindow — streaming state", () => {
  beforeEach(() => {
    mockState.thread = mockThread();
  });

  it("switches to stop button when isStreaming", () => {
    const stop = vi.fn();
    mockState.isStreaming = true;
    mockState.stop = stop;
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByRole("button", { name: "生成を停止" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "メッセージを送信" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "生成を停止" }));
    expect(stop).toHaveBeenCalled();
  });

  it("shows spinner and waiting label for empty assistant bubble", () => {
    mockState.isStreaming = true;
    mockState.messages = [
      { id: "u1", role: "user", content: "hi", parentId: null },
      { id: "a1", role: "assistant", content: "", parentId: null },
    ];
    const { container } = render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText(/応答を待っています/)).toBeInTheDocument();
    // A restore class is applied to maintain rotation even in reduced-motion environments
    expect(container.querySelector(".loading-spinner")).toBeInTheDocument();
  });

  it("shows progress label and spinner while thinking is received if statusLabel exists", () => {
    mockState.isStreaming = true;
    mockState.messages = [
      { id: "u1", role: "user", content: "hi", parentId: null },
      { id: "a1", role: "assistant", content: "", thinking: "推論中…", statusLabel: "考え中…", parentId: null },
    ];
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText("考え中…")).toBeInTheDocument();
    // Spinner (aria-label="waiting for response") is not shown when thinking exists
    expect(screen.queryByLabelText("応答を待っています")).not.toBeInTheDocument();
  });
});

describe("ChatWindow — message rendering", () => {
  beforeEach(() => {
    mockState.thread = mockThread();
  });

  it("renders user / assistant content", () => {
    mockState.messages = [
      { id: "u1", role: "user", content: "こんにちは", parentId: null },
      { id: "a1", role: "assistant", content: "どうも", parentId: null },
    ];
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText("こんにちは")).toBeInTheDocument();
    expect(screen.getByText("どうも")).toBeInTheDocument();
  });

  it("renders assistant thinking inside a collapsible thinking block", async () => {
    mockState.messages = [
      { id: "a1", role: "assistant", content: "<thinking>We need answer greeting in Japanese.</thinking>\nこんにちは！お元気ですか？", parentId: null },
    ];
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText("こんにちは！お元気ですか？")).toBeInTheDocument();
    // Accordion mounts in closed state, so click to open.
    const thinkingBtn = screen.getByRole("button", { name: "思考" });
    fireEvent.click(thinkingBtn);
    await waitFor(() => {
      expect(screen.getByText("We need answer greeting in Japanese.")).toBeInTheDocument();
    });
    const region = screen.getByLabelText("思考内容");
    expect(region).toBeInTheDocument();
  });

  it("renders thinking field as a collapsible thinking block", async () => {
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
    expect(screen.getByText("こんにちは！お元気ですか？")).toBeInTheDocument();
    // Accordion mounts in closed state, so click to open.
    const thinkingBtn = screen.getByRole("button", { name: "思考" });
    fireEvent.click(thinkingBtn);
    await waitFor(() => {
      expect(screen.getByText("User said こんにちは. Respond friendly in Japanese.")).toBeInTheDocument();
    });
    const region = screen.getByLabelText("思考内容");
    expect(region).toBeInTheDocument();
  });

  it("renders dual model details in a collapsible block", async () => {
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
    // Accordion mounts in closed state, so click to open.
    const dualBtn = screen.getByRole("button", { name: "デュアルモデル詳細" });
    fireEvent.click(dualBtn);
    await waitFor(() => {
      expect(screen.getByText("Aの回答")).toBeInTheDocument();
      expect(screen.getByText("Bのレビュー")).toBeInTheDocument();
    });
  });

  it("displays error text when error is present", () => {
    mockState.error = "boom";
    render(<I18nProvider><ChatWindow threadId="t1" /></I18nProvider>);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
});
