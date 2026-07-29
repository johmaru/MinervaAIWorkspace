import { memo, Children, isValidElement, cloneElement, type ReactNode, type ReactElement } from "react";
import { Check, X, Star, ArrowRight, Info, AlertTriangle } from "lucide-react";
import { clsx } from "clsx";

type Marker = "check" | "cross" | "star" | "arrow" | "info" | "warning";

const MARKERS: Record<Marker, { Icon: typeof Check; color: string }> = {
  check: { Icon: Check, color: "text-green-500" },
  cross: { Icon: X, color: "text-red-500" },
  star: { Icon: Star, color: "text-yellow-500" },
  arrow: { Icon: ArrowRight, color: "text-accent-foreground" },
  info: { Icon: Info, color: "text-blue-500" },
  warning: { Icon: AlertTriangle, color: "text-yellow-500" },
};

function isMarker(v: unknown): v is Marker {
  return v === "check" || v === "cross" || v === "star" || v === "arrow" || v === "info" || v === "warning";
}

function enrichNode(node: ReactNode, Icon: typeof Check, color: string): ReactNode {
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: ReactNode; className?: string }>;

  // react-markdown wraps native ul/ol/li in small function components defined in Markdown.tsx.
  // Render them once so we can inspect the underlying tag and prefix the real <li> items.
  // NOTE: This direct el.type invocation assumes the Markdown.tsx ul/ol/li wrappers
  // are stateless function components (no hooks, not memo/forwardRef-wrapped). If
  // hooks are added to those wrappers, this will violate React's Rules of Hooks and
  // crash. In that case, switch to a CSS-based marker approach (list-style + unicode
  // symbols) instead of re-rendering component children by hand.
  if (typeof el.type === "function") {
    const rendered = (el.type as (props: unknown) => ReactNode)(el.props);
    if (isValidElement(rendered)) {
      const renderedEl = rendered as ReactElement<{ children?: ReactNode; className?: string }>;
      const tag = renderedEl.type;
      if (tag === "ul" || tag === "ol") {
        const items = Children.toArray(renderedEl.props.children);
        const newItems = items.map((li) => enrichNode(li, Icon, color));
        return cloneElement(renderedEl, { className: "my-1 list-none pl-0" }, newItems);
      }
      if (tag === "li") {
        return cloneElement(
          renderedEl,
          {},
          <Icon className={clsx("mr-2 inline-block h-4 w-4 shrink-0 align-text-bottom", color)} />,
          renderedEl.props.children,
        );
      }
      return cloneElement(el, el.props, Children.map(el.props.children, (child) => enrichNode(child, Icon, color)));
    }
    return node;
  }

  const tag = el.type;
  if (tag === "ul" || tag === "ol") {
    const items = Children.toArray(el.props.children);
    const newItems = items.map((li) => enrichNode(li, Icon, color));
    return cloneElement(el, { className: "my-1 list-none pl-0" }, newItems);
  }
  if (tag === "li") {
    return cloneElement(
      el,
      {},
      <Icon className={clsx("mr-2 inline-block h-4 w-4 shrink-0 align-text-bottom", color)} />,
      el.props.children,
    );
  }
  return cloneElement(el, el.props, Children.map(el.props.children, (child) => enrichNode(child, Icon, color)));
}

export const RichList = memo(function RichList({
  marker,
  children,
}: {
  marker?: string;
  children?: ReactNode;
}) {
  const m = isMarker(marker) ? marker : "info";
  const { Icon, color } = MARKERS[m];
  const enhanced = Children.map(children, (child) => enrichNode(child, Icon, color));
  return <div className="richlist-container my-2">{enhanced}</div>;
});
