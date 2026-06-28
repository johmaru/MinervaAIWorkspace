import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// authenticate をモック: フォーム送信時に渡された formData の mode 値を記録し、
// 安定した関数参照として useActionState に渡せるようにする。
// vi.mock はファイル先頭に巻き上げられるため、vi.hoisted で事前定義する。
const { authenticateMock, signInMock } = vi.hoisted(() => ({
  authenticateMock: vi.fn(async (_state: unknown, formData: FormData) => {
    return { submittedMode: String(formData.get("mode") ?? "login") };
  }),
  signInMock: vi.fn(),
}));

vi.mock("@/app/actions/auth", () => ({
  authenticate: authenticateMock,
}));
vi.mock("@/auth", () => ({
  signIn: signInMock,
}));

// I18nProvider は localStorage / cookie を触るため、テスト用に軽量な Provider で差し替え。
// t() は key をそのまま返す（フォールバックと同義）。
vi.mock("@/components/I18nProvider", () => ({
  useI18n: () => ({
    locale: "ja",
    setLocale: () => {},
    t: (key: string) => key,
  }),
}));

// MotionButton は motion/react に依存するが、jsdom では transform が不要なので
// プレーンな button に差し替え。type="submit" を保持する。
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
});

beforeEach(() => {
  authenticateMock.mockClear();
  signInMock.mockClear();
});

describe("LoginForm — モード切替と hidden mode フィールド", () => {
  it("ログインモードは email + password のみ表示（nickname なし）", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText("auth.email")).toBeTruthy();
    expect(screen.getByLabelText("auth.password")).toBeTruthy();
    expect(screen.queryByLabelText("auth.nickname")).toBeNull();
  });

  it("hidden mode フィールドがログインモードで 'login'", () => {
    render(<LoginForm />);
    const hiddenMode = document.querySelector(
      'input[type="hidden"][name="mode"]',
    ) as HTMLInputElement;
    expect(hiddenMode).toBeTruthy();
    expect(hiddenMode.value).toBe("login");
  });
  it("登録モードに切り替えると nickname フィールドが表示され、mode='register'", () => {
    render(<LoginForm />);
    // 初期状態は login
    expect(screen.queryByLabelText("auth.nickname")).toBeNull();
    // トグルボタン（type="button"）をクリックしてモード切替
    const toggleBtn = screen.getByText("auth.noAccount");
    fireEvent.click(toggleBtn);
    expect(screen.getByLabelText("auth.nickname")).toBeTruthy();
    const hiddenMode = document.querySelector(
      'input[type="hidden"][name="mode"]',
    ) as HTMLInputElement;
    expect(hiddenMode.value).toBe("register");
  });

  it("登録→ログインに戻すと mode フィールドが 'login' に戻る（stale-action バグの構造的防止）", () => {
    render(<LoginForm />);
    // 登録モードへ切替
    fireEvent.click(screen.getByText("auth.noAccount"));
    expect(screen.getByLabelText("auth.nickname")).toBeTruthy();
    // ログインモードへ戻す
    fireEvent.click(screen.getByText("auth.haveAccount"));
    expect(screen.queryByLabelText("auth.nickname")).toBeNull();
    const hiddenMode = document.querySelector(
      'input[type="hidden"][name="mode"]',
    ) as HTMLInputElement;
    expect(hiddenMode.value).toBe("login");
  });

  it("ログインモードで送信すると authenticate が mode=login で呼ばれる", async () => {
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
    // useActionState の action が非同期で呼ばれるのを待つ
    await vi.waitFor(() => {
      expect(authenticateMock).toHaveBeenCalledTimes(1);
    });
    const formData = authenticateMock.mock.calls[0][1] as FormData;
    expect(formData.get("mode")).toBe("login");
    expect(formData.get("email")).toBe("test@example.com");
  });
});

describe("LoginForm — Google ログインボタン", () => {
  it("ログインモードで Google ボタンが表示される", () => {
    render(<LoginForm />);
    expect(screen.getByText("auth.googleSignIn")).toBeTruthy();
    expect(screen.getByText("auth.or")).toBeTruthy();
  });

  it("登録モードでは Google ボタンが非表示", () => {
    render(<LoginForm />);
    // 初期状態（login）では表示
    expect(screen.getByText("auth.googleSignIn")).toBeTruthy();
    // 登録モードに切替
    fireEvent.click(screen.getByText("auth.noAccount"));
    expect(screen.queryByText("auth.googleSignIn")).toBeNull();
  });

  it("Google ボタンクリックで signIn('google') が呼ばれる", () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByText("auth.googleSignIn"));
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(signInMock).toHaveBeenCalledWith("google", { callbackUrl: "/" });
  });
});
