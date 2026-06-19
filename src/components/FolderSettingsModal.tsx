"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import type { FolderSummary } from "@/hooks/useFolders";

type Props = {
  folder: FolderSummary;
  open: boolean;
  onClose: () => void;
  onSave: (patch: {
    name: string;
    instruction: string | null;
    memoryScope: "folder" | "global";
  }) => Promise<boolean>;
};

/**
 * フォルダ設定モーダル。名前・Instruction・メモリスコープを編集。
 * folder.id 変更時にローカル state を同期（スレッド切替と同じパターン）。
 * モーダル外クリック / Esc で閉じる（SettingsModal と同じ枠）。
 */
export function FolderSettingsModal({ folder, open, onClose, onSave }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState(folder.name);
  const [instruction, setInstruction] = useState(folder.instruction ?? "");
  const [memoryScope, setMemoryScope] = useState<"folder" | "global">(
    folder.memoryScope,
  );
  const [saving, setSaving] = useState(false);

  // folder 切替時にローカル state を同期
  useEffect(() => {
    setName(folder.name);
    setInstruction(folder.instruction ?? "");
    setMemoryScope(folder.memoryScope);
  }, [folder.id, folder.name, folder.instruction, folder.memoryScope]);

  const dirty =
    name !== folder.name ||
    instruction !== (folder.instruction ?? "") ||
    memoryScope !== folder.memoryScope;

  // Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleSave() {
    const trimmedName = name.trim() || "New folder";
    setSaving(true);
    try {
      const ok = await onSave({
        name: trimmedName,
        instruction: instruction.trim().length > 0 ? instruction.trim() : null,
        memoryScope,
      });
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-label={t("folderModal.title")}
    >
      <div
      className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-popover p-6 ring-1 ring-border animate-[modal-in_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("folderModal.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-1.5 text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground"
            aria-label={t("common.close")}
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          {/* 名前 */}
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("folderModal.folderName")}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              placeholder="New folder"
            />
          </div>

          {/* Instruction */}
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("folderModal.instruction")}
            </label>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              className="h-32 w-full resize-y rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              placeholder={t("folderModal.instructionPlaceholder")}
            />
          </div>

          {/* メモリスコープ */}
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("folderModal.memoryScope")}
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMemoryScope("folder")}
                className={`flex-1 rounded-2xl px-3 py-2 text-sm transition-all duration-200 ${
                  memoryScope === "folder"
                    ? "bg-foreground text-background"
                    : "bg-muted/50 hover:bg-muted ring-1 ring-border"
                }`}
              >
                {t("folderModal.thisFolderOnly")}
              </button>
              <button
                type="button"
                onClick={() => setMemoryScope("global")}
                className={`flex-1 rounded-2xl px-3 py-2 text-sm transition-all duration-200 ${
                  memoryScope === "global"
                    ? "bg-foreground text-background"
                    : "bg-muted/50 hover:bg-muted ring-1 ring-border"
                }`}
              >
                {t("folderModal.allThreads")}
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {memoryScope === "folder"
                ? t("folderModal.thisFolderOnlyDesc")
                : t("folderModal.allThreadsDesc")}
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
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
            disabled={!dirty || saving}
            className="rounded-xl bg-foreground px-4 py-2 text-sm text-background transition-all duration-200 hover:opacity-90 disabled:opacity-40"
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
