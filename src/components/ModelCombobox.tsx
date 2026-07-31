"use client";

import { useId } from "react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  models: string[];
  displayNames?: Record<string, string>;
  placeholder?: string;
  /** When true, datalist includes an empty option (e.g. fallback disabled). */
  allowEmpty?: boolean;
  emptyLabel?: string;
  className?: string;
  "aria-label"?: string;
  id?: string;
};

/**
 * Freeform model id input with optional datalist suggestions from GET /api/models.
 */
export function ModelCombobox({
  value,
  onChange,
  models,
  displayNames = {},
  placeholder,
  allowEmpty = false,
  emptyLabel = "—",
  className = "rounded-xl bg-muted px-2 py-1.5 text-xs outline-none transition-all duration-200 focus:ring-2 focus:ring-foreground/20",
  "aria-label": ariaLabel,
  id,
}: Props) {
  const autoId = useId();
  const listId = `${autoId}-models`;

  return (
    <>
      <input
        id={id}
        type="text"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        className={className}
      />
      <datalist id={listId}>
        {allowEmpty && <option value="" label={emptyLabel} />}
        {models.map((m) => (
          <option key={m} value={m} label={displayNames[m] ?? m} />
        ))}
      </datalist>
    </>
  );
}
