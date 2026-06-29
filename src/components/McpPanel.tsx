"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { clientFetch } from "@/lib/clientFetch";

type McpServer = {
  id: string;
  name: string;
  transport: string;
};

type Props = {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
};

/**
 * MCP サーバー管理パネル（入力エリアのポップオーバー用）。
 * サーバー一覧の選択（スレッド単位の有効/無効）＋
 * サーバー登録フォーム（HTTP / stdio）を提供する。
 */
export function McpPanel({ selectedIds, onChange }: Props) {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formTransport, setFormTransport] = useState<"http" | "stdio">("http");
  const [formUrl, setFormUrl] = useState("");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [adding, setAdding] = useState(false);

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

  const handleAdd = useCallback(async () => {
    const name = formName.trim();
    if (!name) return;
    if (formTransport === "http" && !formUrl.trim()) return;
    if (formTransport === "stdio" && !formCommand.trim()) return;
    setAdding(true);
    try {
      const body: Record<string, unknown> = { name, transport: formTransport };
      if (formTransport === "http") {
        body.url = formUrl.trim();
      } else {
        body.command = formCommand.trim();
        body.args = formArgs.trim() ? formArgs.split(/\s+/) : [];
      }
      const res = await clientFetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setFormName("");
        setFormUrl("");
        setFormCommand("");
        setFormArgs("");
        await fetchServers();
      }
    } catch {
      // silent
    } finally {
      setAdding(false);
    }
  }, [formName, formTransport, formUrl, formCommand, formArgs, fetchServers]);

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

  return (
    <div className="flex flex-col gap-2 p-1">
      {/* サーバー一覧 */}
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

      {/* 登録フォーム トグル */}
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
              onChange={(e) => setFormTransport(e.target.value === "stdio" ? "stdio" : "http")}
              className="rounded-lg bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-foreground/20"
            >
              <option value="http">{t("threadSettings.mcpTransportHttp")}</option>
              <option value="stdio">{t("threadSettings.mcpTransportStdio")}</option>
            </select>
          </label>
          {formTransport === "http" ? (
            <label className="flex flex-col gap-1">
              <span className="font-medium text-muted-foreground">
                {t("threadSettings.mcpUrl")}
              </span>
              <input
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
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
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={adding}
            className="rounded-lg bg-foreground px-2 py-1 text-background transition-all duration-200 hover:opacity-90 disabled:opacity-40"
          >
            {t("threadSettings.mcpAdd")}
          </button>
        </div>
      )}
    </div>
  );
}
