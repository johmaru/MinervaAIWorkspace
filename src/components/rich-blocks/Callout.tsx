import { memo } from "react";
import { Info, Lightbulb, AlertTriangle, AlertOctagon } from "lucide-react";
import { clsx } from "clsx";

type CalloutType = "note" | "tip" | "warning" | "danger";

const TYPE_STYLES: Record<CalloutType, { border: string; bg: string; Icon: typeof Info; iconColor: string }> = {
  note: { border: "border-l-blue-500", bg: "bg-blue-500/10", Icon: Info, iconColor: "text-blue-500" },
  tip: { border: "border-l-green-500", bg: "bg-green-500/10", Icon: Lightbulb, iconColor: "text-green-500" },
  warning: { border: "border-l-yellow-500", bg: "bg-yellow-500/10", Icon: AlertTriangle, iconColor: "text-yellow-500" },
  danger: { border: "border-l-red-500", bg: "bg-red-500/10", Icon: AlertOctagon, iconColor: "text-red-500" },
};

function isCalloutType(v: unknown): v is CalloutType {
  return v === "note" || v === "tip" || v === "warning" || v === "danger";
}

export const Callout = memo(function Callout({
  type,
  title,
  children,
}: {
  type?: string;
  title?: string;
  children?: React.ReactNode;
}) {
  const t = isCalloutType(type) ? type : "note";
  const s = TYPE_STYLES[t];
  const Icon = s.Icon;
  return (
    <div className={clsx("my-2 rounded-r-md border-l-4 py-3 pl-4 pr-3", s.border, s.bg)}>
      <div className="flex items-start gap-2">
        <Icon className={clsx("mt-0.5 h-4 w-4 shrink-0", s.iconColor)} />
        <div className="min-w-0 text-sm leading-relaxed">
          {title ? <p className="mb-1 font-semibold">{title}</p> : null}
          {children}
        </div>
      </div>
    </div>
  );
});
