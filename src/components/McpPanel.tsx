"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { clientFetch } from "@/lib/clientFetch";

type McpServer = {
  id: string;
  name: string;
  transport: "http" | "sse" | "stdio";
  hasHeaders?: boolean;
};

type Transport = "http" | "sse" | "stdio";

type Props = {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
};

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; toolCount: number }
  | { status: "fail"; error: string };

/**
 * Parse a textarea of "Header-Name: value" lines into a headers object.
 * Returns null if empty. Used for the headers textarea in the registration form.
 */
function parseHeadersText(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key && value) out[key] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * MCP server management panel (for the popover in the input area).
 * Provides server list selection (per-thread enable/disable) +
 * server registration form (HTTP / SSE / stdio) with optional headers
 * and a connection test button.
 */
export function McpPanel({ selectedIds, onChange }: Props) {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formTransport, setFormTransport] = useState<Transport>("http");
  const [formUrl, setFormUrl] = useState("");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formHeaders, setFormHeaders] = useState("");
  const [adding, setAdding] = useState(false);
  const [testState, setTestState] = useState<TestState>({ status: "idle" });

  const fetchServers = useCallback(async () => {
    try {
      const res = await clientFetch("/api/mcp-servers");
      if (!res.ok) return;
      const data = await res.json();
      setServers(Array.isArray(data) ? data : []);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    void fetchServers();
  }, [fetchServers]);

  const buildRequestBody = useCallback((): Record<string, unknown> => {
    const name = formName.trim();
    const body: Record<string, unknown> = { name, transport: formTransport };
    if (formTransport === "http" || formTransport === "sse") {
      body.url = formUrl.trim();
      const headers = parseHeadersText(formHeaders);
      if (headers) body.headers = headers;
    } else {
      body.command = formCommand.trim();
      body.args = formArgs.trim() ? formArgs.split(/\s+/) : [];
    }
    return body;
  }, [formName, formTransport, formUrl, formCommand, formArgs, formHeaders]);

  const handleAdd = useCallback(async () => {
    const name = formName.trim();
    if (!name) return;
    if ((formTransport === "http" || formTransport === "sse") && !formUrl.trim()) return;
    if (formTransport === "stdio" && !formCommand.trim()) return;
    setAdding(true);
    try {
      const body = buildRequestBody();
      const res = await clientFetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        // Clear sensitive fields from form state after successful add.
        setFormName("");
        setFormUrl("");
        setFormCommand("");
        setFormArgs("");
        setFormHeaders("");
        setTestState({ status: "idle" });
        await fetchServers();
      }
    } catch {
      // silent
    } finally {
      setAdding(false);
    }
  }, [formName, formTransport, formUrl, formCommand, formArgs, formHeaders, fetchServers, buildRequestBody]);

  const handleTest = useCallback(async () => {
    if ((formTransport === "http" || formTransport === "sse") && !formUrl.trim()) return;
    if (formTransport === "stdio" && !formCommand.trim()) return;
    setTestState({ status: "testing" });
    try {
      const body = buildRequestBody();
      const res = await clientFetch("/api/mcp-servers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setTestState({ status: "ok", toolCount: data.tools?.length ?? 0 });
      } else {
        setTestState({ status: "fail", error: data.error ?? "unknown error" });
      }
    } catch (err) {
      setTestState({ status: "fail", error: err instanceof Error ? err.message : "network error" });
    }
  }, [formTransport, formUrl, formCommand, buildRequestBody]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      const res = await clientFetch(`/api/mcp-servers/${id}`, { method: "DELETE" });
      if (res.ok) {
        onChange(selectedIds.filter((sid) => sid !== id));
        await fetchServers();
      }
    } catch {
      // silent
    }
  }, [selectedIds, onChange, fetchServers]);

  const isRemote = formTransport === "http" || formTransport === "sse";

  return (
    <div className="flex flex-col gap-2 p-1">
      {/* Server list */}
      {servers.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          {t("threadSettings.mcpNoServers")}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {servers.map((srv) => (
            <div key={srv.id} className="flex items-center gap-2 rounded-lg px-1 py-1 text-xs hover:bg-muted/50">
              <label className="flex flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(srv.id)}
                  onChange={(e) => {
                    onChange(
                      e.target.checked
                        ? [...selectedIds, srv.id]
                        : selectedIds.filter((id) => id !== srv.id),
                    );
                  }}
                />
                <span>{srv.name}</span>
                <span className="text-muted-foreground">({srv.transport})</span>
                {srv.hasHeaders && (
                  <span className="text-muted-foreground" title={t("threadSettings.mcpHasHeaders")}>
                    🔒
                  </span>
                )}
              </label>
              <button
                type="button"
                onClick={() => void handleDelete(srv.id)}
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label={t("threadSettings.mcpDelete")}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Registration form toggle */}
      <button
        type="button"
        onClick={() => setFormOpen((v) => !v)}
        className="rounded-lg px-1 py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {t("threadSettings.mcpAddServer")}
      </button>

      {formOpen && (
        <div className="flex flex-col gap-2 rounded-xl bg-muted px-2 py-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="font-medium text-muted-foreground">
              {t("threadSettings.mcpServerName")}
            </span>
            <input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              className="rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium text-muted-foreground">
              {t("threadSettings.mcpTransport")}
            </span>
            <select
              value={formTransport}
              onChange={(e) => {
                setFormTransport(e.target.value as Transport);
                setTestState({ status: "idle" });
              }}
              className="rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20"
            >
              <option value="http">{t("threadSettings.mcpTransportHttp")}</option>
              <option value="sse">{t("threadSettings.mcpTransportSse")}</option>
              <option value="stdio">{t("threadSettings.mcpTransportStdio")}</option>
            </select>
          </label>
          {isRemote ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">
                  {t("threadSettings.mcpUrl")}
                </span>
                <input
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder={formTransport === "sse" ? "https://example.com/sse" : "https://example.com/mcp"}
                  className="rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">
                  {t("threadSettings.mcpHeaders")}
                </span>
                <textarea
                  value={formHeaders}
                  onChange={(e) => setFormHeaders(e.target.value)}
                  placeholder={t("threadSettings.mcpHeadersPlaceholder")}
                  rows={3}
                  className="rounded-lg bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-2 focus:ring-foreground/20"
                />
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">
                  {t("threadSettings.mcpCommand")}
                </span>
                <input
                  value={formCommand}
                  onChange={(e) => setFormCommand(e.target.value)}
                  placeholder="npx"
                  className="rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">
                  {t("threadSettings.mcpArgs")}
                </span>
                <input
                  value={formArgs}
                  onChange={(e) => setFormArgs(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-everything"
                  className="rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20"
                />
              </label>
            </>
          )}

          {/* Test connection feedback */}
          {testState.status === "ok" && (
            <p className="text-xs text-green-600 dark:text-green-400">
              {t("threadSettings.mcpTestOk").replace("{count}", String(testState.toolCount))}
            </p>
          )}
          {testState.status === "fail" && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {t("threadSettings.mcpTestFail").replace("{error}", testState.error)}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testState.status === "testing"}
              className="flex-1 rounded-lg border border-foreground/20 px-2 py-1 text-foreground transition-all duration-200 hover:bg-muted disabled:opacity-40"
            >
              {testState.status === "testing" ? t("threadSettings.mcpTesting") : t("threadSettings.mcpTest")}
            </button>
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={adding}
              className="flex-1 rounded-lg bg-foreground px-2 py-1 text-background transition-all duration-200 hover:opacity-90 disabled:opacity-40"
            >
              {t("threadSettings.mcpAdd")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
