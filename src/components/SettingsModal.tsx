"use client";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { clientFetch } from "@/lib/clientFetch";
import { AnimateModal, MotionButton } from "@/components/ui/motion";


type EmbedModelOption = {
  model: string;
  dim: number;
  provider: "local" | "http";
  label: string;
};

type SettingsResponse = {
  // LLM
  llmApiKey: string;
  hasLlmApiKey: boolean;
  llmModel: string;
  llmFallbackModel: string;
  llmFallbackTimeoutMs: number;
  thinkingEffort: string;
  webSearchThinkingEffort: string;
  // Embeddings
  embedModel: string;
  embedDim: number;
  embedProvider: string;
  embedModelOptions: readonly EmbedModelOption[];
  dbVectorDim: number;
  dbPageEmbeddingsDim: number;
  // Web search
  webSearchModel: string;
  webSearchMaxResults: number;
  webSearchMaxRounds: number;
  scraperUrl: string;
  searxngUrl: string;
  // Tor proxy
  torProxy: string;
  scrapeProxy: string;
  // Database / runtime environment
  databaseUrl: string;
  hasDatabaseUrl: boolean;
  hostOs: string;
  tz: string;
  // Notion OAuth
  notionClientId: string;
  notionClientSecret: string;
  hasNotionClientSecret: boolean;
  // GitHub OAuth (Connections)
  githubConnectionsClientId: string;
  githubConnectionsClientSecret: string;
  hasGithubConnectionsClientSecret: boolean;
  // Google Connections OAuth
  googleConnectionsClientId: string;
  googleConnectionsClientSecret: string;
  hasGoogleConnectionsClientSecret: boolean;
  // Microsoft OAuth
  microsoftClientId: string;
  microsoftClientSecret: string;
  hasMicrosoftClientSecret: boolean;
  microsoftTenantId: string;
  authUrl: string;
  // Cloudflare Tunnel
  tunnelToken: string;
  hasTunnelToken: boolean;
  // Security
  registrationLocked: boolean;
  allowedRegistrationIps: string;
  // Default global instruction selection (per user, DB)
  activeInstructionId: string | null;
  // Personalization (per user, DB)
  personalStyle: string | null;
  personalWarmth: number;
  personalEnergy: number;
  personalStructure: number;
  personalEmoji: number;
  // Logging
  logLevel: string;
  logFileEnabled: string;
  logFilePath: string;
  // Translate default mode
  translateDefaultMulti: boolean;
  // Primary language for translate characteristics (null = follow UI locale)
  translatePrimaryLang: string | null;
  translateTimeout: number;
  // Chat export
  chatExportPath: string;
  chatExportMode: string;
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
  onOpenHelp?: (topic: string | null) => void;
};

/**
 * App settings modal (opened from the ⚙️ button in the sidebar).
 *
 * All .env settings are editable via GUI:
 * - LLM settings (API_KEY, MODEL, Thinking Effort, Fallback)
 * - Embedding model (migration confirmation on dimension change)
 * - Web search (max results, SCRAPER_URL, SEARXNG_URL)
 * - Tor proxy (TOR_PROXY, SCRAPE_PROXY)
 * - Database URL
 */
