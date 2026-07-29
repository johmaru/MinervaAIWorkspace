import { memo } from "react";
import { clsx } from "clsx";

const CLASS_STYLES: Record<string, string> = {
  big: "text-[1.25em]",
  small: "text-[0.8em]",
  accent: "text-accent-foreground",
  muted: "text-muted-foreground",
  danger: "text-red-500",
  success: "text-green-500",
  hl: "rounded bg-yellow-500/30 px-0.5",
};

export const InlineMark = memo(function InlineMark({
  className,
  children,
}: {
  className?: string | string[];
  children?: React.ReactNode;
}) {
  const joined = Array.isArray(className) ? className.join(" ") : (className ?? "");
  const cls = CLASS_STYLES[joined];
  if (!cls) return <>{children}</>;
  return <span className={clsx(cls)}>{children}</span>;
})