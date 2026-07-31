"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { MotionButton } from "@/components/ui/motion";
import { authenticate, clearSessionCookies, signInWithGoogle, signInWithGithub, signInWithMicrosoft } from "@/app/actions/auth";

type Mode = "login" | "register";

export function LoginForm({
  initialMode = "login",
  firstRun = false,
  googleEnabled = false,
  githubEnabled = false,
  microsoftEnabled = false,
  sessionInvalid = false,
}: {
  initialMode?: Mode;
  firstRun?: boolean;
  googleEnabled?: boolean;
  githubEnabled?: boolean;
  microsoftEnabled?: boolean;
  sessionInvalid?: boolean;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [state, action, pending] = useActionState(authenticate, undefined);
  const [mismatch, setMismatch] = useState(false);
  const [rememberEmail, setRememberEmail] = useState(false);
  const [savedEmail, setSavedEmail] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (sessionInvalid) {
      clearSessionCookies();
    }
  }, [sessionInvalid]);

  // Pre-fill email from localStorage on mount (login mode only)
  useEffect(() => {
    if (mode === "login") {
      const stored =
        localStorage.getItem("minerva:rememberEmail") ??
        localStorage.getItem("umanschat:rememberEmail");
      if (stored) {
        setSavedEmail(stored);
        setRememberEmail(true);
        localStorage.setItem("minerva:rememberEmail", stored);
      }
    }
  }, [mode]);

  const toggleMode = () => { setMismatch(false); setMode((m) => (m === "login" ? "register" : "login")); };
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-4 rounded-2xl bg-card p-6 ring-1 ring-border">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold text-foreground">
            {mode === "register" ? t("auth.register") : t("auth.login")}
          </h1>
          {firstRun && mode === "register" && (
            <p className="text-sm text-muted-foreground">{t("auth.firstRunBanner")}</p>
          )}
          {sessionInvalid && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
              {t("auth.sessionResetNotice")}
            </p>
          )}
        </div>
        <form
          ref={formRef}
          action={action}
          className="space-y-3"
          onSubmit={(e) => {
            if (mode === "login") {
              if (rememberEmail) {
                localStorage.setItem("minerva:rememberEmail", savedEmail);
              } else {
                localStorage.removeItem("minerva:rememberEmail");
                localStorage.removeItem("umanschat:rememberEmail");
              }
            } else {
              const form = e.currentTarget;
              const pw = (form.elements.namedItem("password") as HTMLInputElement)?.value;
              const pw2 = (form.elements.namedItem("passwordConfirm") as HTMLInputElement)?.value;
              if (pw !== pw2) {
                e.preventDefault();
                setMismatch(true);
              }
            }
          }}
        >
          <input type="hidden" name="mode" value={mode} />
          {mode === "register" && (
            <div className="space-y-1">
              <label htmlFor="nickname" className="text-sm text-muted-foreground">
                {t("auth.nickname")}
              </label>
              <input
                id="nickname"
                name="nickname"
                type="text"
                autoComplete="nickname"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-ring"
                required
              />
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor="email" className="text-sm text-muted-foreground">
              {t("auth.email")}
            </label>
            <input
              id="email"
              name="email"
              type="email"
              value={savedEmail}
              onChange={(e) => setSavedEmail(e.target.value)}
              autoComplete="email"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-ring"
              required
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="password" className="text-sm text-muted-foreground">
              {t("auth.password")}
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-ring"
              required
            />
          </div>
          {mode === "login" && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                name="rememberEmail"
                checked={rememberEmail}
                onChange={(e) => setRememberEmail(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              {t("auth.rememberEmail")}
            </label>
          )}

          {mode === "register" && (
            <div className="space-y-1">
              <label htmlFor="passwordConfirm" className="text-sm text-muted-foreground">
                {t("auth.passwordConfirm")}
              </label>
              <input
                id="passwordConfirm"
                name="passwordConfirm"
                type="password"
                autoComplete="new-password"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-ring"
                required
                onChange={() => setMismatch(false)}
              />
            </div>
          )}

          {mismatch && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">
              {t("auth.passwordMismatch")}
            </p>
          )}
          {state?.error && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">
              {t(state.error)}
            </p>
          )}

          <MotionButton
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            whileTap={{ scale: 0.98 }}
          >
            {pending ? t("common.saving") : mode === "register" ? t("auth.register") : t("auth.login")}
          </MotionButton>
        </form>
        {mode === "login" && (googleEnabled || githubEnabled || microsoftEnabled) && (
          <>
            <div className="relative py-1">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-card px-2 text-muted-foreground">
                  {t("auth.or")}
                </span>
              </div>
            </div>
            {googleEnabled && (
              <MotionButton
                type="button"
                disabled={pending}
                onClick={() => {
                  void signInWithGoogle();
                }}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
                whileTap={{ scale: 0.98 }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
                {t("auth.googleSignIn")}
              </MotionButton>
            )}
            {githubEnabled && (
              <MotionButton
                type="button"
                disabled={pending}
                onClick={() => {
                  void signInWithGithub();
                }}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
                whileTap={{ scale: 0.98 }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path fill="currentColor" d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                {t("auth.githubSignIn")}
              </MotionButton>
            )}
            {microsoftEnabled && (
              <MotionButton
                type="button"
                disabled={pending}
                onClick={() => {
                  void signInWithMicrosoft();
                }}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
                whileTap={{ scale: 0.98 }}
              >
                <svg width="18" height="18" viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg">
                  <path fill="#f25022" d="M1 1h10v10H1z" />
                  <path fill="#7fba00" d="M12 1h10v10H12z" />
                  <path fill="#00a4ef" d="M1 12h10v10H1z" />
                  <path fill="#ffb900" d="M12 12h10v10H12z" />
                </svg>
                {t("auth.microsoftSignIn")}
              </MotionButton>
            )}
          </>
        )}

        <div className="text-center">
          <button
            type="button"
            onClick={toggleMode}
            className="text-sm text-muted-foreground transition hover:text-foreground"
          >
            {mode === "login" ? t("auth.noAccount") : t("auth.haveAccount")}
          </button>
        </div>
      </div>
    </div>
  );
}
