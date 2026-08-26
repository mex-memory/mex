import type { CSSProperties, ReactNode } from "react";
import type { Tone } from "../lib/health";

// ── Icons ───────────────────────────────────────────────────────────────────
// Inline so the app ships zero icon dependencies and every glyph inherits
// currentColor.

interface IconProps {
  size?: number;
}

function svg(path: ReactNode, { size = 14 }: IconProps, extra?: Partial<CSSProperties>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={extra}
    >
      {path}
    </svg>
  );
}

export const Icon = {
  check: (p: IconProps = {}) => svg(<polyline points="3 8.5 6.2 11.5 13 4.5" />, p),
  cross: (p: IconProps = {}) => svg(<><line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" /></>, p),
  dash: (p: IconProps = {}) => svg(<line x1="4" y1="8" x2="12" y2="8" />, p),
  dot: (p: IconProps = {}) => svg(<circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />, p),
  arrowRight: (p: IconProps = {}) => svg(<><line x1="3" y1="8" x2="12.5" y2="8" /><polyline points="9 4.5 12.5 8 9 11.5" /></>, p),
  arrowLeft: (p: IconProps = {}) => svg(<><line x1="13" y1="8" x2="3.5" y2="8" /><polyline points="7 4.5 3.5 8 7 11.5" /></>, p),
  refresh: (p: IconProps = {}) => svg(<><path d="M13 8a5 5 0 1 1-1.6-3.7" /><polyline points="13 2.2 13 4.8 10.4 4.8" /></>, p),
  copy: (p: IconProps = {}) => svg(<><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 3.5h-6a1 1 0 0 0-1 1v6" /></>, p),
  folder: (p: IconProps = {}) => svg(<path d="M2 4.5A1 1 0 0 1 3 3.5h3l1.3 1.6H13a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />, p),
  graph: (p: IconProps = {}) => svg(<><circle cx="4" cy="12" r="1.8" /><circle cx="12" cy="11" r="1.8" /><circle cx="8" cy="4" r="1.8" /><line x1="7" y1="5.5" x2="5" y2="10.3" /><line x1="9.2" y1="5.4" x2="11.2" y2="9.4" /></>, p),
  pulse: (p: IconProps = {}) => svg(<polyline points="2 9 5 9 6.8 4.5 9.4 12 11 9 14 9" />, p),
  doc: (p: IconProps = {}) => svg(<><path d="M4 2.5h4.6L12 6v7.5H4z" /><polyline points="8.4 2.6 8.4 6.1 11.9 6.1" /></>, p),
  spark: (p: IconProps = {}) => svg(<path d="M8 2.2l1.5 3.9 3.9 1.5-3.9 1.5L8 13l-1.5-3.9L2.6 7.6l3.9-1.5z" />, p),
  clock: (p: IconProps = {}) => svg(<><circle cx="8" cy="8" r="5.6" /><polyline points="8 4.8 8 8.2 10.4 9.6" /></>, p),
  warning: (p: IconProps = {}) => svg(<><path d="M8 2.6l5.6 10H2.4z" /><line x1="8" y1="6.4" x2="8" y2="9.2" /><circle cx="8" cy="11.2" r="0.5" fill="currentColor" /></>, p),
  terminal: (p: IconProps = {}) => svg(<><rect x="2" y="3" width="12" height="10" rx="1.6" /><polyline points="5 7 6.8 8.6 5 10.2" /><line x1="8.6" y1="10.4" x2="11" y2="10.4" /></>, p),
  plug: (p: IconProps = {}) => svg(<><path d="M6 2.5v3M10 2.5v3" /><path d="M4.2 5.5h7.6v2.2a3.8 3.8 0 0 1-7.6 0z" /><line x1="8" y1="11.5" x2="8" y2="13.8" /></>, p),
  link: (p: IconProps = {}) => svg(<><path d="M6.6 9.4a2.6 2.6 0 0 1 0-3.7l1.6-1.6a2.6 2.6 0 0 1 3.7 3.7l-0.8 0.8" /><path d="M9.4 6.6a2.6 2.6 0 0 1 0 3.7l-1.6 1.6a2.6 2.6 0 0 1-3.7-3.7l0.8-0.8" /></>, p),
  dashboard: (p: IconProps = {}) =>
    svg(
      <>
        <rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1" />
        <rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1" />
        <rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1" />
        <rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1" />
      </>,
      p,
    ),
  sliders: (p: IconProps = {}) =>
    svg(
      <>
        <line x1="3" y1="5" x2="13" y2="5" />
        <circle cx="6.2" cy="5" r="1.5" fill="currentColor" />
        <line x1="3" y1="11" x2="13" y2="11" />
        <circle cx="9.8" cy="11" r="1.5" fill="currentColor" />
      </>,
      p,
    ),
};

// ── Card ────────────────────────────────────────────────────────────────────

export function Card(props: {
  title?: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Removes body padding, for edge-to-edge lists. */
  flush?: boolean;
}) {
  const { title, icon, hint, actions, children, flush } = props;
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card__head">
          <div className="card__title">
            {icon && <span className="dim">{icon}</span>}
            {title && <h2>{title}</h2>}
            {hint && <span className="card__hint">{hint}</span>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? "card__body card__body--flush" : "card__body"}>{children}</div>
    </section>
  );
}

// ── Button ──────────────────────────────────────────────────────────────────

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  const { children, onClick, variant = "default", size = "md", disabled, busy, type = "button", title } = props;
  const classes = [
    "btn",
    variant === "primary" && "btn--primary",
    variant === "ghost" && "btn--ghost",
    size === "lg" && "btn--lg",
    size === "sm" && "btn--sm",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={classes}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      aria-busy={busy || undefined}
    >
      {busy && <span className="btn__spinner" />}
      {children}
    </button>
  );
}

// ── Badge ───────────────────────────────────────────────────────────────────

export function Badge(props: { children: ReactNode; tone?: Tone; dot?: boolean }) {
  const { children, tone = "neutral", dot } = props;
  return (
    <span className={`badge badge--${tone}`}>
      {dot && <span className="badge__dot" />}
      {children}
    </span>
  );
}

// ── Stat tile ───────────────────────────────────────────────────────────────

export function Stat(props: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  const className = props.onClick ? "stat stat--button" : "stat";
  const inner = (
    <>
      <span className="stat__label">{props.label}</span>
      <span className="stat__value">{props.value}</span>
      {props.meta !== undefined && <span className="stat__meta">{props.meta}</span>}
    </>
  );

  if (props.onClick) {
    return (
      <button type="button" className={className} onClick={props.onClick} title={props.title}>
        {inner}
      </button>
    );
  }

  return <div className={className}>{inner}</div>;
}

// ── States ──────────────────────────────────────────────────────────────────

export function EmptyState(props: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="state">
      {props.icon && <div className="state__icon">{props.icon}</div>}
      <p className="state__title">{props.title}</p>
      {props.body && <p className="state__body">{props.body}</p>}
      {props.action && <div style={{ marginTop: 6 }}>{props.action}</div>}
    </div>
  );
}

