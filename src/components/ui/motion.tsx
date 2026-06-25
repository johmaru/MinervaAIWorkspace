"use client";

import { useState, type ReactNode } from "react";
import { AnimatePresence, motion, type Variants } from "motion/react";

/* ------------------------------------------------------------------ *
 * Shared animation variants
 *
 * Single source of truth — every call site imports from here so the
 * motion language stays consistent across the app.
 * ------------------------------------------------------------------ */

/** Modals / panels: scale + fade. */
export const fadeScaleIn: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98 },
};

/** Message bubbles / list rows: slide up + fade. */
export const fadeSlideUp: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
};

/** Modal backdrops / overlays: fade only. */
export const overlayFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};

/** Accordion collapse: height + opacity. Pair with overflow:hidden. */
export const accordionCollapse: Variants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1 },
  exit: { height: 0, opacity: 0 },
};

/** Standard ease-out timing. */
export const easeOut = { duration: 0.2, ease: "easeOut" as const };
export const easeOutLong = { duration: 0.3, ease: "easeOut" as const };

/* ------------------------------------------------------------------ *
 * Reusable motion components
 * ------------------------------------------------------------------ */

type MotionButtonProps = React.ComponentProps<typeof motion.button> & {
  /** Disable press/hover scale when the button is disabled. */
  disabled?: boolean;
};

/**
 * <motion.button> with press/hover scale baked in.
 * Drop-in for plain <button> — forwards all standard props.
 * Disabled buttons never animate (motion skips while* when disabled).
 */
export function MotionButton({
  disabled,
  whileTap,
  whileHover,
  ...rest
}: MotionButtonProps) {
  return (
    <motion.button
      whileTap={disabled ? undefined : whileTap ?? { scale: 0.95 }}
      whileHover={disabled ? undefined : whileHover ?? { scale: 1.02 }}
      disabled={disabled}
      {...rest}
    />
  );
}

type AnimateModalProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  ariaLabel: string;
  /** Max width class for the panel, e.g. "max-w-2xl". */
  panelClassName?: string;
};

/**
 * Animated modal shell: AnimatePresence + overlay (fadeScaleIn) + panel.
 * Handles mount/unmount exit animation and click-outside-to-close.
 * Renders null when closed (AnimatePresence plays exit first).
 */
export function AnimateModal({
  open,
  onClose,
  children,
  ariaLabel,
  panelClassName = "max-w-2xl",
}: AnimateModalProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={onClose}
          role="dialog"
          aria-label={ariaLabel}
          variants={overlayFade}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={{ duration: 0.2 }}
        >
          <motion.div
            className={`max-h-[85vh] w-full ${panelClassName} overflow-y-auto rounded-3xl bg-popover p-6 ring-1 ring-border`}
            onClick={(e) => e.stopPropagation()}
            variants={fadeScaleIn}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={easeOut}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

type AccordionProps = {
  /** Controlled open state. If omitted, the accordion manages its own state. */
  open?: boolean;
  onToggle?: () => void;
  /** Initial open state for uncontrolled mode (default: false). */
  defaultOpen?: boolean;
  /** Summary row content (the clickable header). */
  summary: ReactNode;
  /** Collapsible body. */
  children: ReactNode;
  /** Extra className for the summary button. */
  summaryClassName?: string;
  /** Extra className for the outer container. */
  className?: string;
};

/**
 * Animated accordion: replaces native <details>/<summary> with a
 * controlled <button> + AnimatePresence height animation.
 * The chevron ▶ rotates when open (caller includes rotate class).
 */
export function Accordion({
  open: openProp,
  onToggle,
  defaultOpen = false,
  summary,
  children,
  summaryClassName = "",
  className = "",
}: AccordionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;

  const handleToggle = () => {
    if (isControlled) {
      onToggle?.();
    } else {
      setInternalOpen((v) => !v);
    }
  };

  return (
    <div className={className}>
      <button
        type="button"
        onClick={handleToggle}
        className={summaryClassName}
        aria-expanded={open}
      >
        {summary}
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
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
