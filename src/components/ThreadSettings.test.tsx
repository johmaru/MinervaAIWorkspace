import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
import { ThreadSettings } from "@/components/ThreadSettings";
import { I18nProvider } from "@/components/I18nProvider";

// Mock fetch for /api/models
const mockModels = ["umans-glm-5.2", "gpt-4o-mini", "gpt-4o"];

beforeEach(() => {
  localStorage.setItem("minerva-locale", "ja");
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
      if (url === "/api/global-instructions") {
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
  responseMode: "single" | "dual" | "hyper" | "council";
  dualModelA: string | null;
  dualModelB: string | null;
  dualStrategy: "cross_review" | "debate";
  dualDebateRounds: number;
  hyperRounds: number;
  councilSize: number;
  councilTimeLimit: number;
  mcpServerIds: string[];
  connectionIds: string[];
  globalInstructionId: string | null;
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
  hyperRounds: 3,
  councilSize: 3,
  councilTimeLimit: 60,
  mcpServerIds: [],
  connectionIds: [],
  globalInstructionId: null,
};

function renderSettings(overrides?: Partial<TestThread>) {
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  const thread = { ...baseThread, ...overrides };
  return { onUpdate, ...render(<I18nProvider><ThreadSettings thread={thread} onUpdate={onUpdate} /></I18nProvider>) };
}

describe("ThreadSettings — collapse", () => {
  it("input is not visible when collapsed", () => {
    renderSettings();
    expect(screen.queryByPlaceholderText("このスレッドのシステムプロンプト（任意）")).not.toBeInTheDocument();
  });

  it("toggles open/closed with the toggle button", async () => {
    renderSettings();
    const btn = screen.getByRole("button", { name: "スレッド設定を開閉" });
    fireEvent.click(btn);
    expect(screen.getByPlaceholderText("このスレッドのシステムプロンプト（任意）")).toBeInTheDocument();
    fireEvent.click(btn);
    // AnimatePresence exit animation keeps the element in the DOM, so wait with waitFor.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("このスレッドのシステムプロンプト（任意）")).not.toBeInTheDocument();
    });
  });
});

describe("ThreadSettings — system prompt", () => {
  it("displays existing system prompt", () => {
    renderSettings({ systemPrompt: "既存プロンプト" });
        fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    expect(screen.getByDisplayValue("既存プロンプト")).toBeInTheDocument();
  });

  it("edits and saves", async () => {
    const { onUpdate } = renderSettings();
        fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    const ta = screen.getByPlaceholderText("このスレッドのシステムプロンプト（任意）");
    fireEvent.change(ta, { target: { value: "新しいプロンプト" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: "新しいプロンプト", model: "umans-glm-5.2" })),
    );
  });

  it("saves empty string as null", async () => {
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

describe("ThreadSettings — model selector", () => {
  it("fetches and displays the model list", async () => {
    renderSettings();
        fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    const select = screen.getByDisplayValue("umans-glm-5.2");
    expect(select.tagName).toBe("SELECT");
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "gpt-4o-mini" })).toBeInTheDocument();
    });
  });

  it("model change makes it dirty → saveable", async () => {
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

  it("saves dual model settings", async () => {
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

  it("uses display names for option labels when available", async () => {
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

describe("ThreadSettings — save button", () => {
  it("is disabled when there are no changes", () => {
    renderSettings();
        fireEvent.click(screen.getByRole("button", { name: "スレッド設定を開閉" }));
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("shows a save success message", async () => {
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
