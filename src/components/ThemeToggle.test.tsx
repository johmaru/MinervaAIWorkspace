import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/ThemeProvider";
import { I18nProvider } from "@/components/I18nProvider";
import { ThemeToggle } from "@/components/ThemeToggle";

const mockMatchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
});

beforeEach(() => {
  vi.stubGlobal("matchMedia", mockMatchMedia);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderWithProvider() {
  return render(
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <I18nProvider>
        <ThemeToggle />
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe("ThemeToggle — ダークモード切替", () => {
  it("ボタンが描画される", () => {
    renderWithProvider();
    const btn = screen.getByRole("button");
    expect(btn).toBeInTheDocument();
  });

  it("ライトモード時は月アイコン（ダークへ切り替え可能）", () => {
    renderWithProvider();
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-label", "ダークモードに切り替え");
  });

  it("クリックでダークモードに切り替わる", () => {
    renderWithProvider();
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    // クリック後、html の class に "dark" が付与される
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("ダークモード時は太陽アイコン（ライトへ切り替え可能）", () => {
    render(
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
        <I18nProvider>
          <ThemeToggle />
        </I18nProvider>
      </ThemeProvider>,
    );
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-label", "ライトモードに切り替え");
  });
});
