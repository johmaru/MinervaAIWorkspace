import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as I18nTypes from "@/lib/i18n/types";

vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<I18nTypes>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});

import { SettingsModal, resolveClientReasoningLevels } from "@/components/SettingsModal";
import { I18nProvider } from "@/components/I18nProvider";

/** A representative settings payload returned by GET /api/settings. */
const baseSettings = {
  llmApiKey: "",
  hasLlmApiKey: true,
  llmProvider: "openai" as const,
  llmBaseUrl: "https://api.code.umans.ai/v1",
  cursorApiKey: "",
  hasCursorApiKey: false,
  llmModel: "umans-glm-5.2",
  llmFallbackModel: "",
  llmFallbackTimeoutMs: 10000,
  thinkingEffort: "medium",
  webSearchThinkingEffort: "none",
  embedModel: "LiquidAI/LFM2.5-Embedding-350M",
  embedDim: 1024,
  embedProvider: "http",
  embedModelOptions: [
    {
      model: "LiquidAI/LFM2.5-Embedding-350M",
      dim: 1024,
      provider: "http",
      label: "LFM2.5",
    },
    {
      model: "Xenova/all-MiniLM-L6-v2",
      dim: 384,
      provider: "local",
      label: "MiniLM",
    },
  ],
  dbVectorDim: 1024,
  dbPageEmbeddingsDim: 1024,
  webSearchModel: "umans-qwen3.6-35b-a3b",
  webSearchMaxResults: 3,
  webSearchMaxRounds: 3,
  webSearchThinkingEffort: "none",
  scraperUrl: "http://localhost:8000",
  searxngUrl: "http://localhost:8080",
  torProxy: "",
  scrapeProxy: "",
  databaseUrl: ":memory:",
  hostOs: "win32",
  tz: "Asia/Tokyo",
  notionClientId: "",
  notionClientSecret: "",
  hasNotionClientSecret: false,
  authUrl: "",
  tunnelToken: "",
  hasTunnelToken: false,
  registrationLocked: false,
  allowedRegistrationIps: "",
  activeInstructionId: null,
  personalStyle: null,
  personalWarmth: 1,
  personalEnergy: 1,
  personalStructure: 1,
  personalEmoji: 1,
  logLevel: "info",
  logFileEnabled: "true",
  logFilePath: "/tmp/minerva.log",
  translateDefaultMulti: false,
  translateTimeout: 30,
};

/**
 * Minimal mock for fetch. Captures POST bodies to /api/settings so tests can
 * assert partial-update payloads (immediate persistence + main Save).
 */
function mockFetch(overrides?: {
  settings?: Partial<typeof baseSettings>;
  instructions?: { id: string; name: string; content: string }[];
}) {
  const settingsData = { ...baseSettings, ...(overrides?.settings ?? {}) };
  const instructions = overrides?.instructions ?? [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/settings" && (!init || init.method === undefined || init.method === "GET")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(settingsData),
      });
    }
    if (url === "/api/settings" && init?.method === "POST") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, message: "saved" }),
      });
    }
    if (url === "/api/global-instructions") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(instructions),
      });
    }
    if (url === "/api/tor") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ running: false, connection: null }),
      });
    }
    if (url === "/api/tunnel") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ running: false, hasToken: false }),
      });
    }
    if (url === "/api/connections") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/models") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ models: ["umans-glm-5.2", "umans-coder"], displayNames: { "umans-glm-5.2": "Umans GLM 5.2", "umans-coder": "Umans Coder" }, reasoningLevels: { "umans-glm-5.2": ["none", "high", "max"], "umans-coder": [] } }),
      });
    }
    if (url === "/api/update") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal("fetch", impl);
  return { calls, settingsData, instructions };
}

