import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/hooks/useChat";
import { ChatWindow } from "@/components/ChatWindow";

// ChatWindow は useChat(threadId) に直接依存しているため、モックで決定的な状態を注入する。
// 実 API / SSE / DB の挙動は route.test.ts / useChat.test.ts で担保済み。

type UseChatReturn = {
  messages: ChatMessage[];
  thread: { id: string; title: string; systemPrompt: string | null; model: string } | null;
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  send: (input: string, opts?: { systemPrompt?: string; model?: string }) => Promise<void>;
  stop: () => void;
  clear: () => void;
};

let mockState: UseChatReturn;

vi.mock("@/hooks/useChat", () => ({
  useChat: (_threadId: string | null) => {
    void _threadId;
    return mockState;
  },
}));

beforeEach(() => {
  mockState = {
    messages: [],
    thread: null,
    isStreaming: false,
    isLoading: false,
    error: null,
    send: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChatWindow — threadId がない状態", () => {
  it("NoThreadState を表示", () => {
    render(<ChatWindow threadId={null} />);
    expect(
      screen.getByText("左の「+ 新規チャット」からスレッドを作成してください。"),
    ).toBeInTheDocument();
  });
});

describe("ChatWindow — 空状態（threadId あり）", () => {
  it("メッセージ0件のとき EmptyState を表示", () => {
    mockState.thread = { id: "t1", title: "x", systemPrompt: null, model: "gpt-4o-mini" };
    render(<ChatWindow threadId="t1" />);
    expect(
      screen.getByText("メッセージを送って会話を始めてください。"),
    ).toBeInTheDocument();
  });

  it("プレースホルダと送信ボタンを表示", () => {
    mockState.thread = { id: "t1", title: "x", systemPrompt: null, model: "gpt-4o-mini" };
    render(<ChatWindow threadId="t1" />);
    expect(screen.getByPlaceholderText(/Enter で送信/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });

  it("isLoading 中は読み込み中表示", () => {
    mockState.isLoading = true;
    render(<ChatWindow threadId="t1" />);
    expect(screen.getByText("読み込み中…")).toBeInTheDocument();
  });
});

describe("ChatWindow — 送信操作", () => {
  beforeEach(() => {
    mockState.thread = { id: "t1", title: "x", systemPrompt: null, model: "gpt-4o-mini" };
  });

  it("入力すると送信ボタンが有効化", () => {
    render(<ChatWindow threadId="t1" />);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    expect(screen.getByRole("button", { name: "送信" })).not.toBeDisabled();
  });

  it("送信ボタン押下で send を呼び入力をクリア", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mockState.send = send;
    render(<ChatWindow threadId="t1" />);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(send).toHaveBeenCalledWith("hello");
    expect(ta.value).toBe("");
  });

  it("Enter で送信、Shift+Enter は改行", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mockState.send = send;
    render(<ChatWindow threadId="t1" />);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });

    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled();

    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    expect(send).toHaveBeenCalledWith("hello");
  });

  it("onConversationEnded は送信完了後に呼ばれる", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mockState.send = send;
    const onEnded = vi.fn();
    render(<ChatWindow threadId="t1" onConversationEnded={onEnded} />);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    // send の .then で呼ばれるので microtask 待ち
    await Promise.resolve();
    await Promise.resolve();
    expect(onEnded).toHaveBeenCalled();
  });
});

describe("ChatWindow — ストリーミング状態", () => {
  beforeEach(() => {
    mockState.thread = { id: "t1", title: "x", systemPrompt: null, model: "gpt-4o-mini" };
  });

  it("isStreaming 時は停止ボタンに切替", () => {
    const stop = vi.fn();
    mockState.isStreaming = true;
    mockState.stop = stop;
    render(<ChatWindow threadId="t1" />);
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "送信" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(stop).toHaveBeenCalled();
  });

  it("assistant の空バブルは「…」で待機表示", () => {
    mockState.isStreaming = true;
    mockState.messages = [
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "" },
    ];
    render(<ChatWindow threadId="t1" />);
    expect(screen.getByText("…")).toBeInTheDocument();
  });
});

describe("ChatWindow — メッセージ描画", () => {
  beforeEach(() => {
    mockState.thread = { id: "t1", title: "x", systemPrompt: null, model: "gpt-4o-mini" };
  });

  it("user / assistant の内容を描画", () => {
    mockState.messages = [
      { id: "u1", role: "user", content: "こんにちは" },
      { id: "a1", role: "assistant", content: "どうも" },
    ];
    render(<ChatWindow threadId="t1" />);
    expect(screen.getByText("こんにちは")).toBeInTheDocument();
    expect(screen.getByText("どうも")).toBeInTheDocument();
  });

  it("error があるときエラー文を表示", () => {
    mockState.error = "boom";
    render(<ChatWindow threadId="t1" />);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
});
