"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";

type Thread = {
  id: string;
  title: string;
  systemPrompt: string | null;
  model: string;
};

type Props = {
  thread: Thread;
  onUpdate: (patch: { systemPrompt?: string | null; model?: string }) => Promise<void>;
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
  const [systemPrompt, setSystemPrompt] = useState(thread.systemPrompt ?? "");
  const [model, setModel] = useState(thread.model);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // モデルリスト取得
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/models");
        if (!res.ok) return;
        const data = (await res.json()) as { models: string[] };
        if (!cancelled) setModels(data.models);
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
    setSystemPrompt(thread.systemPrompt ?? "");
    setModel(thread.model);
    setSaved(false);
  }, [thread.id, thread.systemPrompt, thread.model]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    try {
      await onUpdate({
        systemPrompt: systemPrompt.trim() || null,
        model,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [systemPrompt, model, onUpdate]);

  const dirty =
    systemPrompt !== (thread.systemPrompt ?? "") || model !== thread.model;

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

      {open && (
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
              {t("threadSettings.model")}
            </span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-xl bg-muted px-2 py-1.5 text-xs outline-none transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {/* 現在のモデルがリストに無くても表示 */}
              {!models.includes(model) && (
                <option value={model}>{model}</option>
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
      )}
    </div>
  );
}