function renderModal() {
  return render(
    <I18nProvider>
      <SettingsModal open onClose={() => {}} onOpenHelp={() => {}} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("minerva-locale", "ja");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Returns the POST calls to /api/settings captured by the fetch mock. */
function settingsPostCalls(calls: { url: string; init?: RequestInit }[]) {
  return calls.filter((c) => c.url === "/api/settings" && c.init?.method === "POST");
}

describe("resolveClientReasoningLevels", () => {
  it("uses the generic set for freeform models missing from the catalog", () => {
    expect(resolveClientReasoningLevels("gpt-4.1", {})).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("keeps empty levels for Umans not-controllable catalog entries", () => {
    expect(
      resolveClientReasoningLevels("umans-coder", { "umans-coder": [] }, "https://api.code.umans.ai/v1"),
    ).toEqual([]);
  });

  it("falls back to the generic set when a non-Umans catalog entry has empty levels", () => {
    expect(
      resolveClientReasoningLevels("gpt-4o", { "gpt-4o": [] }, "https://api.openai.com/v1"),
    ).toEqual(["none", "low", "medium", "high", "max"]);
  });

  it("preserves advertised non-empty levels", () => {
    expect(
      resolveClientReasoningLevels("umans-glm-5.2", { "umans-glm-5.2": ["none", "high", "max"] }),
    ).toEqual(["none", "high", "max"]);
  });
});

describe("SettingsModal — immediate partial persistence", () => {
  it("toggling registration lock sends immediate POST { registrationLocked: true }", async () => {
    const { calls } = mockFetch();
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());
    // Security checkbox is on Access & Security (🌐 公開・セキュリティ)
    fireEvent.click(screen.getByRole("button", { name: /公開・セキュリティ/ }));
    const checkbox = await screen.findByRole("checkbox");
    fireEvent.click(checkbox);
    await waitFor(() => {
      const posts = settingsPostCalls(calls);
      expect(posts.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse(posts[0].init!.body as string);
      expect(body).toMatchObject({ registrationLocked: true });
      // Partial update only — must not send the entire form
      expect(body.embedModel).toBeUndefined();
    });
  });

  it("Connections tab shows Notion fields and not AUTH_URL/Tunnel/Security", async () => {
    mockFetch();
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /コネクション/ }));
    expect(screen.getByText("NOTION_CLIENT_ID")).toBeInTheDocument();
    expect(screen.getByText("NOTION_CLIENT_SECRET")).toBeInTheDocument();
    expect(screen.queryByText("AUTH_URL")).toBeNull();
    expect(screen.queryByText("Tunnel Token")).toBeNull();
    expect(screen.queryByText(t => t.startsWith("Cloudflare Tunnel"))).toBeNull();
  });

  it("Server Access tab shows AUTH_URL, Tunnel, and Security", async () => {
    mockFetch();
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /公開・セキュリティ/ }));
    expect(await screen.findByText("AUTH_URL")).toBeInTheDocument();
    expect(screen.getByText("Tunnel Token")).toBeInTheDocument();
    expect(screen.getByText(t => typeof t === "string" && t.startsWith("Cloudflare Tunnel"))).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("selecting a GSI radio sends immediate POST { activeInstructionId }", async () => {
    const { calls } = mockFetch({
      instructions: [{ id: "instr-1", name: "Test Instr", content: "hello" }],
    });
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());
    // AI tab is already active (index 0). Wait for instructions to render.
    const radio = await screen.findByRole("radio");
    fireEvent.click(radio);
    await waitFor(() => {
      const posts = settingsPostCalls(calls);
      expect(posts.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse(posts[0].init!.body as string);
      expect(body).toMatchObject({ activeInstructionId: "instr-1" });
      expect(body.registrationLocked).toBeUndefined();
    });
  });
});

