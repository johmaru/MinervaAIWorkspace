"use client";
import { useI18n } from "@/components/I18nProvider";
import { AnimateModal, MotionButton } from "@/components/ui/motion";

type Props = { open: boolean; onClose: () => void };

export function HelpModal({ open, onClose }: Props) {
  const { t } = useI18n();
  return (
    <AnimateModal open={open} onClose={onClose} ariaLabel={t("help.title")} panelClassName="max-w-2xl">
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
      <div className="max-h-[60vh] overflow-y-auto space-y-4 pr-1">
        {/* What is */}
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t("help.connectionsTitle")}</h3>
          <p className="text-sm text-muted-foreground">{t("help.connectionsWhatIs")}</p>
        </section>
        {/* Setup steps */}
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t("help.connectionsSetupTitle")}</h3>
          <ol className="space-y-3 text-sm">
            <li>
              <p className="font-medium">{t("help.connectionsStep1")}</p>
              <p className="text-muted-foreground">{t("help.connectionsStep1Desc")}</p>
            </li>
            <li>
              <p className="font-medium">{t("help.connectionsStep2")}</p>
              <p className="text-muted-foreground">{t("help.connectionsStep2Desc")}</p>
              <code className="mt-1 block rounded-lg bg-muted px-2 py-1 text-xs">{t("help.connectionsStep2Uri")}</code>
              <p className="mt-1 text-xs text-muted-foreground">{t("help.connectionsStep2UriNote")}</p>
            </li>
            <li>
              <p className="font-medium">{t("help.connectionsStep3")}</p>
              <p className="text-muted-foreground">{t("help.connectionsStep3Desc")}</p>
            </li>
            <li>
              <p className="font-medium">{t("help.connectionsStep4")}</p>
              <p className="text-muted-foreground">{t("help.connectionsStep4Desc")}</p>
            </li>
            <li>
              <p className="font-medium">{t("help.connectionsStep5")}</p>
              <p className="text-muted-foreground">{t("help.connectionsStep5Desc")}</p>
            </li>
            <li>
              <p className="font-medium">{t("help.connectionsStep6")}</p>
              <p className="text-muted-foreground">{t("help.connectionsStep6Desc")}</p>
            </li>
          </ol>
        </section>
        {/* Tools */}
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t("help.connectionsToolsTitle")}</h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li className="font-mono text-xs">{t("help.connectionsToolsSearch")}</li>
            <li className="font-mono text-xs">{t("help.connectionsToolsGetPage")}</li>
            <li className="font-mono text-xs">{t("help.connectionsToolsGetBlocks")}</li>
          </ul>
        </section>
        {/* Troubleshooting */}
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t("help.connectionsTroubleshootingTitle")}</h3>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>{t("help.connectionsErrorDenied")}</li>
            <li>{t("help.connectionsErrorFailed")}</li>
            <li>{t("help.connectionsNoConnections")}</li>
          </ul>
        </section>
      </div>
    </AnimateModal>
  );
}
