"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { AnimateModal, MotionButton } from "@/components/ui/motion";
import type { FolderSummary } from "@/hooks/useFolders";

type Props = {
  open: boolean;
  threadId: string | null;
  currentFolderId: string | null;
  folders: FolderSummary[];
  onClose: () => void;
  onMove: (threadId: string, folderId: string | null) => Promise<boolean>;
};

/**
 * スレッドを別フォルダに移動するモーダル。
 * フォルダ一覧をラジオボタンで表示 + 先頭に「フォルダなし」オプション。
 */
export function MoveToFolderModal({
  open,
  threadId,
  currentFolderId,
  folders,
  onClose,
  onMove,
}: Props) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string | null>(currentFolderId);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // モーダルを開くたびに選択をリセット
  useEffect(() => {
    if (open) {
      setSelected(currentFolderId);
    }
  }, [open, currentFolderId]);

  // Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function handleMove() {
    if (!threadId) return;
    setMoving(true);
    setError(null);
    const ok = await onMove(threadId, selected);
    setMoving(false);
    if (ok) {
      onClose();
    } else {
      setError(t("moveModal.moveFailed"));
    }
  }
  return (
    <AnimateModal open={open} onClose={onClose} ariaLabel={t("moveModal.title")} panelClassName="max-w-md">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("moveModal.title")}</h2>
        <MotionButton
          type="button"
          onClick={onClose}
          className="rounded-xl p-1.5 text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground"
          aria-label={t("common.close")}
        >
          ✕
        </MotionButton>
      </div>

        <div className="space-y-1">
          <label className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 transition-colors duration-150 hover:bg-muted">
            <input
              type="radio"
              name="folder"
              checked={selected === null}
              onChange={() => setSelected(null)}
              className="accent-accent"
            />
            <span className="text-sm text-muted-foreground">{t("moveModal.noFolder")}</span>
          </label>
          {folders.map((f) => (
            <label
              key={f.id}
              className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 transition-colors duration-150 hover:bg-muted"
            >
              <input
                type="radio"
                name="folder"
                checked={selected === f.id}
                onChange={() => setSelected(f.id)}
                className="accent-accent"
              />
              <span className="text-sm">
                {f.name}
                {f.memoryScope === "folder" ? " 🔒" : ""}
                {f.instruction ? " 📝" : ""}
              </span>
            </label>
          ))}
          {folders.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {t("moveModal.noFolderDesc")}
            </p>
          )}
        </div>

        <div className="mt-6 flex flex-col gap-2">
          {error && <p className="text-xs text-red-500">{error}</p>}
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
              onClick={handleMove}
              disabled={moving || selected === currentFolderId}
              className="rounded-xl bg-foreground px-4 py-2 text-sm text-background transition-all duration-200 hover:opacity-90 disabled:opacity-40"
            >
              {moving ? t("moveModal.moving") : t("moveModal.move")}
            </MotionButton>
          </div>
        </div>
    </AnimateModal>
  );
}
