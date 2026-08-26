import type { ReactNode } from "react";
import { Icon } from "./primitives";
import { NAV_ITEMS, activeNav, type NavId } from "../lib/nav";

const NAV_ICONS: Record<NavId, () => ReactNode> = {
  dashboard: () => Icon.dashboard(),
  setup: () => Icon.doc(),
  health: () => Icon.pulse(),
  graph: () => Icon.graph(),
  activity: () => Icon.clock(),
  settings: () => Icon.sliders(),
};

export function Sidebar(props: {
  path: string;
  navigate: (to: string) => void;
  hints?: Partial<Record<NavId, string>>;
}) {
  const active = activeNav(props.path);

  return (
    <nav className="sidebar" aria-label="Main">
      {NAV_ITEMS.map((item) => {
        const isActive = item.id === active;
        const hint = props.hints?.[item.id];
        return (
          <a
            key={item.id}
            href={item.path}
            className="sidebar__item"
            data-active={isActive}
            aria-current={isActive ? "page" : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
                return;
              }
              event.preventDefault();
              props.navigate(item.path);
            }}
          >
            <span className="sidebar__icon">{NAV_ICONS[item.id]()}</span>
            <span className="sidebar__label">{item.label}</span>
            {hint && (
              <span className="sidebar__hint" data-kind={hintKind(hint)}>
                {hint}
              </span>
            )}
          </a>
        );
      })}
    </nav>
  );
}

function hintKind(hint: string): "start" | "repair" | "count" | "muted" {
  if (hint === "start" || hint === "repair") return hint;
  if (/^\d+$/.test(hint)) return "count";
  return "muted";
}
