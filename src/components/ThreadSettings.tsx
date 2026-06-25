"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { AnimatePresence, motion } from "motion/react";

type Thread = {
  id: string;
  title: string;
  systemPrompt: string | null;
  model: string;
  responseMode: "single" | "dual";
  dualModelA: string | null;
  dualModelB: string | null;
  dualStrategy: "cross_review" | "debate";
  dualDebateRounds: number;
  mcpServerIds: string[];
};

type Props = {
  thread: Thread;
  onUpdate: (patch: {
    systemPrompt?: string | null;
    model?: string;
    responseMode?: "single" | "dual";
    dualModelA?: string | null;
    dualModelB?: string | null;
    dualStrategy?: "cross_review" | "debate";
    dualDebateRounds?: number;
  }) => Promise<void>;
};

/**
 * スレッド設定パネル（折りたたみ式）。
 * - system prompt 編集（テキストエリア）
 * - モデルセレクタ（GET /api/models から候補取得）
 * - 保存ボタンで PATCH /api/threads?id=... を呼ぶ
 */
export function ThreadSettings({ thread, onUpdate }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [displayNames, setDisplayNames] = useState<Record<string, string>>({});
  const [systemPrompt, setSystemPrompt] = useState(thread.systemPrompt ?? "");
  const [model, setModel] = useState(thread.model);
  const [responseMode, setResponseMode] = useState<"single" | "dual">(thread.responseMode);
  const [dualModelA, setDualModelA] = useState(thread.dualModelA ?? thread.model);
  const [dualModelB, setDualModelB] = useState(thread.dualModelB ?? thread.model);
  const [dualStrategy, setDualStrategy] = useState<"cross_review" | "debate">(thread.dualStrategy);
  const [dualDebateRounds, setDualDebateRounds] = useState(thread.dualDebateRounds);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // モデルリスト取得
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/models");
        if (!res.ok) return;
        const data = (await res.json()) as {
          models: string[];
          displayNames?: Record<string, string>;
        };
        if (!cancelled) {
          setModels(data.models);
          setDisplayNames(data.displayNames ?? {});
        }
      } catch {
        // サイレント失敗: デフォルトで現在のモデルのみ
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);


  // スレッド切替時にローカル state を同期
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSystemPrompt(thread.systemPrompt ?? "");
    setModel(thread.model);
    setResponseMode(thread.responseMode);
    setDualModelA(thread.dualModelA ?? thread.model);
    setDualModelB(thread.dualModelB ?? thread.model);
    setDualStrategy(thread.dualStrategy);
    setDualDebateRounds(thread.dualDebateRounds);
    setSaved(false);
  }, [thread.id, thread.systemPrompt, thread.model, thread.responseMode, thread.dualModelA, thread.dualModelB, thread.dualStrategy, thread.dualDebateRounds]);

  const handleSave = useCallback(async () => {
    const resolvedDualModelA = dualModelA || model;
    const resolvedDualModelB =
      thread.dualModelB === null && dualModelB === thread.model
        ? models.find((m) => m !== resolvedDualModelA) ?? resolvedDualModelA
        : dualModelB || resolvedDualModelA;
    setSaving(true);
    setSaved(false);
    try {
      await onUpdate({
        systemPrompt: systemPrompt.trim() || null,
        model,
        responseMode,
        dualModelA: responseMode === "dual" ? resolvedDualModelA : null,
        dualModelB: responseMode === "dual" ? resolvedDualModelB : null,
        dualStrategy,
        dualDebateRounds,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [systemPrompt, model, responseMode, dualModelA, dualModelB, thread.dualModelB, thread.model, models, dualStrategy, dualDebateRounds, onUpdate]);

  const dirty =
    systemPrompt !== (thread.systemPrompt ?? "") ||
    model !== thread.model ||
    responseMode !== thread.responseMode ||
    dualModelA !== (thread.dualModelA ?? thread.model) ||
    dualModelB !== (thread.dualModelB ?? thread.model) ||
    dualDebateRounds !== thread.dualDebateRounds;

  return (
    <div className="border-b border-border/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-xs text-muted-foreground transition-colors duration-200 hover:bg-muted/70"
        aria-expanded={open}
        aria-controls="thread-settings-panel"
        aria-label={t("threadSettings.toggle")}
      >
        <span>{t("threadSettings.title")}</span>
        <span className={`text-[10px] transition-transform duration-150 ${open ? "rotate-90" : ""}`} aria-hidden="true">▶</span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <div id="thread-settings-panel" className="flex flex-col gap-3 px-4 py-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("threadSettings.systemPrompt")}
            </span>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={3}
              placeholder={t("threadSettings.systemPromptPlaceholder")}
              className="resize-none rounded-xl bg-muted px-2 py-1.5 text-xs outline-none transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("threadSettings.responseMode")}
            </span>
            <select
              value={responseMode}
              onChange={(e) => setResponseMode(e.target.value === "dual" ? "dual" : "single")}
              className="rounded-xl bg-muted px-2 py-1.5 text-xs outline-none transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
            >
              <option value="single">{t("threadSettings.responseModeSingle")}</option>
              <option value="dual">{t("threadSettings.responseModeDual")}</option>
            </select>
          </label>

          {responseMode === "dual" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("threadSettings.dualModelA")}
                </span>
                <ModelSelect
                  value={dualModelA}
                  models={models}
                  displayNames={displayNames}
                  onChange={setDualModelA}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("threadSettings.dualModelB")}
                </span>
                <ModelSelect
                  value={dualModelB}
                  models={models}
                  displayNames={displayNames}
                  onChange={setDualModelB}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("threadSettings.dualStrategy")}
                </span>
                <select
                  value={dualStrategy}
                  onChange={(e) => setDualStrategy(e.target.value === "debate" ? "debate" : "cross_review")}
                  className="rounded-xl bg-muted px-2 py-1.5 text-xs outline-none transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                >
                  <option value="cross_review">{t("threadSettings.dualStrategyCrossReview")}</option>
                  <option value="debate">{t("threadSettings.dualStrategyDebate")}</option>
                </select>
              </label>
              {dualStrategy === "debate" && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("threadSettings.dualDebateRounds")}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={dualDebateRounds}
                    onChange={(e) => setDualDebateRounds(Math.min(5, Math.max(1, Number(e.target.value) || 1)))}
                    className="rounded-xl bg-muted px-2 py-1.5 text-xs outline-none transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                  />
                </label>
              )}
            </div>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("threadSettings.model")}
            </span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-xl bg-muted px-2 py-1.5 text-xs outline-none transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {displayNames[m] ?? m}
                </option>
              ))}
              {/* 現在のモデルがリストに無くても表示 */}
              {!models.includes(model) && (
                <option value={model}>{displayNames[model] ?? model}</option>
              )}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="rounded-xl bg-foreground px-3 py-1.5 text-xs text-background transition-all duration-200 hover:opacity-90 disabled:opacity-40"
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
            {saved && (
              <span className="text-xs text-muted-foreground">{t("threadSettings.saved")}</span>
            )}
          </div>
          </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ModelSelect({
  value,
  models,
  displayNames,
  onChange,
}: {
  value: string;
  models: string[];
  displayNames: Record<string, string>;
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-xl bg-muted px-2 py-1.5 text-xs outline-none transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
    >
      {models.map((m) => (
        <option key={m} value={m}>
          {displayNames[m] ?? m}
        </option>
      ))}
      {!models.includes(value) && (
        <option value={value}>{displayNames[value] ?? value}</option>
      )}
    </select>
  );
}
