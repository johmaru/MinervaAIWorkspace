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
    mcpServerIds?: string[];
  }) => Promise<void>;
};

type McpServerListItem = {
  id: string;
  name: string;
  transport: string;
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
  const [mcpServers, setMcpServers] = useState<McpServerListItem[]>([]);
  const [selectedMcpIds, setSelectedMcpIds] = useState<string[]>(thread.mcpServerIds ?? []);
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [mcpFormName, setMcpFormName] = useState("");
  const [mcpFormTransport, setMcpFormTransport] = useState<"http" | "stdio">("http");
  const [mcpFormUrl, setMcpFormUrl] = useState("");
  const [mcpFormCommand, setMcpFormCommand] = useState("");
  const [mcpFormArgs, setMcpFormArgs] = useState("");
  const [mcpAdding, setMcpAdding] = useState(false);

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

  // MCP サーバー一覧取得
  const fetchMcpServers = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp-servers");
      if (!res.ok) return;
      const data = await res.json();
      setMcpServers(Array.isArray(data) ? data : []);
    } catch {
      // サイレント失敗
    }
  }, []);
  useEffect(() => {
    void fetchMcpServers();
  }, [fetchMcpServers]);

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
    setSelectedMcpIds(thread.mcpServerIds ?? []);
    setSaved(false);
  }, [thread.id, thread.systemPrompt, thread.model, thread.responseMode, thread.dualModelA, thread.dualModelB, thread.dualStrategy, thread.dualDebateRounds, thread.mcpServerIds]);

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
        mcpServerIds: selectedMcpIds,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [systemPrompt, model, responseMode, dualModelA, dualModelB, thread.dualModelB, thread.model, models, dualStrategy, dualDebateRounds, selectedMcpIds, onUpdate]);

  const dirty =
    systemPrompt !== (thread.systemPrompt ?? "") ||
    model !== thread.model ||
    responseMode !== thread.responseMode ||
    dualModelA !== (thread.dualModelA ?? thread.model) ||
    dualModelB !== (thread.dualModelB ?? thread.model) ||
    dualDebateRounds !== thread.dualDebateRounds ||
    selectedMcpIds !== (thread.mcpServerIds ?? []);

  const handleAddMcpServer = useCallback(async () => {
    const name = mcpFormName.trim();
    if (!name) return;
    if (mcpFormTransport === "http" && !mcpFormUrl.trim()) return;
    if (mcpFormTransport === "stdio" && !mcpFormCommand.trim()) return;
    setMcpAdding(true);
    try {
      const body: Record<string, unknown> = { name, transport: mcpFormTransport };
      if (mcpFormTransport === "http") {
        body.url = mcpFormUrl.trim();
      } else {
        body.command = mcpFormCommand.trim();
        body.args = mcpFormArgs.trim() ? mcpFormArgs.split(/\s+/) : [];
      }
      const res = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setMcpFormName("");
        setMcpFormUrl("");
        setMcpFormCommand("");
        setMcpFormArgs("");
        await fetchMcpServers();
      }
    } catch {
      // サイレント失敗
    } finally {
      setMcpAdding(false);
    }
  }, [mcpFormName, mcpFormTransport, mcpFormUrl, mcpFormCommand, mcpFormArgs, fetchMcpServers]);

  const handleDeleteMcpServer = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/mcp-servers/${id}`, { method: "DELETE" });
      if (res.ok) {
        setSelectedMcpIds((prev) => prev.filter((sid) => sid !== id));
        await fetchMcpServers();
      }
    } catch {
      // サイレント失敗
    }
  }, [fetchMcpServers]);

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

          {/* MCP サーバー選択 */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("threadSettings.mcpServers")}
            </span>
            {mcpServers.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                {t("threadSettings.mcpNoServers")}
              </span>
            ) : (
              <div className="flex flex-col gap-1">
                {mcpServers.map((srv) => (
                  <div key={srv.id} className="flex items-center gap-2 text-xs">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedMcpIds.includes(srv.id)}
                        onChange={(e) => {
                          setSelectedMcpIds((prev) =>
                            e.target.checked
                              ? [...prev, srv.id]
                              : prev.filter((id) => id !== srv.id),
                          );
                        }}
                      />
                      <span>{srv.name}</span>
                      <span className="text-muted-foreground">({srv.transport})</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => void handleDeleteMcpServer(srv.id)}
                      className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={t("threadSettings.mcpDelete")}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setMcpFormOpen((v) => !v)}
              className="text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("threadSettings.mcpAddServer")}
            </button>
            {mcpFormOpen && (
              <div className="flex flex-col gap-2 rounded-xl bg-muted px-2 py-1.5 text-xs">
                <label className="flex flex-col gap-1">
                  <span className="font-medium text-muted-foreground">
                    {t("threadSettings.mcpServerName")}
                  </span>
                  <input
                    value={mcpFormName}
                    onChange={(e) => setMcpFormName(e.target.value)}
                    className="rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-medium text-muted-foreground">
                    {t("threadSettings.mcpTransport")}
                  </span>
                  <select
                    value={mcpFormTransport}
                    onChange={(e) => setMcpFormTransport(e.target.value === "stdio" ? "stdio" : "http")}
                    className="rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20"
                  >
                    <option value="http">{t("threadSettings.mcpTransportHttp")}</option>
                    <option value="stdio">{t("threadSettings.mcpTransportStdio")}</option>
                  </select>
                </label>
                {mcpFormTransport === "http" ? (
                  <label className="flex flex-col gap-1">
                    <span className="font-medium text-muted-foreground">
                      {t("threadSettings.mcpUrl")}
                    </span>
                    <input
                      value={mcpFormUrl}
                      onChange={(e) => setMcpFormUrl(e.target.value)}
                      placeholder="http://localhost:3001/mcp"
                      className="rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20"
                    />
                  </label>
                ) : (
                  <>
                    <label className="flex flex-col gap-1">
                      <span className="font-medium text-muted-foreground">
                        {t("threadSettings.mcpCommand")}
                      </span>
                      <input
                        value={mcpFormCommand}
                        onChange={(e) => setMcpFormCommand(e.target.value)}
                        placeholder="npx"
                        className="rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="font-medium text-muted-foreground">
                        {t("threadSettings.mcpArgs")}
                      </span>
                      <input
                        value={mcpFormArgs}
                        onChange={(e) => setMcpFormArgs(e.target.value)}
                        placeholder="-y @modelcontextprotocol/server-everything"
                        className="rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20"
                      />
                    </label>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => void handleAddMcpServer()}
                  disabled={mcpAdding}
                  className="rounded-lg bg-foreground px-2 py-1 text-background transition-all duration-200 hover:opacity-90 disabled:opacity-40"
                >
                  {t("threadSettings.mcpAdd")}
                </button>
              </div>
            )}
          </div>

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
