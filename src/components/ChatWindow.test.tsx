import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/hooks/useChat";
import { ChatWindow } from "@/components/ChatWindow";

// ChatWindow は useChat に直接依存しているため、モックで決定的な状態を注入する。
// 実 API / SSE の挙動は route.test.ts / useChat.test.ts で担保済み。

type UseChatReturn = {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  send: (input: string, opts?: { systemPrompt?: string; model?: string }) => Promise<void>;
  stop: () => void;
  clear: () => void;
};

let mockState: UseChatReturn;

vi.mock("@/hooks/useChat", () => ({
  useChat: () => mockState,
}));

beforeEach(() => {
  mockState = {
    messages: [],
    isStreaming: false,
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

describe("ChatWindow — 空状態", () => {
  it("メッセージ0件のとき EmptyState を表示", () => {
    render(<ChatWindow />);
    expect(
      screen.getByText("メッセージを送って会話を始めてください。"),
    ).toBeInTheDocument();
  });

  it("プレースホルダと送信ボタンを表示", () => {
    render(<ChatWindow />);
    expect(
      screen.getByPlaceholderText(/Enter で送信/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });
});

describe("ChatWindow — 送信操作", () => {
  it("入力すると送信ボタンが有効化", () => {
    render(<ChatWindow />);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    expect(screen.getByRole("button", { name: "送信" })).not.toBeDisabled();
  });

  it("送信ボタン押下で send を呼び入力をクリア", () => {
    const send = vi.fn();
    mockState.send = send;
    render(<ChatWindow />);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(send).toHaveBeenCalledWith("hello");
    expect(ta.value).toBe("");
  });

  it("Enter で送信、Shift+Enter は改行", () => {
    const send = vi.fn();
    mockState.send = send;
    render(<ChatWindow />);
    const ta = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });

    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled();

    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    expect(send).toHaveBeenCalledWith("hello");
  });

  it("空入力は送信しない", () => {
    const send = vi.fn();
    mockState.send = send;
    render(<ChatWindow />);
    // ボタンが disabled なのでクリック不可だが、直接 submit 経由を弾く念のため
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(send).not.toHaveBeenCalled();
  });
});

describe("ChatWindow — ストリーミング状態", () => {
  it("isStreaming 時は停止ボタンに切替", () => {
    const stop = vi.fn();
    mockState.isStreaming = true;
    mockState.stop = stop;
    render(<ChatWindow />);
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
    render(<ChatWindow />);
    expect(screen.getByText("…")).toBeInTheDocument();
  });
});

describe("ChatWindow — メッセージ描画", () => {
  it("user / assistant の内容を描画", () => {
    mockState.messages = [
      { id: "u1", role: "user", content: "こんにちは" },
      { id: "a1", role: "assistant", content: "どうも" },
    ];
    render(<ChatWindow />);
    expect(screen.getByText("こんにちは")).toBeInTheDocument();
    expect(screen.getByText("どうも")).toBeInTheDocument();
  });

  it("error があるときエラー文を表示", () => {
    mockState.error = "boom";
    render(<ChatWindow />);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
});
