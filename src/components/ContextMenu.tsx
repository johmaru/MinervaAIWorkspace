"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";

export type MenuItem =
  | { type: "item"; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }
  | { type: "separator" };

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

/**
 * Generic context menu. Rendered directly under body via createPortal.
 * Clamps at viewport edges, closes on click-outside / Esc / scroll.
 * No library used. Desktop right-click only (mobile long-press not supported).
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Clamp at viewport edges
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - rect.width - 4),
      y: Math.min(y, window.innerHeight - rect.height - 4),
    });
  }, [x, y]);

  // Close on click-outside / Esc / scroll
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <motion.div
      ref={ref}
      role="menu"
      style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 50 }}
      className="min-w-40 rounded-2xl bg-[var(--glass-bg)] py-1.5 text-sm ring-1 ring-border backdrop-blur-xl"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
    >
      {items.map((it, i) =>
        it.type === "separator" ? (
          <div key={i} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              it.onClick();
              onClose();
            }}
            className={`flex w-full px-3 py-1.5 text-left transition-colors duration-150 hover:bg-muted/70 disabled:opacity-40 ${
              it.danger ? "text-red-500" : ""
            }`}
          >
            {it.label}
          </button>
        ),
      )}
    </motion.div>,
    document.body,
  );
}