export function ErrorState(props: { title?: string; message: string; hint?: string | null; onRetry?: () => void }) {
  return (
    <div className="state state--error">
      <div className="state__icon">{Icon.warning({ size: 18 })}</div>
      <p className="state__title">{props.title ?? "Something went wrong"}</p>
      <p className="state__body">{props.message}</p>
      {props.hint && <p className="state__body dim">{props.hint}</p>}
      {props.onRetry && (
        <div style={{ marginTop: 6 }}>
          <Button size="sm" onClick={props.onRetry}>
            {Icon.refresh()} Try again
          </Button>
        </div>
      )}
    </div>
  );
}

export function Skeleton(props: { height?: number; width?: string | number }) {
  return (
    <div
      className="skeleton"
      style={{ height: props.height ?? 14, width: props.width ?? "100%" }}
      aria-hidden="true"
    />
  );
}

export function SkeletonRows(props: { rows?: number }) {
  const rows = props.rows ?? 3;
  return (
    <div className="skeleton-stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} width={`${100 - index * 12}%`} />
      ))}
    </div>
  );
}

// ── Banner ──────────────────────────────────────────────────────────────────

export function Banner(props: {
  tone?: Tone;
  title: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  const { tone = "info", title, children, icon, actions } = props;
  return (
    <div className={`banner banner--${tone === "good" ? "info" : tone}`} role="status">
      {icon && <span style={{ marginTop: 2 }}>{icon}</span>}
      <div className="banner__body">
        <p className="banner__title">{title}</p>
        {children && <p className="banner__text">{children}</p>}
      </div>
      {actions && <div className="banner__actions">{actions}</div>}
    </div>
  );
}

// ── Meter ───────────────────────────────────────────────────────────────────

const TONE_COLORS: Record<Tone, string> = {
  good: "var(--good)",
  warn: "var(--warn)",
  bad: "var(--bad)",
  info: "var(--info)",
  neutral: "var(--text-dim)",
};

export function Meter(props: { value: number; tone?: Tone; label?: string }) {
  const tone = props.tone ?? "good";
  return (
    <div
      className="meter"
      role="progressbar"
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={props.label}
    >
      <div
        className="meter__fill"
        style={{ width: `${Math.max(2, props.value)}%`, background: TONE_COLORS[tone] }}
      />
    </div>
  );
}

// ── Score ring ──────────────────────────────────────────────────────────────

export function ScoreRing(props: { score: number; tone: Tone; size?: number }) {
  const size = props.size ?? 92;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, props.score));
  const offset = circumference * (1 - clamped / 100);

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg className="score__ring" width={size} height={size} aria-hidden="true">
        <circle
          className="score__track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="score__value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          stroke={TONE_COLORS[props.tone]}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div
        className="score__center"
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
        }}
      >
        {Math.round(clamped)}
      </div>
    </div>
  );
}

// ── Bar list ────────────────────────────────────────────────────────────────

export function BarList(props: { items: Array<{ label: string; value: number }>; max?: number }) {
  const max = props.max ?? Math.max(1, ...props.items.map((item) => item.value));
  return (
    <div className="bars">
      {props.items.map((item) => (
        <div className="bar" key={item.label}>
          <span className="bar__label" title={item.label}>
            {item.label}
          </span>
          <div className="bar__track">
            <div className="bar__fill" style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }} />
          </div>
          <span className="bar__value">{item.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

// ── Facts list ──────────────────────────────────────────────────────────────

export function Facts(props: { items: Array<{ key: string; value: ReactNode }> }) {
  return (
    <dl className="facts">
      {props.items.map((item) => (
        <div className="fact" key={item.key}>
          <dt className="fact__key">{item.key}</dt>
          <dd className="fact__value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Option card ─────────────────────────────────────────────────────────────

export function OptionCard(props: {
  kind: "radio" | "check";
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  description?: ReactNode;
  name?: string;
}) {
  const { kind, selected, onSelect, title, description, name } = props;
  return (
    <label className="option" data-selected={selected}>
      <input
        className="sr-only"
        type={kind === "radio" ? "radio" : "checkbox"}
        name={name}
        checked={selected}
        onChange={onSelect}
      />
      <span className={`option__control option__control--${kind}`} aria-hidden="true">
        {selected && Icon.check({ size: 11 })}
      </span>
      <span className="option__body">
        <span className="option__title">{title}</span>
        {description && <span className="option__desc">{description}</span>}
      </span>
    </label>
  );
}
