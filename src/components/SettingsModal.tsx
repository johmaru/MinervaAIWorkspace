"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";

type EmbedModelOption = {
  model: string;
  dim: number;
  provider: "local" | "http";
  label: string;
};

type SettingsResponse = {
  // LLM
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmModels: string;
  thinkingEffort: string;
  // Embeddings
  embedModel: string;
  embedDim: number;
  embedProvider: string;
  embedModelOptions: readonly EmbedModelOption[];
  dbVectorDim: number;
  dbPageEmbeddingsDim: number;
  // Web 検索
  webSearchModel: string;
  webSearchMaxResults: number;
  webSearchMaxRounds: number;
  scraperUrl: string;
  searxngUrl: string;
  // Tor プロキシ
  torProxy: string;
  scrapeProxy: string;
  // Database
  databaseUrl: string;
};

type TorConnection = {
  directIp: string | null;
  torIp: string | null;
  connected: boolean;
  error: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * アプリ設定モーダル（サイドバーの⚙️ボタンから開く）。
 *
 * 全 .env 設定を GUI で編集可能:
 * - LLM 設定（BASE_URL, API_KEY, MODEL, MODELS, Thinking Effort）
 * - 埋め込みモデル（次元変更時はマイグレーション確認）
 * - Web 検索（参照元件数, SCRAPER_URL, SEARXNG_URL）
 * - Tor プロキシ（TOR_PROXY, SCRAPE_PROXY）
 * - Database URL
 */
export function SettingsModal({ open, onClose }: Props) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<Partial<SettingsResponse>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success" | "warning"; text: string } | null>(null);
  const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const [torRunning, setTorRunning] = useState(false);
  const [torBusy, setTorBusy] = useState(false);
  const [torConnection, setTorConnection] = useState<TorConnection | null>(null);
  const [torChecking, setTorChecking] = useState(false);

  const fetchTorStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/tor");
      if (!res.ok) return;
      const data = (await res.json()) as {
        running: boolean;
        connection: TorConnection;
      };
      setTorRunning(data.running);
      setTorConnection(data.connection);
    } catch {
      // 無視
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error(t("settings.fetchFailed"));
      const data = (await res.json()) as SettingsResponse;
      setSettings(data);
      setForm(data);
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : t("settings.fetchError") });
    }
  }, [t]);

  useEffect(() => {
    if (open) {
      setMessage(null);
      setMigrationConfirmed(false);
      void fetchSettings();
      void fetchTorStatus();
    }
  }, [open, fetchSettings, fetchTorStatus]);

  const update = useCallback(<K extends keyof SettingsResponse>(key: K, value: SettingsResponse[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setMigrationConfirmed(false);
  }, []);

  const selectedOption = settings?.embedModelOptions.find((o) => o.model === form.embedModel);
  const needsMigration =
    settings !== null &&
    selectedOption !== undefined &&
    settings.dbVectorDim > 0 &&
    (selectedOption.dim !== settings.dbVectorDim ||
     (settings.dbPageEmbeddingsDim > 0 && selectedOption.dim !== settings.dbPageEmbeddingsDim));

  const handleSave = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          embedDim: selectedOption?.dim ?? form.embedDim,
          embedProvider: selectedOption?.provider ?? form.embedProvider,
          applyMigration: needsMigration && migrationConfirmed,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        message?: string;
        currentDim?: number;
        newDim?: number;
        migrationApplied?: boolean;
      };
      if (!res.ok) {
        if (data.error === "migration_required") {
          setMessage({
            type: "warning",
            text: t("settings.migrationRequired", { current: data.currentDim ?? "", new: data.newDim ?? "" }),
          });
        } else {
          setMessage({ type: "error", text: data.error || t("settings.saveFailed") });
        }
        return;
      }
      if (data.migrationApplied) {
        setMessage({
          type: "success",
          text: t("settings.migrationComplete"),
        });
      } else {
        setMessage({ type: "success", text: t("settings.saved") });
      }
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : t("common.communicationError") });
    } finally {
      setSaving(false);
    }
  }, [form, selectedOption, needsMigration, migrationConfirmed, t]);

  const handleTorToggle = useCallback(async () => {
    setTorBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/tor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: torRunning ? "stop" : "start" }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        running?: boolean;
        scrapeProxy?: string;
        message?: string;
      };
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || t("settings.apiTorOperationFailed") });
        return;
      }
      setTorRunning(data.running ?? false);
      if (data.scrapeProxy !== undefined) {
        setForm((prev) => ({ ...prev, scrapeProxy: data.scrapeProxy!, torProxy: data.scrapeProxy! }));
      }
      // 起動時は scraper の再起動が必要なため、接続確認は後で手動で実行
      if (data.running) {
        setMessage({
          type: "success",
          text: data.message || t("settings.apiTorStarted"),
        });
      } else {
        setTorConnection(null);
        setMessage({ type: "success", text: data.message || t("settings.apiTorStopped") });
      }
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : t("common.communicationError") });
    } finally {
      setTorBusy(false);
    }
  }, [torRunning, t]);
  const handleTorCheck = useCallback(async () => {
    setTorChecking(true);
    setMessage(null);
    try {
      // 接続確認前に scraper を再起動（SCRAPE_PROXY の変更を反映）
      await fetch("/api/tor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restart-scraper" }) }).catch(() => {});
      // 少し待ってから接続確認
      await new Promise((r) => setTimeout(r, 3000));
      await fetchTorStatus();
      if (torConnection?.connected) {
        setMessage({ type: "success", text: t("settings.torConnSuccess", { torIp: torConnection.torIp ?? "", directIp: torConnection.directIp ?? "" }) });
      } else if (torConnection?.error) {
        setMessage({ type: "error", text: t("settings.torConnFail", { error: torConnection.error }) });
      } else {
        setMessage({ type: "warning", text: t("settings.torNotVia") });
      }
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : t("common.communicationError") });
    } finally {
      setTorChecking(false);
    }
  }, [fetchTorStatus, torConnection, t]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-label={t("settings.title")}
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-popover p-6 ring-1 ring-border animate-[modal-in_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("settings.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-1.5 text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground"
            aria-label={t("common.close")}
          >
            ✕
          </button>
        </div>

        {/* LLM 設定 */}
        <details className="mb-4" open>
          <summary className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-sm font-medium transition-colors duration-200 hover:bg-muted/70"><span aria-hidden="true">🤖</span>{t("settings.llmSettings")}</summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.llmBaseUrlLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.llmBaseUrlEnv")}</span>
              </label>
              <input
                type="text"
                value={form.llmBaseUrl ?? ""}
                onChange={(e) => update("llmBaseUrl", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.llmApiKeyLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.llmApiKeyEnv")}</span>
              </label>
              <input
                type="password"
                value={form.llmApiKey ?? ""}
                onChange={(e) => update("llmApiKey", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.llmModelLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.llmModelEnv")}</span>
              </label>
              <input
                type="text"
                value={form.llmModel ?? ""}
                onChange={(e) => update("llmModel", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.llmModelsLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.llmModelsEnv")}</span>
              </label>
              <input
                type="text"
                value={form.llmModels ?? ""}
                onChange={(e) => update("llmModels", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.thinkingEffort")}</span>
              </label>
              <input
                type="text"
                value={form.thinkingEffort ?? "medium"}
                onChange={(e) => update("thinkingEffort", e.target.value)}
                placeholder="none / low / medium / high / max"
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.thinkingEffortDesc")}
              </p>
            </div>
          </div>
        </details>

        {/* 埋め込みモデル */}
        <details className="mb-4">
          <summary className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-sm font-medium transition-colors duration-200 hover:bg-muted/70"><span aria-hidden="true">📐</span>{t("settings.embedModelLabel")}</summary>
          <div className="mt-3 space-y-3">
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.embedModelLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.embedModelEnv")}</span>
              </label>
              <select
                value={form.embedModel ?? ""}
                onChange={(e) => {
                  update("embedModel", e.target.value);
                  const opt = settings?.embedModelOptions.find((o) => o.model === e.target.value);
                  if (opt) {
                    update("embedDim", opt.dim);
                    update("embedProvider", opt.provider);
                  }
                }}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              >
                {settings?.embedModelOptions.map((o) => (
                  <option key={o.model} value={o.model}>
                    {o.label}（{o.provider === "http" ? t("settings.embedHttp") : t("settings.embedLocal")}）
                  </option>
                ))}
              </select>
              {settings && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settings.dbDimension", { current: String(settings.dbVectorDim || "(空)"), new: String(selectedOption?.dim ?? form.embedDim) })}
                </p>
              )}
            </div>
            {needsMigration && (
              <div className="rounded-2xl bg-yellow-500/10 p-3 ring-1 ring-yellow-500/30">
                <p className="text-sm font-medium text-yellow-600 dark:text-yellow-500">{t("settings.migrationNeeded")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settings.migrationDimChange", { current: settings!.dbVectorDim, new: selectedOption!.dim })}
                  <strong className="text-foreground"> {t("settings.migrationDataDeleted")}</strong>
                </p>
                <label className="mt-2 flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={migrationConfirmed}
                    onChange={(e) => setMigrationConfirmed(e.target.checked)}
                  />
                  {t("settings.migrationConfirm")}
                </label>
              </div>
            )}
          </div>
        </details>

        {/* Web 検索 */}
        <details className="mb-4">
          <summary className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-sm font-medium transition-colors duration-200 hover:bg-muted/70"><span aria-hidden="true">🔍</span>{t("settings.webSearch")}</summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.webSearchModel")}</span>
              </label>
              <input
                type="text"
                value={form.webSearchModel ?? "umans-coder"}
                onChange={(e) => update("webSearchModel", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                placeholder="umans-coder"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t("settings.webSearchModelDesc")}</p>
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.webSearchMaxResults")}</span>
              </label>
              <input
                type="number"
                min={1}
                max={20}
                value={form.webSearchMaxResults ?? 3}
                onChange={(e) => update("webSearchMaxResults", Number(e.target.value) || 3)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.webSearchMaxRounds")}</span>
              </label>
              <input
                type="number"
                min={1}
                max={5}
                value={form.webSearchMaxRounds ?? 2}
                onChange={(e) => update("webSearchMaxRounds", Number(e.target.value) || 2)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.webSearchMaxRoundsDesc")}
              </p>
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.webSearchScraperUrlLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.webSearchScraperUrlEnv")}</span>
              </label>
              <input
                type="text"
                value={form.scraperUrl ?? ""}
                onChange={(e) => update("scraperUrl", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.webSearchSearxngUrlLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.webSearchSearxngUrlEnv")}</span>
              </label>
              <input
                type="text"
                value={form.searxngUrl ?? ""}
                onChange={(e) => update("searxngUrl", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
          </div>
        </details>

        {/* Tor プロキシ */}
        <details className="mb-4">
          <summary className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-sm font-medium transition-colors duration-200 hover:bg-muted/70"><span aria-hidden="true">🧅</span>{t("settings.torProxy")}</summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* Tor 起動/停止トグル */}
            <div className="flex items-center justify-between rounded-2xl bg-muted/40 p-3 sm:col-span-2">
              <div>
                <p className="text-sm font-medium">
                  Tor {torRunning ? t("settings.torRunning") : t("settings.torStopped")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {torRunning
                    ? t("settings.torViaDesc")
                    : t("settings.torOffDesc")}
                </p>
              </div>
              <button
                type="button"
                onClick={handleTorToggle}
                disabled={torBusy}
                className={`rounded-xl px-3 py-1.5 text-sm text-white transition-all duration-200 disabled:opacity-50 ${
                  torRunning
                    ? "bg-red-600 hover:bg-red-700"
                    : "bg-green-600 hover:bg-green-700"
                }`}
              >
                {torBusy ? t("settings.torProcessing") : torRunning ? t("settings.torStop") : t("settings.torStart")}
              </button>
            </div>

            {/* Tor 接続確認 */}
            {torRunning && (
              <div className="rounded-2xl bg-muted/40 p-3 sm:col-span-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{t("settings.torConnectionStatus")}</p>
                  <button
                    type="button"
                    onClick={handleTorCheck}
                    disabled={torChecking}
                    className="rounded-xl bg-blue-600 px-2 py-1 text-xs text-white transition-all duration-200 hover:bg-blue-700 disabled:opacity-50"
                  >
                    {torChecking ? t("settings.torChecking") : t("settings.torCheckConfirm")}
                  </button>
                </div>
                {torChecking ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("settings.torCheckingConn")}
                  </p>
                ) : torConnection ? (
                  <div className="mt-2 space-y-1 text-xs">
                    {torConnection.connected ? (
                      <p className="font-medium text-green-600 dark:text-green-400">
                        {t("settings.torCheckOk")}
                      </p>
                    ) : torConnection.error ? (
                      <p className="font-medium text-red-600 dark:text-red-400">
                        {t("settings.torCheckFailed")}
                      </p>
                    ) : (
                      <p className="font-medium text-yellow-600 dark:text-yellow-500">
                        {t("settings.torCheckWarning")}
                      </p>
                    )}
                    {torConnection.directIp && (
                      <p className="text-muted-foreground">
                        {t("settings.torDirectIp", { ip: torConnection.directIp })}
                      </p>
                    )}
                    {torConnection.torIp && (
                      <p className="text-muted-foreground">
                        {t("settings.torExitIp", { ip: torConnection.torIp })}
                      </p>
                    )}
                    {torConnection.error && (
                      <p className="text-red-500">{torConnection.error}</p>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("settings.torCheckDesc")}
                  </p>
                )}
              </div>
            )}
            {/* 手動プロキシ設定（詳細） */}
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.torProxyLabelManual")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.torProxyEnv")}</span>
              </label>
              <input
                type="text"
                value={form.torProxy ?? ""}
                onChange={(e) => update("torProxy", e.target.value)}
                placeholder="socks5://tor:9050"
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.scrapeProxyLabelManual")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.scrapeProxyEnv")}</span>
              </label>
              <input
                type="text"
                value={form.scrapeProxy ?? ""}
                onChange={(e) => update("scrapeProxy", e.target.value)}
                placeholder="socks5://tor:9050"
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
          </div>
        </details>

        {/* Database */}
        <details className="mb-4">
          <summary className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-sm font-medium transition-colors duration-200 hover:bg-muted/70"><span aria-hidden="true">🗄️</span>{t("settings.database")}</summary>
          <div className="mt-3 space-y-3">
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.databaseUrlLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.databaseUrlEnv")}</span>
              </label>
              <input
                type="text"
                value={form.databaseUrl ?? ""}
                onChange={(e) => update("databaseUrl", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
          </div>
        </details>

        {/* メッセージ */}
        {message && (
          <div
            className={`mb-4 rounded-2xl p-3 text-sm ${
              message.type === "error"
                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                : message.type === "success"
                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                  : "bg-yellow-500/10 text-yellow-600 dark:text-yellow-500"
            }`}
          >
            {message.text}
          </div>
        )}

        {/* ボタン */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-muted px-3 py-1.5 text-sm transition-all duration-200 hover:bg-muted/80"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || (needsMigration && !migrationConfirmed)}
            className="rounded-xl bg-foreground px-4 py-2 text-sm text-background transition-all duration-200 hover:opacity-90 disabled:opacity-50"
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
