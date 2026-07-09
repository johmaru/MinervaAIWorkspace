import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
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
  localStorage.setItem("umanschat-locale", "ja");
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

describe("ThemeToggle — dark mode toggle", () => {
  it("renders a button", () => {
    renderWithProvider();
    const btn = screen.getByRole("button");
    expect(btn).toBeInTheDocument();
  });

  it("shows moon icon in light mode (can switch to dark)", () => {
    renderWithProvider();
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-label", "ダークモードに切り替え");
  });

  it("switches to dark mode on click", () => {
    renderWithProvider();
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    // After click, the html class gets "dark" added
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("shows sun icon in dark mode (can switch to light)", () => {
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
