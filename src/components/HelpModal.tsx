"use client";
import { useState, useEffect } from "react";
import { useI18n } from "@/components/I18nProvider";
import { AnimateModal, MotionButton } from "@/components/ui/motion";

type Props = { open: boolean; onClose: () => void; initialTopic?: string | null };

export function HelpModal({ open, onClose, initialTopic }: Props) {
  const { t } = useI18n();
  const [activeTopic, setActiveTopic] = useState<string | null>(initialTopic ?? null);

  useEffect(() => {
    if (open) setActiveTopic(initialTopic ?? null);
  }, [open, initialTopic]);

  return (
    <AnimateModal open={open} onClose={onClose} ariaLabel={t("help.title")} panelClassName="max-w-4xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("help.title")}</h2>
        <MotionButton
          type="button"
          onClick={onClose}
          className="rounded-xl p-1.5 text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground"
          aria-label={t("common.close")}
        >
          ✕
        </MotionButton>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row" style={{ height: "60vh" }}>
        {/* Left nav */}
        <nav className="shrink-0 overflow-x-auto border-b border-border/50 pb-2 sm:w-56 sm:overflow-y-auto sm:overflow-x-visible sm:border-r sm:border-b-0 sm:pb-0 sm:pr-2">
          <p className="mb-1 px-2 text-xs font-semibold text-muted-foreground">
            {t("help.categories.connections.label")}
          </p>
          <ul className="flex gap-1 sm:block sm:space-y-0.5">
            <li>
              <button
                type="button"
                onClick={() => setActiveTopic("connections.notion")}
                className={`w-full rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                  activeTopic === "connections.notion"
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50"
                }`}
              >
                {t("help.categories.connections.notion.label")}
              </button>
            </li>
          </ul>
          <p className="mb-1 mt-4 px-2 text-xs font-semibold text-muted-foreground">
            {t("help.categories.system.label")}
          </p>
          <ul className="flex gap-1 sm:block sm:space-y-0.5">
            <li>
              <button
                type="button"
                onClick={() => setActiveTopic("system.chatExport")}
                className={`w-full rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                  activeTopic === "system.chatExport"
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50"
                }`}
              >
                {t("help.categories.system.chatExport.label")}
              </button>
            </li>
          </ul>
        </nav>
        {/* Right content */}
        <div className="flex-1 overflow-y-auto pr-1">
          {activeTopic === "connections.notion" ? (
            <NotionTopic />
          ) : activeTopic === "system.chatExport" ? (
            <ChatExportTopic />
          ) : (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <p className="text-sm text-muted-foreground">
                  {t("help.categories.connections.label")}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  ← {t("help.categories.connections.notion.label")}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </AnimateModal>
  );

  function NotionTopic() {
    const n = "help.categories.connections.notion";
    return (
      <div className="space-y-4">
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t(`${n}.whatIsTitle`)}</h3>
          <p className="text-sm text-muted-foreground">{t(`${n}.whatIs`)}</p>
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t(`${n}.setupTitle`)}</h3>
          <ol className="space-y-3 text-sm">
            <li>
              <p className="font-medium">{t(`${n}.step1`)}</p>
              <p className="text-muted-foreground">{t(`${n}.step1Desc`)}</p>
            </li>
            <li>
              <p className="font-medium">{t(`${n}.step2`)}</p>
              <p className="text-muted-foreground">{t(`${n}.step2Desc`)}</p>
              <code className="mt-1 block rounded-lg bg-muted px-2 py-1 text-xs">{t(`${n}.step2Uri`)}</code>
              <p className="mt-1 text-xs text-muted-foreground">{t(`${n}.step2UriNote`)}</p>
            </li>
            <li>
              <p className="font-medium">{t(`${n}.step3`)}</p>
              <p className="text-muted-foreground">{t(`${n}.step3Desc`)}</p>
            </li>
            <li>
              <p className="font-medium">{t(`${n}.step4`)}</p>
              <p className="text-muted-foreground">{t(`${n}.step4Desc`)}</p>
            </li>
            <li>
              <p className="font-medium">{t(`${n}.step5`)}</p>
              <p className="text-muted-foreground">{t(`${n}.step5Desc`)}</p>
            </li>
            <li>
              <p className="font-medium">{t(`${n}.step6`)}</p>
              <p className="text-muted-foreground">{t(`${n}.step6Desc`)}</p>
            </li>
          </ol>
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t(`${n}.toolsTitle`)}</h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li className="font-mono text-xs">{t(`${n}.toolsSearch`)}</li>
            <li className="font-mono text-xs">{t(`${n}.toolsGetPage`)}</li>
            <li className="font-mono text-xs">{t(`${n}.toolsGetBlocks`)}</li>
          </ul>
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t(`${n}.troubleshootingTitle`)}</h3>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>{t(`${n}.errorDenied`)}</li>
            <li>{t(`${n}.errorFailed`)}</li>
            <li>{t(`${n}.noConnections`)}</li>
          </ul>
        </section>
      </div>
    );
  }

  function ChatExportTopic() {
    const n = "help.categories.system.chatExport";
    return (
      <div className="space-y-4">
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t(`${n}.whatIsTitle`)}</h3>
          <p className="text-sm text-muted-foreground">{t(`${n}.whatIs`)}</p>
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t(`${n}.fileStructureTitle`)}</h3>
          <p className="text-sm text-muted-foreground">{t(`${n}.fileStructure`)}</p>
          <code className="mt-1 block rounded-lg bg-muted px-2 py-1 text-xs">{t(`${n}.fileStructureExample`)}</code>
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t(`${n}.dockerTitle`)}</h3>
          <p className="text-sm text-muted-foreground">{t(`${n}.dockerDesc`)}</p>
          <code className="mt-1 block rounded-lg bg-muted px-2 py-1 text-xs">{t(`${n}.dockerExample`)}</code>
          <p className="mt-1 text-xs text-muted-foreground">{t(`${n}.dockerNote`)}</p>
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t(`${n}.nonDockerTitle`)}</h3>
          <p className="text-sm text-muted-foreground">{t(`${n}.nonDockerDesc`)}</p>
          <code className="mt-1 block rounded-lg bg-muted px-2 py-1 text-xs">{t(`${n}.nonDockerExample`)}</code>
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t(`${n}.disableTitle`)}</h3>
          <p className="text-sm text-muted-foreground">{t(`${n}.disableDesc`)}</p>
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t(`${n}.troubleshootingTitle`)}</h3>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>{t(`${n}.troubleDockerWrongVar`)}</li>
            <li>{t(`${n}.troubleNoFiles`)}</li>
            <li>{t(`${n}.troubleWindowsPath`)}</li>
          </ul>
        </section>
      </div>
    );
  }
}
