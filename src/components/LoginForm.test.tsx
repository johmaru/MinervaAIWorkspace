import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// Mock authenticate: records the mode value from formData passed on form submit,
// and provides a stable function reference to pass to useActionState.
// vi.mock is hoisted to the top of the file, so pre-define with vi.hoisted.
const { authenticateMock, signInMock, clearSessionCookiesMock } = vi.hoisted(() => ({
  authenticateMock: vi.fn(async (_state: unknown, formData: FormData) => {
    return { submittedMode: String(formData.get("mode") ?? "login") };
  }),
  signInMock: vi.fn(),
  clearSessionCookiesMock: vi.fn(async () => {}),
}));

vi.mock("@/app/actions/auth", () => ({
  authenticate: authenticateMock,
  signInWithGoogle: signInMock,
  clearSessionCookies: clearSessionCookiesMock,
}));

// I18nProvider touches localStorage / cookie, so replace it with a lightweight Provider for tests.
// t() returns the key as-is (equivalent to fallback).
vi.mock("@/components/I18nProvider", () => ({
  useI18n: () => ({
    locale: "ja",
    setLocale: () => {},
    t: (key: string) => key,
  }),
}));

// MotionButton depends on motion/react, but transform is unnecessary in jsdom,
// so replace it with a plain button. Keep type="submit".
vi.mock("@/components/ui/motion", () => ({
  MotionButton: ({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) => (
    <button type="submit" {...rest}>{children}</button>
  ),
}));

import { LoginForm } from "@/components/LoginForm";

afterEach(() => {
  cleanup();
  authenticateMock.mockClear();
  signInMock.mockClear();
  clearSessionCookiesMock.mockClear();
});

beforeEach(() => {
  authenticateMock.mockClear();
  signInMock.mockClear();
  clearSessionCookiesMock.mockClear();
});

describe("LoginForm — mode toggle and hidden mode field", () => {
  it("login mode shows only email + password (no nickname)", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText("auth.email")).toBeTruthy();
    expect(screen.getByLabelText("auth.password")).toBeTruthy();
    expect(screen.queryByLabelText("auth.nickname")).toBeNull();
  });

  it("hidden mode field is 'login' in login mode", () => {
    render(<LoginForm />);
    const hiddenMode = document.querySelector(
      'input[type="hidden"][name="mode"]',
    ) as HTMLInputElement;
    expect(hiddenMode).toBeTruthy();
    expect(hiddenMode.value).toBe("login");
  });
  it("switching to register mode shows nickname field and sets mode='register'", () => {
    render(<LoginForm />);
    // Initial state is login
    expect(screen.queryByLabelText("auth.nickname")).toBeNull();
    // Click the toggle button (type="button") to switch modes
    const toggleBtn = screen.getByText("auth.noAccount");
    fireEvent.click(toggleBtn);
    expect(screen.getByLabelText("auth.nickname")).toBeTruthy();
    const hiddenMode = document.querySelector(
      'input[type="hidden"][name="mode"]',
    ) as HTMLInputElement;
    expect(hiddenMode.value).toBe("register");
  });

  it("switching register→login restores mode field to 'login' (structural prevention of stale-action bug)", () => {
    render(<LoginForm />);
    // Switch to register mode
    fireEvent.click(screen.getByText("auth.noAccount"));
    expect(screen.getByLabelText("auth.nickname")).toBeTruthy();
    // Switch back to login mode
    fireEvent.click(screen.getByText("auth.haveAccount"));
    expect(screen.queryByLabelText("auth.nickname")).toBeNull();
    const hiddenMode = document.querySelector(
      'input[type="hidden"][name="mode"]',
    ) as HTMLInputElement;
    expect(hiddenMode.value).toBe("login");
  });

  it("calls authenticate with mode=login when submitted in login mode", async () => {
    const mockState = { error: "auth.invalidCredentials" };
    authenticateMock.mockResolvedValueOnce(mockState);
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("auth.email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.change(screen.getByLabelText("auth.password"), {
      target: { value: "password123" },
    });
    const form = screen.getByLabelText("auth.email").closest("form")!;
    fireEvent.submit(form);
    // Wait for useActionState's action to be called asynchronously
    await vi.waitFor(() => {
      expect(authenticateMock).toHaveBeenCalledTimes(1);
    });
    const formData = authenticateMock.mock.calls[0][1] as FormData;
    expect(formData.get("mode")).toBe("login");
    expect(formData.get("email")).toBe("test@example.com");
  });
});

describe("LoginForm — Google sign-in button", () => {
  it("shows Google button in login mode + googleEnabled", () => {
    render(<LoginForm googleEnabled={true} />);
    expect(screen.getByText("auth.googleSignIn")).toBeTruthy();
    expect(screen.getByText("auth.or")).toBeTruthy();
  });

  it("hides Google button when googleEnabled=false", () => {
    render(<LoginForm googleEnabled={false} />);
    expect(screen.queryByText("auth.googleSignIn")).toBeNull();
    expect(screen.queryByText("auth.or")).toBeNull();
  });

  it("hides Google button when googleEnabled is unspecified (default false)", () => {
    render(<LoginForm />);
    expect(screen.queryByText("auth.googleSignIn")).toBeNull();
  });

  it("hides Google button in register mode", () => {
    render(<LoginForm googleEnabled={true} />);
    // Shown in initial state (login)
    expect(screen.getByText("auth.googleSignIn")).toBeTruthy();
    // Switch to register mode
    fireEvent.click(screen.getByText("auth.noAccount"));
    expect(screen.queryByText("auth.googleSignIn")).toBeNull();
  });

  it("calls signInWithGoogle on Google button click", () => {
    render(<LoginForm googleEnabled={true} />);
    fireEvent.click(screen.getByText("auth.googleSignIn"));
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(signInMock).toHaveBeenCalledWith();
  });
});

describe("LoginForm — sessionInvalid", () => {
  it("calls clearSessionCookies on mount when sessionInvalid=true", async () => {
    render(<LoginForm sessionInvalid={true} />);
    await vi.waitFor(() => {
      expect(clearSessionCookiesMock).toHaveBeenCalledTimes(1);
    });
  });

  it("shows session reset notice when sessionInvalid=true", () => {
    render(<LoginForm sessionInvalid={true} />);
    expect(screen.getByText("auth.sessionResetNotice")).toBeTruthy();
  });

  it("does not call clearSessionCookies when sessionInvalid is not set", () => {
    render(<LoginForm />);
    expect(clearSessionCookiesMock).not.toHaveBeenCalled();
  });

  it("does not show reset notice when sessionInvalid=false", () => {
    render(<LoginForm sessionInvalid={false} />);
    expect(screen.queryByText("auth.sessionResetNotice")).toBeNull();
  });
});
