import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UrlInput } from "@/components/UrlInput";
import { I18nProvider } from "@/components/I18nProvider";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url === "/api/scrape") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ title: "Example", url: "https://example.com", cached: false }),
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

function renderUrlInput(onScraped?: (title: string) => void) {
  return render(<I18nProvider><UrlInput onScraped={onScraped} /></I18nProvider>);
}

describe("UrlInput — 表示", () => {
  it("URL 入力欄を表示", () => {
    renderUrlInput();
    expect(screen.getByPlaceholderText("URL を知識化…")).toBeInTheDocument();
  });

  it("🌐 アイコンとラベルがある", () => {
    renderUrlInput();
    expect(screen.getByLabelText("URL を取り込んで知識化")).toBeInTheDocument();
  });
});

describe("UrlInput — 送信", () => {
  it("Enter で POST /api/scrape を呼ぶ", async () => {
    const onScraped = vi.fn();
    renderUrlInput(onScraped);
    const input = screen.getByLabelText("URL を取り込んで知識化") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.form!);

    await waitFor(() => {
      expect(screen.getByText("取り込み完了")).toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledWith("/api/scrape", expect.objectContaining({ method: "POST" }));
    expect(onScraped).toHaveBeenCalledWith("Example");
    expect(input.value).toBe("");
  });

  it("空入力は送信しない", async () => {
    renderUrlInput();
    const input = screen.getByLabelText("URL を取り込んで知識化") as HTMLInputElement;
    fireEvent.submit(input.form!);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("キャッシュヒット時はメッセージが変わる", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ title: "Cached", url: "https://example.com", cached: true }),
    } as Response);
    renderUrlInput();
    const input = screen.getByLabelText("URL を取り込んで知識化") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.form!);
    await waitFor(() => {
      expect(screen.getByText("キャッシュ済み")).toBeInTheDocument();
    });
  });

  it("エラー時はエラーメッセージを表示", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "scrape failed" }),
    } as Response);
    renderUrlInput();
    const input = screen.getByLabelText("URL を取り込んで知識化") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.form!);
    await waitFor(() => {
      expect(screen.getByText("scrape failed")).toBeInTheDocument();
    });
  });

  it("通信エラー時は通信エラーメッセージ", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network"));
    renderUrlInput();
    const input = screen.getByLabelText("URL を取り込んで知識化") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.form!);
    await waitFor(() => {
      expect(screen.getByText("通信エラー")).toBeInTheDocument();
    });
  });
});