export function SettingsModal({ open, onClose, onOpenHelp }: Props) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<Partial<SettingsResponse>>({});
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelDisplayNames, setModelDisplayNames] = useState<Record<string, string>>({});
  const [modelReasoningLevels, setModelReasoningLevels] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success" | "warning"; text: string } | null>(null);
  const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const [torRunning, setTorRunning] = useState(false);
  const [torBusy, setTorBusy] = useState(false);
  const [torConnection, setTorConnection] = useState<TorConnection | null>(null);
  const [torChecking, setTorChecking] = useState(false);
  // Cloudflare Tunnel state
  const [tunnelRunning, setTunnelRunning] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  // Auto-update state (exe distribution only)
  const [updateInfo, setUpdateInfo] = useState<{
    currentVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
    downloadUrl: string | null;
    releaseNotes: string | null;
    isExe: boolean;
  } | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [connections, setConnections] = useState<{
    id: string;
    provider: string;
    workspaceName: string | null;
    workspaceIcon: string | null;
    ownerName: string | null;
    ownerEmail: string | null;
  }[]>([]);
  const [instructions, setInstructions] = useState<{ id: string; name: string; content: string }[]>([]);
  const [instrSaving, setInstrSaving] = useState(false);
  const [instrFormOpen, setInstrFormOpen] = useState(false);
  const [instrFormName, setInstrFormName] = useState("");
  const [instrFormContent, setInstrFormContent] = useState("");
  const [editingInstrId, setEditingInstrId] = useState<string | null>(null);

  const fetchTorStatus = useCallback(async (): Promise<TorConnection | null> => {
    try {
      const res = await clientFetch("/api/tor");
      if (!res.ok) return null;
      const data = (await res.json()) as {
        running: boolean;
        connection: TorConnection;
      };
      setTorRunning(data.running);
      setTorConnection(data.connection);
      return data.connection;
    } catch {
      // Ignore
      return null;
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await clientFetch("/api/settings");
      if (!res.ok) throw new Error(t("settings.fetchFailed"));
      const data = (await res.json()) as SettingsResponse;
      setSettings(data);
      setForm(data);
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : t("settings.fetchError") });
    }
  }, [t]);

  const fetchModels = useCallback(async () => {
    try {
      const res = await clientFetch("/api/models");
      if (!res.ok) return;
      const data = (await res.json()) as { models: string[]; displayNames?: Record<string, string>; reasoningLevels?: Record<string, string[]> };
      setModelList(data.models);
      setModelDisplayNames(data.displayNames ?? {});
      setModelReasoningLevels(data.reasoningLevels ?? {});
    } catch {
      // Silent failure: model selector stays as text fallback
    }
  }, []);

  const fetchConnections = useCallback(async () => {
    try {
      const res = await clientFetch("/api/connections");
      if (!res.ok) return;
      setConnections(await res.json());
    } catch {
      // Ignore
    }
  }, []);

  const fetchInstructions = useCallback(async () => {
    try {
      const res = await clientFetch("/api/global-instructions");
      if (!res.ok) return;
      setInstructions(await res.json());
    } catch {
      // Ignore
    }
  }, []);

  const handleDisconnect = useCallback(async (id: string) => {
    await clientFetch("/api/connections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setConnections((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // Auto-update: check for updates on modal open
  const fetchUpdateInfo = useCallback(async () => {
    setUpdateBusy(true);
    try {
      const res = await clientFetch("/api/update");
      if (!res.ok) return;
      const data = await res.json();
      setUpdateInfo(data);
    } catch {
      // Ignore
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  const handleDownloadUpdate = useCallback(async () => {
    if (!updateInfo?.downloadUrl) return;
    setUpdateBusy(true);
    setUpdateMessage(null);
    try {
      const res = await clientFetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          downloadUrl: updateInfo.downloadUrl,
          version: updateInfo.latestVersion,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setUpdateMessage(data.error || "Update failed");
        return;
      }
      setUpdateMessage(t("settings.updateDownloaded"));
      // Poll for server restart: reload when version changes
      const oldVersion = updateInfo.currentVersion;
      const poll = setInterval(async () => {
        try {
          const res = await clientFetch("/api/update");
          if (!res.ok) return;
          const data = await res.json();
          if (data.currentVersion !== oldVersion) {
            clearInterval(poll);
            window.location.reload();
          }
        } catch {
          // Server down during restart — keep polling
        }
      }, 2000);
    } catch (err) {
      setUpdateMessage(err instanceof Error ? err.message : t("common.communicationError"));
    } finally {
      setUpdateBusy(false);
    }
  }, [updateInfo, t]);

  useEffect(() => {
    if (open) {
      setMessage(null);
      setMigrationConfirmed(false);
      setActiveTab(0);
      void fetchSettings();
      void fetchModels();
      void fetchTorStatus();
      void fetchConnections();
      void fetchInstructions();
      void fetchUpdateInfo();
    }
  }, [open, fetchSettings, fetchModels, fetchTorStatus, fetchConnections, fetchInstructions, fetchUpdateInfo]);

  const update = useCallback(<K extends keyof SettingsResponse>(key: K, value: SettingsResponse[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setMigrationConfirmed(false);
  }, []);

  const selectedOption = settings?.embedModelOptions.find((o) => o.model === form.embedModel);
  const embedDirty =
    settings !== null &&
    (form.embedModel !== settings.embedModel ||
     (selectedOption?.dim ?? form.embedDim) !== settings.embedDim ||
     (selectedOption?.provider ?? form.embedProvider) !== settings.embedProvider);
  const needsMigration =
    embedDirty &&
    selectedOption !== undefined &&
    settings !== null &&
    settings.dbVectorDim > 0 &&
    selectedOption.dim !== settings.dbVectorDim;

  const searchReasoningLevels = modelReasoningLevels[form.webSearchModel ?? ""] ?? ["none", "low", "medium", "high", "max"];
  const currentReasoningLevels = modelReasoningLevels[form.llmModel ?? ""] ?? ["none", "low", "medium", "high", "max"];

  const handleSave = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        ...form,
        // Secret fields are not sent when empty (existing values are preserved).
        llmApiKey: form.llmApiKey || undefined,
        notionClientSecret: form.notionClientSecret || undefined,
        // databaseUrl may contain credentials; only send when user enters a new value
        databaseUrl: form.databaseUrl || undefined,
      };
      // Embed fields are only sent when the user changed them (embedDirty).
      // Sending embedModel/embedDim/embedProvider when unchanged would be harmless
      // for persistence, but strips applyMigration noise and avoids triggering
      // resetEmbedPipeline on the server for a no-op.
      if (embedDirty) {
        body.embedDim = selectedOption?.dim ?? form.embedDim;
        body.embedProvider = selectedOption?.provider ?? form.embedProvider;
        if (needsMigration && migrationConfirmed) body.applyMigration = true;
      } else {
        delete body.embedModel;
        delete body.embedDim;
        delete body.embedProvider;
        delete body.applyMigration;
      }
      // If embed changed + migration needed but not confirmed, strip embed
      // fields so the server saves the other settings without touching embed.
      if (embedDirty && needsMigration && !migrationConfirmed) {
        delete body.embedModel;
        delete body.embedDim;
        delete body.embedProvider;
        delete body.applyMigration;
      }
      const res = await clientFetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
        setMessage({ type: "success", text: t("settings.migrationComplete") });
      } else if (embedDirty && needsMigration && !migrationConfirmed) {
        // Embed change deferred — other settings were saved, but embed is untouched.
        setMessage({ type: "success", text: t("settings.savedWithoutEmbed") });
      } else {
        setMessage({ type: "success", text: t("settings.saved") });
      }
      // Re-sync server state and form (reflect latest values after save)
      await fetchSettings();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : t("common.communicationError") });
    } finally {
      setSaving(false);
    }
  }, [form, selectedOption, embedDirty, needsMigration, migrationConfirmed, fetchSettings, t]);
  // Partial settings persistence — sends only the changed key(s) immediately
  // (security lock, GSI default selection, allowed IPs on blur).
  // Does NOT re-fetch settings (would clobber the in-progress form).
  // On failure, shows an error; the caller is responsible for rolling back form state.
  const persistPartial = useCallback(async (body: Partial<SettingsResponse>): Promise<boolean> => {
    try {
      const res = await clientFetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage({ type: "error", text: data.error || t("settings.saveFailed") });
        return false;
      }
      return true;
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : t("common.communicationError") });
      return false;
    }
  }, [t]);

  const handleTorToggle = useCallback(async () => {
    setTorBusy(true);
    setMessage(null);
    try {
      const res = await clientFetch("/api/tor", {
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
      // Scraper restart is needed on startup, so connection check is done manually later
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
      // Regardless of Tor on/off, the scraper is already running with the latest SCRAPE_PROXY,
      // so only run a connection check (skip unnecessary restart)
      const result = await fetchTorStatus();
      if (result?.connected) {
        setMessage({ type: "success", text: t("settings.torConnSuccess", { torIp: result.torIp ?? "", directIp: result.directIp ?? "" }) });
      } else if (result?.error) {
        setMessage({ type: "error", text: t("settings.torConnFail", { error: result.error }) });
      } else {
        setMessage({ type: "warning", text: t("settings.torNotVia") });
      }
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : t("common.communicationError") });
    } finally {
      setTorChecking(false);
    }
  }, [fetchTorStatus, t]);

  // Cloudflare Tunnel start/stop
  const handleTunnelToggle = useCallback(async () => {
    setTunnelBusy(true);
    setMessage(null);
    try {
      if (tunnelRunning) {
        // Stop
        const res = await clientFetch("/api/tunnel", { method: "DELETE" });
        const data = (await res.json()) as { success?: boolean; error?: string; running?: boolean };
        if (!res.ok) {
          setMessage({ type: "error", text: data.error || t("settings.tunnelStopFailed") });
          return;
        }
        setTunnelRunning(false);
        setMessage({ type: "success", text: t("settings.tunnelStopped") });
      } else {
        // Start: send token + AUTH_URL
        const token = form.tunnelToken ?? "";
        const authUrl = form.authUrl ?? "";
        if (!authUrl.startsWith("https://")) {
          setMessage({ type: "error", text: t("settings.authUrlHttpsRequired") });
          return;
        }
        // If no token is entered, use the existing .env value (API-side fallback)
        const body: Record<string, string> = { authUrl };
        if (token) body.token = token;
        const res = await clientFetch("/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as { success?: boolean; error?: string; running?: boolean };
        if (!res.ok) {
          setMessage({ type: "error", text: data.error || t("settings.tunnelStartFailed") });
          return;
        }
        setTunnelRunning(data.running ?? true);
        setMessage({ type: "success", text: t("settings.tunnelStarted") });
      }
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : t("common.communicationError") });
    } finally {
      setTunnelBusy(false);
    }
  }, [tunnelRunning, form.tunnelToken, form.authUrl, t]);

  // Fetch tunnel state on initial load
  useEffect(() => {
    clientFetch("/api/tunnel")
      .then((res) => res.json())
      .then((data: { running?: boolean; hasToken?: boolean; authUrl?: string }) => {
        setTunnelRunning(data.running ?? false);
      })
      .catch(() => {});
  }, []);
  const handleSaveInstruction = useCallback(async () => {
    const name = instrFormName.trim();
    const content = instrFormContent.trim();
    if (!name || !content) {
      setMessage({ type: "error", text: t("settings.gsiNameContentRequired") });
      return;
    }
    setInstrSaving(true);
    try {
      if (editingInstrId) {
        const res = await clientFetch(`/api/global-instructions/${editingInstrId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, content }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        const res = await clientFetch("/api/global-instructions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, content }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      setInstrFormName("");
      setInstrFormContent("");
      setInstrFormOpen(false);
      setEditingInstrId(null);
      await fetchInstructions();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : t("common.communicationError") });
    } finally {
      setInstrSaving(false);
    }
  }, [instrFormName, instrFormContent, editingInstrId, fetchInstructions, t]);

  const handleEditInstruction = useCallback(
    (id: string) => {
      const instr = instructions.find((i) => i.id === id);
      if (!instr) return;
      setEditingInstrId(id);
      setInstrFormName(instr.name);
      setInstrFormContent(instr.content);
      setInstrFormOpen(true);
    },
    [instructions],
  );

  const handleDeleteInstruction = useCallback(
    async (id: string) => {
      try {
        const res = await clientFetch(`/api/global-instructions/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Clear selection if the deleted row was active
        if (form.activeInstructionId === id) {
          update("activeInstructionId", null);
          void persistPartial({ activeInstructionId: null });
        }
        await fetchInstructions();
      } catch (err) {
        setMessage({ type: "error", text: err instanceof Error ? err.message : t("common.communicationError") });
      }
    },
    [form.activeInstructionId, update, persistPartial, fetchInstructions, t],
  );
  const tabs = [
    { icon: "🤖", label: t("settings.tabAiModels") },
    { icon: "🔍", label: t("settings.tabSearchNetwork") },
    { icon: "🖥️", label: t("settings.tabSystem") },
    { icon: "🔗", label: t("settings.tabConnections") },
    { icon: "🌐", label: t("settings.tabServerAccess") },
    { icon: "🎨", label: t("personalization.title") },
  ];

  return (
    <AnimateModal open={open} onClose={onClose} ariaLabel={t("settings.title")} panelClassName="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("settings.title")}</h2>
        <MotionButton
          type="button"
          onClick={onClose}
          className="rounded-xl p-1.5 text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground"
          aria-label={t("common.close")}
        >
          ✕
        </MotionButton>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row" style={{ minHeight: "400px" }}>
        {/* Vertical tab rail */}
        <div className="flex shrink-0 gap-1 overflow-x-auto sm:w-40 sm:flex-col sm:overflow-visible">
          {tabs.map((tab, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActiveTab(i)}
              className={`shrink-0 whitespace-nowrap flex items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-all duration-200 ${
                activeTab === i
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <span aria-hidden="true">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
        {/* Tab content — scrollable */}
        <div className="flex-1 overflow-y-auto pr-1">
          {activeTab === 0 && (
          <div className="space-y-6">
        {/* LLM settings */}
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.llmApiKeyLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.llmApiKeyEnv")}</span>
              </label>
              <input
                type="password"
                value={form.llmApiKey ?? ""}
                onChange={(e) => update("llmApiKey", e.target.value)}
                placeholder={settings?.hasLlmApiKey ? t("settings.placeholderUpdate") : ""}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.llmModelLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.llmModelEnv")}</span>
              </label>
              <select
                value={form.llmModel ?? ""}
                onChange={(e) => update("llmModel", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              >
                {modelList.map((m) => (
                  <option key={m} value={m}>{modelDisplayNames[m] ?? m}</option>
                ))}
                {!modelList.includes(form.llmModel ?? "") && form.llmModel && (
                  <option value={form.llmModel}>{modelDisplayNames[form.llmModel] ?? form.llmModel}</option>
                )}
              </select>
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.llmFallbackModelLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.llmFallbackModelEnv")}</span>
              </label>
              <select
                value={form.llmFallbackModel ?? ""}
                onChange={(e) => update("llmFallbackModel", e.target.value || "")}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              >
                <option value="">— (disabled)</option>
                {modelList.map((m) => (
                  <option key={m} value={m}>{modelDisplayNames[m] ?? m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.llmFallbackTimeoutLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.llmFallbackTimeoutEnv")}</span>
              </label>
              <input
                type="number"
                value={form.llmFallbackTimeoutMs ?? 10000}
                onChange={(e) => update("llmFallbackTimeoutMs", Number(e.target.value))}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.thinkingEffort")}</span>
              </label>
              <select
                value={currentReasoningLevels.length === 0 ? "" : (form.thinkingEffort ?? "medium")}
                onChange={(e) => update("thinkingEffort", e.target.value)}
                disabled={currentReasoningLevels.length === 0}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20 disabled:opacity-50"
              >
                {currentReasoningLevels.length === 0 ? (
                  <option value="" disabled>(not controllable)</option>
                ) : (
                  currentReasoningLevels.map((lvl) => (
                    <option key={lvl} value={lvl}>{lvl}</option>
                  ))
                )}
                {currentReasoningLevels.length > 0 && !currentReasoningLevels.includes(form.thinkingEffort ?? "medium") && form.thinkingEffort && (
                  <option value={form.thinkingEffort}>{form.thinkingEffort} (stale)</option>
                )}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {currentReasoningLevels.length === 0
                  ? t("settings.thinkingEffortNotControllable")
                  : t("settings.thinkingEffortDesc")}
              </p>
            </div>
            <div className="sm:col-span-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.translateDefaultMulti ?? false}
                  onChange={(e) => {
                    update("translateDefaultMulti", e.target.checked);
                    void persistPartial({ translateDefaultMulti: e.target.checked });
                  }}
                />
                <span className="text-xs font-medium text-foreground">{t("settings.translateDefaultMulti")}</span>
                <span className="text-[10px] text-muted-foreground">{t("settings.translateDefaultMultiDesc")}</span>
              </label>
            </div>
            <div className="sm:col-span-2">
              <label className="block">
                <span className="block text-xs font-medium text-foreground">{t("settings.translatePrimaryLang")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.translatePrimaryLangDesc")}</span>
              </label>
              <select
                value={form.translatePrimaryLang ?? ""}
                onChange={(e) => {
                  const val = e.target.value || null;
                  update("translatePrimaryLang", val);
                  void persistPartial({ translatePrimaryLang: val });
                }}
                className="mt-1 w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              >
                <option value="">{t("settings.translatePrimaryLangAuto")}</option>
                <option value="ja">日本語</option>
                <option value="en">English</option>
                <option value="zh">中文（简体）</option>
                <option value="ko">한국어</option>
                <option value="es">Español</option>
                <option value="fr">Français</option>
                <option value="de">Deutsch</option>
                <option value="pt">Português</option>
                <option value="ru">Русский</option>
                <option value="ar">العربية</option>
                <option value="it">Italiano</option>
                <option value="vi">Tiếng Việt</option>
                <option value="th">ไทย</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.translateTimeout")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.translateTimeoutDesc")}</span>
              </label>
              <input
                type="number"
                min={5}
                max={300}
                value={form.translateTimeout ?? 30}
                onChange={(e) => update("translateTimeout", Math.min(300, Math.max(5, Number(e.target.value) || 30)))}
                className="mt-1 w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
          </div>

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
                  {t("settings.dbDimension", { current: String(settings.dbVectorDim || t("settings.dbVectorDimEmpty")), new: String(selectedOption?.dim ?? form.embedDim) })}
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

          {/* Global system instructions — save multiple and select */}
          <div className="mt-3">
            <span className="mb-1 block text-xs font-medium text-foreground">
              {t("settings.globalSystemInstruction")}
            </span>
            {instructions.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                {t("settings.gsiNone")}
              </p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {instructions.map((instr) => (
                  <div key={instr.id} className="flex items-center gap-2 rounded-lg px-1 py-1 text-xs hover:bg-muted/50">
                    <label className="flex flex-1 items-center gap-2">
                      <input
                        type="radio"
                        name="active-instruction"
                        checked={form.activeInstructionId === instr.id}
                      onChange={() => {
                        update("activeInstructionId", instr.id);
                        void persistPartial({ activeInstructionId: instr.id });
                      }}
                      />
                      <span>{instr.name}</span>
                    </label>
                    <button type="button" onClick={() => handleEditInstruction(instr.id)} className="text-muted-foreground hover:text-foreground" aria-label={t("settings.gsiEdit")}>✎</button>
                    <button type="button" onClick={() => void handleDeleteInstruction(instr.id)} className="text-muted-foreground hover:text-foreground" aria-label={t("settings.gsiDelete")}>✕</button>
                  </div>
                ))}
              </div>
            )}
            {/* Clear selection */}
            {form.activeInstructionId && (
              <button type="button" onClick={() => { update("activeInstructionId", null); void persistPartial({ activeInstructionId: null }); }} className="mt-1 rounded-lg px-1 py-1 text-left text-xs text-muted-foreground hover:text-foreground">
                {t("settings.gsiClearSelection")}
              </button>
            )}
            {/* Add/edit form toggle */}
            <button type="button" onClick={() => { setInstrFormOpen(v => !v); setEditingInstrId(null); setInstrFormName(""); setInstrFormContent(""); }} className="rounded-lg px-1 py-1 text-left text-xs text-muted-foreground hover:text-foreground">
              {t("settings.gsiAdd")}
            </button>
            {instrFormOpen && (
              <div className="flex flex-col gap-2 rounded-xl bg-muted px-2 py-2 text-xs">
                <input value={instrFormName} onChange={(e) => setInstrFormName(e.target.value)} placeholder={t("settings.gsiNamePlaceholder")} className="rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20" />
                <textarea value={instrFormContent} onChange={(e) => setInstrFormContent(e.target.value)} rows={4} placeholder={t("settings.gsiContentPlaceholder")} className="resize-y rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20" />
                <button type="button" onClick={() => void handleSaveInstruction()} disabled={instrSaving} className="rounded-lg bg-foreground px-2 py-1 text-background hover:opacity-90 disabled:opacity-40">
                  {editingInstrId ? t("settings.gsiUpdate") : t("settings.gsiAddButton")}
                </button>
              </div>
            )}
          </div>
          </div>
          )}
          {activeTab === 1 && (
          <div className="space-y-6">
        {/* Web search */}
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.webSearchModel")}</span>
              </label>
              <select
                value={form.webSearchModel ?? "umans-qwen3.6-35b-a3b"}
                onChange={(e) => update("webSearchModel", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              >
                {modelList.map((m) => (
                  <option key={m} value={m}>{modelDisplayNames[m] ?? m}</option>
                ))}
                {!modelList.includes(form.webSearchModel ?? "") && form.webSearchModel && (
                  <option value={form.webSearchModel}>{modelDisplayNames[form.webSearchModel] ?? form.webSearchModel}</option>
                )}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">{t("settings.webSearchModelDesc")}</p>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.webSearchThinkingEffort")}</span>
              </label>
              <select
                value={searchReasoningLevels.length === 0 ? "" : (form.webSearchThinkingEffort ?? "none")}
                onChange={(e) => update("webSearchThinkingEffort", e.target.value)}
                disabled={searchReasoningLevels.length === 0}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20 disabled:opacity-50"
              >
                {searchReasoningLevels.length === 0 ? (
                  <option value="" disabled>(not controllable)</option>
                ) : (
                  searchReasoningLevels.map((lvl) => (
                    <option key={lvl} value={lvl}>{lvl}</option>
                  ))
                )}
                {searchReasoningLevels.length > 0 && !searchReasoningLevels.includes(form.webSearchThinkingEffort ?? "none") && form.webSearchThinkingEffort && (
                  <option value={form.webSearchThinkingEffort}>{form.webSearchThinkingEffort} (stale)</option>
                )}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {searchReasoningLevels.length === 0
                  ? t("settings.thinkingEffortNotControllable")
                  : t("settings.webSearchThinkingEffortDesc")}
              </p>
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
                onChange={(e) => update("webSearchMaxResults", Math.min(20, Math.max(1, Number(e.target.value) || 3)))}
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
                value={form.webSearchMaxRounds ?? 3}
                onChange={(e) => update("webSearchMaxRounds", Math.min(5, Math.max(1, Number(e.target.value) || 3)))}
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

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* Tor start/stop toggle */}
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

            {/* Tor connection check */}
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
            {/* Manual proxy settings (advanced) */}
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
          </div>
          )}
          {activeTab === 2 && (
          <div className="space-y-6">
        {/* Runtime environment */}
          <div className="mt-3 space-y-3">
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.hostOsLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.hostOsEnv")}</span>
              </label>
              <input
                type="text"
                value={form.hostOs ?? ""}
                onChange={(e) => update("hostOs", e.target.value)}
                placeholder={t("settings.hostOsPlaceholder")}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.tzLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.tzEnv")}</span>
              </label>
              <input
                type="text"
                value={form.tz ?? ""}
                onChange={(e) => update("tz", e.target.value)}
                placeholder={t("settings.tzPlaceholder")}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
          </div>
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
                placeholder={settings?.hasDatabaseUrl ? t("settings.placeholderUpdate") : ""}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
          </div>
          {/* Update */}
          {updateInfo?.isExe && (
            <div className="mt-3 space-y-3 rounded-xl border border-border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="block text-xs font-medium text-foreground">
                    {t("settings.updateVersion")}: {updateInfo.currentVersion}
                  </span>
                  {updateInfo.updateAvailable ? (
                    <span className="block text-xs text-amber-500">
                      {t("settings.updateAvailable")}: {updateInfo.latestVersion}
                    </span>
                  ) : (
                    <span className="block text-xs text-muted-foreground">
                      {t("settings.updateLatest")}
                    </span>
                  )}
                </div>
                {updateInfo.updateAvailable ? (
                  <MotionButton
                    type="button"
                    onClick={handleDownloadUpdate}
                    disabled={updateBusy}
                    className="rounded-xl bg-foreground px-3 py-1.5 text-xs text-background transition-all duration-200 hover:opacity-90 disabled:opacity-50"
                  >
                    {updateBusy ? t("settings.updateProcessing") : t("settings.updateInstall")}
                  </MotionButton>
                ) : (
                  <MotionButton
                    type="button"
                    onClick={fetchUpdateInfo}
                    disabled={updateBusy}
                    className="rounded-xl bg-muted px-3 py-1.5 text-xs text-foreground transition-all duration-200 hover:opacity-80 disabled:opacity-50"
                  >
                    {updateBusy ? t("settings.updateChecking") : t("settings.updateCheck")}
                  </MotionButton>
                )}
              </div>
              {updateMessage && (
                <p className="text-xs text-muted-foreground">{updateMessage}</p>
              )}
            </div>
          )}
          {/* Logging */}
          <div className="mt-3 space-y-3 rounded-xl border border-border p-4">
            <span className="block text-xs font-medium text-foreground">{t("settings.logSectionTitle")}</span>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.logLevelLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.logLevelHint")}</span>
              </label>
              <select
                value={form.logLevel ?? "info"}
                onChange={(e) => update("logLevel", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              >
                <option value="debug">debug</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.logFileEnabledLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.logFileEnabledHint")}</span>
              </label>
              <select
                value={form.logFileEnabled ?? "true"}
                onChange={(e) => update("logFileEnabled", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              >
                <option value="true">{t("common.enabled")}</option>
                <option value="false">{t("common.disabled")}</option>
              </select>
            </div>
            <div>
              <span className="block text-[10px] text-muted-foreground">{t("settings.logFilePathLabel")}</span>
              <p className="break-all text-[10px] text-muted-foreground/70">{form.logFilePath}</p>
            </div>
          </div>
          {/* Chat export */}
          <div className="mt-3 space-y-3 rounded-xl border border-border p-4">
            <span className="block text-xs font-medium text-foreground">{t("settings.chatExportSectionTitle")}</span>
            {onOpenHelp && (
              <button
                type="button"
                onClick={() => onOpenHelp("system.chatExport")}
                className="ml-2 inline-block text-xs text-foreground underline"
              >
                {t("help.openInHelp")} →
              </button>
            )}
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.chatExportPathLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.chatExportPathHint")}</span>
              </label>
              <input
                type="text"
                value={form.chatExportPath ?? ""}
                onChange={(e) => update("chatExportPath", e.target.value)}
                placeholder={t("settings.chatExportPathPlaceholder")}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.chatExportModeLabel")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.chatExportModeHint")}</span>
              </label>
              <select
                value={form.chatExportMode ?? "daily"}
                onChange={(e) => update("chatExportMode", e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              >
                <option value="daily">{t("settings.chatExportModeDaily")}</option>
                <option value="thread">{t("settings.chatExportModeThread")}</option>
              </select>
            </div>
          </div>
          </div>
          )}
          {activeTab === 3 && (
          <div className="space-y-6">
        {/* Connections */}
          <div className="mt-3 space-y-3">
            <div className="rounded-xl bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">
                {t("help.connectionsWhatIs")}
              </p>
              {onOpenHelp && (
                <button
                  type="button"
                  onClick={() => onOpenHelp("connections.notion")}
                  className="mt-1 inline-block text-xs text-foreground underline"
                >
                  {t("help.openInHelp")} →
                </button>
              )}
            </div>
            {/* Active connections list (all providers) */}
            {connections.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("settings.noConnections")}</p>
            ) : (
              connections.map((conn) => (
                <div key={conn.id} className="flex items-center gap-2 rounded-xl bg-muted/40 p-3">
                  {conn.workspaceIcon && <img src={conn.workspaceIcon} alt="" className="h-5 w-5 rounded" />}
                  <div className="flex-1">
                    <p className="text-sm font-medium">{conn.workspaceName ?? conn.provider}</p>
                    <p className="text-xs text-muted-foreground">{conn.ownerEmail ?? conn.ownerName}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{conn.provider}</span>
                  <button type="button" onClick={() => void handleDisconnect(conn.id)} className="text-xs text-muted-foreground hover:text-foreground">
                    {t("settings.disconnect")}
                  </button>
                </div>
              ))
            )}
            {/* Notion OAuth settings */}
            <div className="mt-4 rounded-xl border border-border p-3 space-y-3">
              <p className="text-xs font-medium text-foreground">Notion</p>
              <div>
                <label className="mb-1 block">
                  <span className="block text-xs font-medium text-foreground">NOTION_CLIENT_ID</span>
                  <span className="block text-[10px] text-muted-foreground">{t("settings.notionClientIdHint")}</span>
                </label>
                <input
                  type="text"
                  value={form.notionClientId ?? ""}
                  onChange={(e) => update("notionClientId", e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                />
              </div>
              <div>
                <label className="mb-1 block">
                  <span className="block text-xs font-medium text-foreground">NOTION_CLIENT_SECRET</span>
                  <span className="block text-[10px] text-muted-foreground">{t("settings.notionClientSecretHint")}</span>
                </label>
                <input
                  type="password"
                  value={form.notionClientSecret ?? ""}
                  onChange={(e) => update("notionClientSecret", e.target.value)}
                  placeholder={settings?.hasNotionClientSecret ? t("settings.placeholderUpdate") : "secret_..."}
                  className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                />
              </div>
              {form.notionClientId ? (
                <a href="/api/connections/notion/authorize" className="inline-block rounded-xl bg-foreground px-3 py-1.5 text-xs text-background hover:opacity-90">
                  {t("settings.connectNotion")}
                </a>
              ) : (
                <p className="text-xs text-muted-foreground">{t("settings.saveFirst")}</p>
              )}
            </div>
            {/* GitHub OAuth settings */}
            <div className="rounded-xl border border-border p-3 space-y-3">
              <p className="text-xs font-medium text-foreground">GitHub</p>
              <div>
                <label className="mb-1 block">
                  <span className="block text-xs font-medium text-foreground">GITHUB_CONNECTIONS_CLIENT_ID</span>
                  <span className="block text-[10px] text-muted-foreground">{t("settings.githubClientIdHint")}</span>
                </label>
                <input
                  type="text"
                  value={form.githubConnectionsClientId ?? ""}
                  onChange={(e) => update("githubConnectionsClientId", e.target.value)}
                  placeholder="Iv1.1234567890abcdef"
                  className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                />
              </div>
              <div>
                <label className="mb-1 block">
                  <span className="block text-xs font-medium text-foreground">GITHUB_CONNECTIONS_CLIENT_SECRET</span>
                  <span className="block text-[10px] text-muted-foreground">{t("settings.githubClientSecretHint")}</span>
                </label>
                <input
                  type="password"
                  value={form.githubConnectionsClientSecret ?? ""}
                  onChange={(e) => update("githubConnectionsClientSecret", e.target.value)}
                  placeholder={settings?.hasGithubConnectionsClientSecret ? t("settings.placeholderUpdate") : "secret_..."}
                  className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                />
              </div>
              {form.githubConnectionsClientId ? (
                <a href="/api/connections/github/authorize" className="inline-block rounded-xl bg-foreground px-3 py-1.5 text-xs text-background hover:opacity-90">
                  {t("settings.connectGithub")}
                </a>
              ) : (
                <p className="text-xs text-muted-foreground">{t("settings.saveFirst")}</p>
              )}
            </div>
            {/* Google Connections OAuth settings (shared: Gmail + Drive + Calendar) */}
            <div className="rounded-xl border border-border p-3 space-y-3">
              <p className="text-xs font-medium text-foreground">Google (Gmail / Drive / Calendar)</p>
              <div>
                <label className="mb-1 block">
                  <span className="block text-xs font-medium text-foreground">GOOGLE_CONNECTIONS_CLIENT_ID</span>
                  <span className="block text-[10px] text-muted-foreground">{t("settings.googleConnectionsClientIdHint")}</span>
                </label>
                <input
                  type="text"
                  value={form.googleConnectionsClientId ?? ""}
                  onChange={(e) => update("googleConnectionsClientId", e.target.value)}
                  placeholder="123456789-abcdef.apps.googleusercontent.com"
                  className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                />
              </div>
              <div>
                <label className="mb-1 block">
                  <span className="block text-xs font-medium text-foreground">GOOGLE_CONNECTIONS_CLIENT_SECRET</span>
                  <span className="block text-[10px] text-muted-foreground">{t("settings.googleConnectionsClientSecretHint")}</span>
                </label>
                <input
                  type="password"
                  value={form.googleConnectionsClientSecret ?? ""}
                  onChange={(e) => update("googleConnectionsClientSecret", e.target.value)}
                  placeholder={settings?.hasGoogleConnectionsClientSecret ? t("settings.placeholderUpdate") : "GOCSPX-..."}
                  className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {form.googleConnectionsClientId ? (
                  <>
                    <a href="/api/connections/gmail/authorize" className="inline-block rounded-xl bg-foreground px-3 py-1.5 text-xs text-background hover:opacity-90">
                      {t("settings.connectGmail")}
                    </a>
                    <a href="/api/connections/google_drive/authorize" className="inline-block rounded-xl bg-foreground px-3 py-1.5 text-xs text-background hover:opacity-90">
                      {t("settings.connectGoogleDrive")}
                    </a>
                    <a href="/api/connections/google_calendar/authorize" className="inline-block rounded-xl bg-foreground px-3 py-1.5 text-xs text-background hover:opacity-90">
                      {t("settings.connectGoogleCalendar")}
                    </a>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("settings.saveFirst")}</p>
                )}
              </div>
            </div>
            {/* Microsoft OAuth settings (shared: Outlook Mail + Calendar) */}
            <div className="rounded-xl border border-border p-3 space-y-3">
              <p className="text-xs font-medium text-foreground">Microsoft (Outlook Mail / Calendar)</p>
              <div>
                <label className="mb-1 block">
                  <span className="block text-xs font-medium text-foreground">MICROSOFT_CLIENT_ID</span>
                  <span className="block text-[10px] text-muted-foreground">{t("settings.microsoftClientIdHint")}</span>
                </label>
                <input
                  type="text"
                  value={form.microsoftClientId ?? ""}
                  onChange={(e) => update("microsoftClientId", e.target.value)}
                  placeholder="12345678-1234-1234-1234-123456789012"
                  className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                />
              </div>
              <div>
                <label className="mb-1 block">
                  <span className="block text-xs font-medium text-foreground">MICROSOFT_CLIENT_SECRET</span>
                  <span className="block text-[10px] text-muted-foreground">{t("settings.microsoftClientSecretHint")}</span>
                </label>
                <input
                  type="password"
                  value={form.microsoftClientSecret ?? ""}
                  onChange={(e) => update("microsoftClientSecret", e.target.value)}
                  placeholder={settings?.hasMicrosoftClientSecret ? t("settings.placeholderUpdate") : "secret_..."}
                  className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                />
              </div>
              <div>
                <label className="mb-1 block">
                  <span className="block text-xs font-medium text-foreground">MICROSOFT_TENANT_ID</span>
                  <span className="block text-[10px] text-muted-foreground">{t("settings.microsoftTenantIdHint")}</span>
                </label>
                <input
                  type="text"
                  value={form.microsoftTenantId ?? ""}
                  onChange={(e) => update("microsoftTenantId", e.target.value)}
                  placeholder="common"
                  className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {form.microsoftClientId ? (
                  <>
                    <a href="/api/connections/outlook/authorize" className="inline-block rounded-xl bg-foreground px-3 py-1.5 text-xs text-background hover:opacity-90">
                      {t("settings.connectOutlook")}
                    </a>
                    <a href="/api/connections/outlook_calendar/authorize" className="inline-block rounded-xl bg-foreground px-3 py-1.5 text-xs text-background hover:opacity-90">
                      {t("settings.connectOutlookCalendar")}
                    </a>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("settings.saveFirst")}</p>
                )}
              </div>
            </div>
          </div>
          </div>
          )}
          {activeTab === 4 && (
          <div className="space-y-6">
        {/* Server Access — AUTH_URL + Tunnel + Security */}
          <div className="mt-3 space-y-3">
            <div>
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">AUTH_URL</span>
                <span className="block text-[10px] text-muted-foreground">{t("settings.authUrlHint")}</span>
              </label>
              <input
                type="text"
                value={form.authUrl ?? ""}
                onChange={(e) => update("authUrl", e.target.value)}
                placeholder="http://localhost:3001"
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            {/* Cloudflare Tunnel */}
            <div className="mt-4 space-y-3 rounded-2xl bg-muted/30 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">
                    Cloudflare Tunnel {tunnelRunning ? t("settings.torRunning") : t("settings.torStopped")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {tunnelRunning
                      ? t("settings.tunnelRunningDesc")
                      : t("settings.tunnelTokenPrompt")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleTunnelToggle}
                  disabled={tunnelBusy}
                  className={`rounded-xl px-3 py-1.5 text-sm text-white transition-all duration-200 disabled:opacity-50 ${
                    tunnelRunning
                      ? "bg-red-600 hover:bg-red-700"
                      : "bg-green-600 hover:bg-green-700"
                  }`}
                >
                  {tunnelBusy
                    ? t("settings.tunnelProcessingBtn")
                    : tunnelRunning
                      ? t("settings.tunnelStopBtn")
                      : t("settings.tunnelStartBtn")}
                </button>
              </div>
              <div>
                <label className="mb-1 block">
                  <span className="block text-xs font-medium text-foreground">Tunnel Token</span>
                  <span className="block text-[10px] text-muted-foreground">
                    {t("settings.tunnelTokenCopyHint")}
                  </span>
                </label>
                <input
                  type="password"
                  value={form.tunnelToken ?? ""}
                  onChange={(e) => update("tunnelToken", e.target.value)}
                  placeholder={
                    settings?.hasTunnelToken
                      ? t("settings.placeholderUpdate")
                      : "eyJhIjoi..."
                  }
                  className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                />
              </div>
            </div>
            {/* Security — registration lock + IP whitelist */}
            <div className="mt-4 space-y-3 rounded-2xl bg-muted/30 p-4">
              <h3 className="text-sm font-semibold text-foreground">{t("settings.security")}</h3>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={form.registrationLocked ?? false}
                  onChange={(e) => {
                    const next = e.target.checked;
                    update("registrationLocked", next);
                    void persistPartial({ registrationLocked: next }).then((ok) => {
                      if (!ok) update("registrationLocked", !next);
                    });
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
                />
                <span>
                  <span className="block text-sm text-foreground">{t("settings.registrationLocked")}</span>
                  <span className="block text-xs text-muted-foreground">{t("settings.registrationLockedDesc")}</span>
                </span>
              </label>
              <div>
                <label className="mb-1 block">
                  <span className="block text-sm text-foreground">{t("settings.allowedIps")}</span>
                  <span className="block text-xs text-muted-foreground">{t("settings.allowedIpsDesc")}</span>
                </label>
                <input
                  type="text"
                  value={form.allowedRegistrationIps ?? ""}
                  onChange={(e) => update("allowedRegistrationIps", e.target.value)}
                  placeholder={t("settings.allowedIpsPlaceholder")}
                  className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
                  onBlur={() => {
                    void persistPartial({ allowedRegistrationIps: form.allowedRegistrationIps ?? "" });
                  }}
                />
              </div>
            </div>
          </div>
          </div>
          )}
          {activeTab === 5 && (
          <div className="space-y-6">
            <div className="mt-3 space-y-4">
              {/* Style/tone presets */}
              <div>
                <label className="mb-2 block text-xs font-medium text-foreground">
                  {t("personalization.style")}
                </label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <button
                    type="button"
                    onClick={() => update("personalStyle", null)}
                    className={`rounded-xl px-3 py-2 text-sm transition-all duration-200 ${
                      form.personalStyle == null
                        ? "bg-foreground text-background"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t("personalization.styleNone")}
                  </button>
                  {([
                    { id: "standard", key: "styleStandard" },
                    { id: "polite", key: "stylePolite" },
                    { id: "casual", key: "styleCasual" },
                    { id: "concise", key: "styleConcise" },
                    { id: "detailed", key: "styleDetailed" },
                    { id: "academic", key: "styleAcademic" },
                    { id: "creative", key: "styleCreative" },
                    { id: "technical", key: "styleTechnical" },
                  ] as const).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => update("personalStyle", opt.id)}
                      className={`rounded-xl px-3 py-2 text-sm transition-all duration-200 ${
                        form.personalStyle === opt.id
                          ? "bg-foreground text-background"
                          : "bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t(`personalization.${opt.key}`)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Trait sliders */}
              {([
                { key: "personalWarmth", label: "warmth" },
                { key: "personalEnergy", label: "energy" },
                { key: "personalStructure", label: "structure" },
                { key: "personalEmoji", label: "emoji" },
              ] as const).map((slider) => {
                const val = form[slider.key] ?? 1;
                const disabled = form.personalStyle == null;
                return (
                  <div key={slider.key} className="flex items-center gap-3">
                    <label className={`w-32 text-xs font-medium ${disabled ? "text-muted-foreground/50" : "text-foreground"}`}>
                      {t(`personalization.${slider.label}`)}
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={1}
                      value={val}
                      disabled={disabled}
                      onChange={(e) => update(slider.key, Number(e.target.value))}
                      className="w-32 disabled:opacity-50"
                    />
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {[t("personalization.levelLow"), t("personalization.levelMedium"), t("personalization.levelHigh")][val]}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          )}
        </div>
      </div>

        {/* Message */}
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

        {/* Buttons */}
        <div className="flex justify-end gap-2">
          <MotionButton
            type="button"
            onClick={onClose}
            className="rounded-xl bg-muted px-3 py-1.5 text-sm transition-all duration-200 hover:bg-muted/80"
          >
            {t("common.cancel")}
          </MotionButton>
          <MotionButton
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-xl bg-foreground px-4 py-2 text-sm text-background transition-all duration-200 hover:opacity-90 disabled:opacity-50"
          >
            {saving ? t("common.saving") : t("common.save")}
          </MotionButton>
        </div>
    </AnimateModal>
  );
}
