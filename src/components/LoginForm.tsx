"use client";

import { useActionState, useRef, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { MotionButton } from "@/components/ui/motion";
import { login, register } from "@/app/actions/auth";

type Mode = "login" | "register";

export function LoginForm({
  initialMode = "login",
  firstRun = false,
}: {
  initialMode?: Mode;
  firstRun?: boolean;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [state, action, pending] = useActionState(
    mode === "login" ? login : register,
    undefined,
  );
  const [mismatch, setMismatch] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

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
