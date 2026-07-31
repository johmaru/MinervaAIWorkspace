import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});

// vi.hoisted ensures the mock fn is available to the hoisted vi.mock factory.
const { mockClientFetch } = vi.hoisted(() => ({
  mockClientFetch: vi.fn(),
}));

vi.mock("@/lib/clientFetch", () => ({
  clientFetch: mockClientFetch,
}));

import { McpPanel } from "@/components/McpPanel";
import { I18nProvider } from "@/components/I18nProvider";

beforeEach(() => {
  localStorage.setItem("minerva-locale", "ja");
  // Default: GET returns empty list.
  mockClientFetch.mockResolvedValue({
    ok: true,
    json: async () => [],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPanel(props?: { selectedIds?: string[]; onChange?: (ids: string[]) => void }) {
  const onChange = props?.onChange ?? vi.fn();
  return {
    onChange,
    ...render(
      <I18nProvider>
        <McpPanel selectedIds={props?.selectedIds ?? []} onChange={onChange} />
      </I18nProvider>,
    ),
  };
}

describe("McpPanel — server list", () => {
  it("shows empty message when no servers", async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("MCPサーバーが登録されていません")).toBeInTheDocument();
    });
  });

  it("displays servers from GET response", async () => {
    mockClientFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: "s1", name: "my-server", transport: "http", hasHeaders: false },
        { id: "s2", name: "stdio-srv", transport: "stdio", hasHeaders: false },
      ],
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("my-server")).toBeInTheDocument();
      expect(screen.getByText("stdio-srv")).toBeInTheDocument();
    });
  });

  it("shows lock icon when hasHeaders is true", async () => {
    mockClientFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: "s1", name: "auth-server", transport: "sse", hasHeaders: true },
      ],
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("auth-server")).toBeInTheDocument();
      expect(screen.getByText("🔒")).toBeInTheDocument();
    });
  });
});

describe("McpPanel — registration form", () => {
  it("opens form on add button click", async () => {
    renderPanel();
    await waitFor(() => screen.getByText("MCPサーバーを追加"));
    fireEvent.click(screen.getByText("MCPサーバーを追加"));
    expect(screen.getByText("サーバー名")).toBeInTheDocument();
  });

  it("shows SSE transport option", async () => {
    renderPanel();
    await waitFor(() => screen.getByText("MCPサーバーを追加"));
    fireEvent.click(screen.getByText("MCPサーバーを追加"));
    const select = screen.getByDisplayValue("HTTP (URL)");
    expect(select.tagName).toBe("SELECT");
    fireEvent.change(select, { target: { value: "sse" } });
    // URL placeholder changes for SSE
    expect(screen.getByPlaceholderText("https://example.com/sse")).toBeInTheDocument();
  });

  it("shows headers textarea for remote transports", async () => {
    renderPanel();
    await waitFor(() => screen.getByText("MCPサーバーを追加"));
    fireEvent.click(screen.getByText("MCPサーバーを追加"));
    expect(screen.getByText("ヘッダー（オプション）")).toBeInTheDocument();
  });

  it("hides headers for stdio transport", async () => {
    renderPanel();
    await waitFor(() => screen.getByText("MCPサーバーを追加"));
    fireEvent.click(screen.getByText("MCPサーバーを追加"));
    const select = screen.getByDisplayValue("HTTP (URL)");
    fireEvent.change(select, { target: { value: "stdio" } });
    expect(screen.queryByText("ヘッダー（オプション）")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("npx")).toBeInTheDocument();
  });


  it("submits POST with transport sse and headers when filled", async () => {
    mockClientFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // initial GET
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "new" }) }) // POST
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: "new", name: "sse-srv", transport: "sse", hasHeaders: true }] }); // refetch
    renderPanel();
    await waitFor(() => screen.getByText("MCPサーバーを追加"));
    fireEvent.click(screen.getByText("MCPサーバーを追加"));

    // Fill name — the first empty input in the form (サーバー名 label precedes it)
    const nameInput = screen.getAllByDisplayValue("")[0] as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "sse-srv" } });

    // Select SSE transport
    const select = screen.getByDisplayValue("HTTP (URL)");
    fireEvent.change(select, { target: { value: "sse" } });

    // Fill URL
    const urlInput = screen.getByPlaceholderText("https://example.com/sse");
    fireEvent.change(urlInput, { target: { value: "https://example.com/sse" } });

    // Fill headers
    const headersTextarea = screen.getByPlaceholderText(/Authorization: Bearer/);
    fireEvent.change(headersTextarea, { target: { value: "Authorization: Bearer xyz" } });

    // Click Add
    fireEvent.click(screen.getByText("追加"));

    await waitFor(() => {
      // POST was called with sse transport and parsed headers
      const postCall = mockClientFetch.mock.calls.find(
        ([, opts]) => opts && (opts as { method: string }).method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as { body: string }).body);
      expect(body.transport).toBe("sse");
      expect(body.headers).toEqual({ Authorization: "Bearer xyz" });
    });
  });
});

describe("McpPanel — test connection", () => {
  it("calls /api/mcp-servers/test on test button click", async () => {
    mockClientFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // GET
      .mockResolvedValueOnce({ // test
        ok: true,
        json: async () => ({ ok: true, transportUsed: "http", tools: [{ name: "echo" }] }),
      });
    renderPanel();
    await waitFor(() => screen.getByText("MCPサーバーを追加"));
    fireEvent.click(screen.getByText("MCPサーバーを追加"));

    // Fill required fields — name is the first empty input
    const nameInput = screen.getAllByDisplayValue("")[0] as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "test-srv" } });
    const urlInput = screen.getByPlaceholderText("https://example.com/mcp");
    fireEvent.change(urlInput, { target: { value: "https://example.com/mcp" } });

    fireEvent.click(screen.getByText("接続テスト"));

    await waitFor(() => {
      expect(screen.getByText(/接続成功/)).toBeInTheDocument();
    });
  });

  it("shows error message on test failure", async () => {
    mockClientFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // GET
      .mockResolvedValueOnce({ // test fail
        ok: true,
        json: async () => ({ ok: false, error: "connection refused" }),
      });
    renderPanel();
    await waitFor(() => screen.getByText("MCPサーバーを追加"));
    fireEvent.click(screen.getByText("MCPサーバーを追加"));

    const nameInput = screen.getAllByDisplayValue("")[0] as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "test-srv" } });
    const urlInput = screen.getByPlaceholderText("https://example.com/mcp");
    fireEvent.change(urlInput, { target: { value: "https://example.com/mcp" } });

    fireEvent.click(screen.getByText("接続テスト"));

    await waitFor(() => {
      expect(screen.getByText(/接続失敗/)).toBeInTheDocument();
      expect(screen.getByText(/connection refused/)).toBeInTheDocument();
    });
  });
});
