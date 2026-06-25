import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadSettings } from "@/components/ThreadSettings";
import { I18nProvider } from "@/components/I18nProvider";

// /api/models の fetch をモック
const mockModels = ["umans-glm-5.2", "gpt-4o-mini", "gpt-4o"];

beforeEach(() => {
  localStorage.setItem("umanschat-locale", "ja");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url === "/api/models") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: mockModels }),
        });
      }
      if (url === "/api/mcp-servers") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
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

type TestThread = {
  id: string;
  title: string;
  systemPrompt: string | null;
  model: string;
  responseMode: "single" | "dual";
  dualModelA: string | null;
  dualModelB: string | null;
  dualStrategy: "cross_review" | "debate";
  dualDebateRounds: number;
  mcpServerIds: string[];
};

const baseThread: TestThread = {
  id: "t1",
  title: "テスト",
  systemPrompt: null,
  model: "umans-glm-5.2",
  responseMode: "single" as const,
  dualModelA: null,
  dualModelB: null,
  dualStrategy: "cross_review" as const,
  dualDebateRounds: 2,
  mcpServerIds: [],
};

function renderSettings(overrides?: Partial<TestThread>) {
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  const thread = { ...baseThread, ...overrides };
  return { onUpdate, ...render(<I18nProvider><ThreadSettings thread={thread} onUpdate={onUpdate} /></I18nProvider>) };
}

describe("ThreadSettings — 折りたたみ", () => {
  it("閉じた状態では入力欄が見えない", () => {
    renderSettings();
    expect(screen.queryByPlaceholderText("このスレッドのシステムプロンプト（任意）")).not.toBeInTheDocument();
  });

  it("トグルボタンで開閉", () => {
    renderSettings();
    const btn = screen.getByRole("button", { name: "スレッド設定を開閉" });
    fireEvent.click(btn);
    expect(screen.getByPlaceholderText("このスレッドのシステムプロンプト（任意）")).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByPlaceholderText("このスレッドのシステムプロンプト（任意）")).not.toBeInTheDocument();
  });
});

describe("ThreadSettings — system prompt", () => {
  it("既存の system prompt を表示", () => {
    renderSettings({ systemPrompt: "既存プロンプト" });
        fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    expect(screen.getByDisplayValue("既存プロンプト")).toBeInTheDocument();
  });

  it("編集して保存", async () => {
    const { onUpdate } = renderSettings();
        fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    const ta = screen.getByPlaceholderText("このスレッドのシステムプロンプト（任意）");
    fireEvent.change(ta, { target: { value: "新しいプロンプト" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: "新しいプロンプト", model: "umans-glm-5.2" })),
    );
  });

  it("空文字は null として保存", async () => {
    const { onUpdate } = renderSettings({ systemPrompt: "既存" });
        fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    const ta = screen.getByPlaceholderText("このスレッドのシステムプロンプト（任意）");
    fireEvent.change(ta, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: null, model: "umans-glm-5.2" })),
    );
  });
});

describe("ThreadSettings — モデルセレクタ", () => {
  it("モデルリストを取得して表示", async () => {
    renderSettings();
        fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    const select = screen.getByDisplayValue("umans-glm-5.2");
    expect(select.tagName).toBe("SELECT");
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "gpt-4o-mini" })).toBeInTheDocument();
    });
  });

  it("モデル変更で dirty → 保存可能", async () => {
    const { onUpdate } = renderSettings();
        fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    await waitFor(() => screen.getByRole("option", { name: "gpt-4o-mini" }));
    fireEvent.change(screen.getByDisplayValue("umans-glm-5.2"), { target: { value: "gpt-4o-mini" } });
    const saveBtn = screen.getByRole("button", { name: "保存" });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: null, model: "gpt-4o-mini" })),
    );
  });

  it("デュアルモデル設定を保存", async () => {
    const { onUpdate } = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    await waitFor(() => screen.getByRole("option", { name: "gpt-4o-mini" }));

    fireEvent.change(screen.getByDisplayValue("通常"), { target: { value: "dual" } });
    fireEvent.change(screen.getByDisplayValue("相互レビュー"), { target: { value: "debate" } });
    fireEvent.change(screen.getByDisplayValue("2"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
        responseMode: "dual",
        dualModelA: "umans-glm-5.2",
        dualModelB: "gpt-4o-mini",
        dualStrategy: "debate",
        dualDebateRounds: 3,
      })),
    );
  });

  it("displayNames がある場合は表示名を option ラベルに使う", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "/api/models") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                models: ["umans-glm-5.2", "umans-qwen3.6-35b-a3b"],
                displayNames: {
                  "umans-glm-5.2": "Umans GLM 5.2",
                  "umans-qwen3.6-35b-a3b": "Umans Qwen3.6 35B A3B",
                },
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
    renderSettings({ model: "umans-qwen3.6-35b-a3b" });
        fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Umans Qwen3.6 35B A3B" })).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "Umans GLM 5.2" })).toBeInTheDocument();
  });
});

describe("ThreadSettings — 保存ボタン", () => {
  it("変更なしなら無効", () => {
    renderSettings();
        fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("保存成功メッセージを表示", async () => {
    const { onUpdate } = renderSettings();
        fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    const ta = screen.getByPlaceholderText("このスレッドのシステムプロンプト（任意）");
    fireEvent.change(ta, { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(screen.getByText("✓ 保存しました")).toBeInTheDocument();
    });
    expect(onUpdate).toHaveBeenCalled();
  });
});
