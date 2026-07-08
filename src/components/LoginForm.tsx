"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { MotionButton } from "@/components/ui/motion";
import { authenticate, clearSessionCookies, signInWithGoogle } from "@/app/actions/auth";

type Mode = "login" | "register";

export function LoginForm({
  initialMode = "login",
  firstRun = false,
  googleEnabled = false,
  sessionInvalid = false,
}: {
  initialMode?: Mode;
  firstRun?: boolean;
  googleEnabled?: boolean;
  sessionInvalid?: boolean;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [state, action, pending] = useActionState(authenticate, undefined);
  const [mismatch, setMismatch] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (sessionInvalid) {
      clearSessionCookies();
    }
  }, [sessionInvalid]);

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
            if (mode === "register") {
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
        {mode === "login" && googleEnabled && (
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
            <MotionButton
              type="button"
              disabled={pending}
              onClick={() => {
                void signInWithGoogle();
              }}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
              whileTap={{ scale: 0.98 }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              {t("auth.googleSignIn")}
            </MotionButton>
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
