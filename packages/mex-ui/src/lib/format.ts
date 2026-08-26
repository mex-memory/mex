/** Presentation helpers. Pure functions, covered by `format.test.ts`. */

const KIB = 1024;

/** Human byte size with one decimal past KB, e.g. `1.4 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  if (bytes < KIB) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / KIB;
  let unit = 0;
  while (value >= KIB && unit < units.length - 1) {
    value /= KIB;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

/** Compact elapsed time: `just now`, `4m ago`, `3d ago`, `2026-01-14`. */
export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "—";
  const then = new Date(iso);
  const ms = then.getTime();
  if (!Number.isFinite(ms)) return "—";

  const seconds = Math.round((now.getTime() - ms) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1m ago";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days <= 30) return `${days}d ago`;

  return then.toISOString().slice(0, 10);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour12: false });
}

/**
 * Shorten a long absolute path from the left so the meaningful tail stays
 * visible: `…/projects/api/src/routes/users.ts`.
 */
export function truncatePath(path: string, maxLength = 48): string {
  if (path.length <= maxLength) return path;
  const parts = path.split(/[/\\]/).filter(Boolean);
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  let tail = parts.pop() ?? path;
  while (parts.length > 0) {
    const candidate = `${parts[parts.length - 1]}${separator}${tail}`;
    if (candidate.length + 2 > maxLength) break;
    tail = candidate;
    parts.pop();
  }
  return `…${separator}${tail}`;
}

/** Percentage clamped to 0-100, for meter widths. */
export function percent(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}

const LANGUAGE_LABELS: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  tsx: "TSX",
  jsx: "JSX",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  php: "PHP",
  ruby: "Ruby",
  swift: "Swift",
  kotlin: "Kotlin",
  dart: "Dart",
  svelte: "Svelte",
  vue: "Vue",
  astro: "Astro",
  scala: "Scala",
  lua: "Lua",
  objc: "Objective-C",
  unknown: "Unknown",
};

export function languageLabel(language: string): string {
  return LANGUAGE_LABELS[language] ?? language;
}

/** `STALE_FILE` → `Stale file`, for drift issue codes. */
export function humanizeCode(code: string): string {
  const words = code.toLowerCase().split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return code;
  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? ` ${words.slice(1).join(" ")}` : "");
}
