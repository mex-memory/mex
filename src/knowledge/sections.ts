/**
 * Markdown sections as the Go check evaluator reads them
 * (native/check/markdown.go). A section check written here must pass there,
 * so the heading rules and the text hash are the same on both sides.
 */
import { createHash } from "node:crypto";

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/u;
const FENCE = /^ {0,3}(```+|~~~+)/u;

export interface Heading { line: number; level: number; text: string; }
export interface Section { heading: string; level: number; /** Own body, without subsections. */ body: string; /** Body with subsections: what a section check hashes. */ full: string; }

export function lines(text: string): string[] { return text.replace(/\r\n/gu, "\n").split("\n"); }

/** ATX and setext headings, skipping fenced code. */
export function headings(all: string[]): Heading[] {
  const out: Heading[] = [];
  let fence = "";
  all.forEach((line, i) => {
    const f = FENCE.exec(line);
    if (f) {
      const marker = f[1].slice(0, 3);
      if (!fence) fence = marker; else if (fence === marker) fence = "";
      return;
    }
    if (fence) return;
    const atx = ATX.exec(line);
    if (atx) { out.push({ line: i, level: atx[1].length, text: (atx[2] ?? "").trim() }); return; }
    if (i > 0 && all[i - 1].trim() !== "" && SETEXT.test(line)) {
      if (out.length && out[out.length - 1].line === i - 1) return;
      out.push({ line: i - 1, level: line.includes("=") ? 1 : 2, text: all[i - 1].trim() });
    }
  });
  return out;
}

function bodyStart(all: string[], h: Heading): number {
  const next = h.line + 1;
  return next < all.length && SETEXT.test(all[next]) && !ATX.test(all[h.line]) ? next + 1 : next;
}

/** Every section of a Markdown text, in order. Text before the first heading is the preamble (heading ""). */
export function sections(text: string): Section[] {
  const all = lines(text);
  const hs = headings(all);
  const out: Section[] = [];
  const preambleEnd = hs.length ? hs[0].line : all.length;
  const preamble = all.slice(0, preambleEnd).join("\n");
  if (preamble.trim()) out.push({ heading: "", level: 0, body: preamble, full: preamble });
  hs.forEach((h, i) => {
    const start = bodyStart(all, h);
    const ownEnd = i + 1 < hs.length ? hs[i + 1].line : all.length;
    let fullEnd = all.length;
    for (const next of hs.slice(i + 1)) if (next.level <= h.level) { fullEnd = next.line; break; }
    out.push({ heading: h.text, level: h.level, body: all.slice(start, Math.max(start, ownEnd)).join("\n"), full: all.slice(start, Math.max(start, fullEnd)).join("\n") });
  });
  return out;
}

/** The first section with exactly this heading, as a section check reads it. */
export function sectionText(text: string, heading: string): string | undefined {
  return sections(text).find(s => s.level > 0 && s.heading === heading.trim())?.full;
}

/** sha256 of the text with whitespace runs collapsed: the section and source check hash. */
export function textHash(text: string): string {
  return `sha256:${createHash("sha256").update(text.replace(/\s+/gu, " ").trim()).digest("hex")}`;
}

export function fileHash(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
