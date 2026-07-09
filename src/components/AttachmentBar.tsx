"use client";

import { useI18n } from "@/components/I18nProvider";
import type { MessageAttachment } from "@/hooks/useChat";

type Props = {
  attachments: MessageAttachment[];
  onRemove?: (id: string) => void;
};

/**
 * Attachment list bar.
 * - Images: thumbnail display
 * - Text/PDF: file icon + filename
 * Shows a remove button when onRemove is provided (for pending attachments before sending).
 */
export function AttachmentBar({ attachments, onRemove }: Props) {
  const { t } = useI18n();
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="relative flex items-center gap-1.5 rounded-2xl bg-muted px-2.5 py-1.5 text-xs transition-all duration-200 hover:bg-muted/80 ring-1 ring-border"
        >
          {att.dataUrl ? (
            <img
              src={att.dataUrl}
              alt={att.filename}
              className="h-10 w-10 rounded-xl object-cover"
            />
          ) : (
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-background/60 text-[10px] text-muted-foreground">
              📄
            </span>
          )}
          <span className="max-w-[120px] truncate text-muted-foreground">
            {att.filename}
          </span>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(att.id)}
              className="ml-1 text-muted-foreground transition-colors duration-150 hover:text-foreground"
              aria-label={t("chat.deleteAttachment", { filename: att.filename })}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