describe("SettingsModal — embedDirty and Save payload", () => {
  it("accepts a freeform llmModel id not in the provider list", async () => {
    const { calls } = mockFetch();
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());
    const llmInput = screen.getByRole("combobox", { name: "デフォルトモデル" });
    expect(llmInput).toHaveValue("umans-glm-5.2");
    fireEvent.change(llmInput, { target: { value: "gpt-4.1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const posts = settingsPostCalls(calls);
      expect(posts.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse(posts[0].init!.body as string);
      expect(body.llmModel).toBe("gpt-4.1");
    });
  });

  it("embedDirty is false on load when embed settings match server", async () => {
    mockFetch();
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());
    // No migration warning should be visible
    expect(screen.queryByText(/マイグレーションが必要/)).not.toBeInTheDocument();
  });

  it("changing embed model to a different dim shows migration warning", async () => {
    mockFetch();
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());
    const select = screen.getByDisplayValue(/LFM2.5/i);
    fireEvent.change(select, { target: { value: "Xenova/all-MiniLM-L6-v2" } });
    await waitFor(() => {
      expect(screen.getByText(/マイグレーションが必要/)).toBeInTheDocument();
    });
  });

  it("embedDirty && !migrationConfirmed still allows Save without embed fields", async () => {
    const { calls } = mockFetch();
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());
    // Change embed model to a different dim (makes embedDirty + needsMigration true)
    const embedSelect = screen.getByDisplayValue(/LFM2.5/i);
    fireEvent.change(embedSelect, { target: { value: "Xenova/all-MiniLM-L6-v2" } });
    // Also change LLM model so the payload has a non-embed field to save
    const llmInput = screen.getByRole("combobox", { name: "デフォルトモデル" });
    fireEvent.change(llmInput, { target: { value: "umans-coder" } });
    // Do NOT check the migration confirmation checkbox
    // Save should be enabled (disabled={saving} only, not gated on migration)
    const saveBtn = screen.getByRole("button", { name: "保存" });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);
    await waitFor(() => {
      const posts = settingsPostCalls(calls);
      expect(posts.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse(posts[0].init!.body as string);
      // embed fields must be stripped (embedDirty && needsMigration && !migrationConfirmed)
      expect(body.embedModel).toBeUndefined();
      expect(body.embedDim).toBeUndefined();
      expect(body.embedProvider).toBeUndefined();
      expect(body.applyMigration).toBeUndefined();
      // Non-embed fields must still be saved
      expect(body.llmModel).toBe("umans-coder");
    });
  });

  it("embedDirty && migrationConfirmed sends embed fields with applyMigration: true", async () => {
    const { calls } = mockFetch();
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());
    // Change LLM model first (update() resets migrationConfirmed, which is fine here)
    const llmInput = screen.getByRole("combobox", { name: "デフォルトモデル" });
    fireEvent.change(llmInput, { target: { value: "umans-coder" } });
    // Change embed model to different dim (1024 → 384)
    const embedSelect = screen.getByDisplayValue(/LFM2.5/i);
    fireEvent.change(embedSelect, { target: { value: "Xenova/all-MiniLM-L6-v2" } });
    // Check migration confirmation (must be AFTER all update() calls, since update resets it)
    const confirmCheckbox = await screen.findByRole("checkbox", { name: /データ削除を理解してマイグレーションを実行する/ });
    fireEvent.click(confirmCheckbox);
    // Save
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const posts = settingsPostCalls(calls);
      expect(posts.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse(posts[0].init!.body as string);
      expect(body.embedModel).toBe("Xenova/all-MiniLM-L6-v2");
      expect(body.embedDim).toBe(384);
      expect(body.embedProvider).toBe("local");
      expect(body.applyMigration).toBe(true);
      expect(body.llmModel).toBe("umans-coder");
    });
  });
});

describe("SettingsModal — platform templates", () => {
  it("selecting a template fills provider=openai and baseUrl, and Save persists both", async () => {
    const { calls } = mockFetch();
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());

    const platform = screen.getByRole("combobox", { name: "プラットフォーム" });
    expect(platform).toHaveValue("umans"); // default baseUrl matches UmansAI
    fireEvent.change(platform, { target: { value: "opencode" } });

    expect(screen.getByRole("combobox", { name: "プラットフォーム" })).toHaveValue("opencode");
    expect(screen.getByDisplayValue("https://opencode.ai/zen/go/v1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const posts = settingsPostCalls(calls);
      expect(posts.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse(posts[0].init!.body as string);
      expect(body).toMatchObject({
        llmProvider: "openai",
        llmBaseUrl: "https://opencode.ai/zen/go/v1",
      });
    });
  });

  it("switches from cursor provider to openai and reveals the baseUrl field", async () => {
    mockFetch({ settings: { llmProvider: "cursor" } });
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());

    // Cursor mode: base URL input is hidden
    expect(screen.queryByDisplayValue("https://api.code.umans.ai/v1")).toBeNull();
    expect(screen.getByDisplayValue("Cursor SDK")).toBeInTheDocument();

    const platform = screen.getByRole("combobox", { name: "プラットフォーム" });
    fireEvent.change(platform, { target: { value: "openai" } });

    // Provider switched to OpenAI-compatible; base URL input now visible and filled
    expect(screen.getByDisplayValue("OpenAI 互換")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Cursor SDK")).toBeNull();
    expect(screen.getByDisplayValue("https://api.openai.com/v1")).toBeInTheDocument();
  });

  it("shows the matching template when current baseUrl equals a template", async () => {
    mockFetch({ settings: { llmBaseUrl: "https://openrouter.ai/api/v1" } });
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());

    expect(screen.getByRole("combobox", { name: "プラットフォーム" })).toHaveValue("openrouter");
  });

  it("custom selection does not change provider or baseUrl", async () => {
    mockFetch();
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());

    const platform = screen.getByRole("combobox", { name: "プラットフォーム" });
    fireEvent.change(platform, { target: { value: "custom" } });

    expect(platform).toHaveValue("custom");
    expect(screen.getByDisplayValue("https://api.code.umans.ai/v1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("OpenAI 互換")).toBeInTheDocument(); // provider untouched
  });
});
