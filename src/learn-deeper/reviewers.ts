import { visit } from "unist-util-visit";
import { stripHidden } from "../knowledge/gates.js";
import { parseMarkdown } from "../markdown.js";

const REDACTED = "[reviewer]";
const EMAIL = /\b[^\s@]+@[^\s@]+\.[A-Za-z]{2,}\b/gu;
const MENTION = /(?<![\p{L}\p{M}\p{N}_@])@([\p{L}\p{M}\p{N}_](?:[\p{L}\p{M}\p{N}_.-]*[\p{L}\p{M}\p{N}_])?)/gu;
const WORD = "[\\p{L}\\p{M}\\p{N}_]";

function displayNamePatterns(names: Set<string>): RegExp[] {
  const alternatives = [...names].sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+"));
  const patterns: RegExp[] = [];
  // A large response can contain many authors. Keep each pattern small.
  for (let i = 0; i < alternatives.length; i += 64) {
    patterns.push(new RegExp(`(?<!${WORD})(?:${alternatives.slice(i, i + 64).join("|")})(?!${WORD})`, "giu"));
  }
  return patterns;
}

export class Reviewers {
  private readonly logins = new Set<string>();
  private readonly names = new Set<string>();
  private namePatterns?: RegExp[];

  add(login: string, displayName: unknown): void {
    this.logins.add(login.toLowerCase());
    if (typeof displayName !== "string") return;
    const name = stripHidden(displayName).trim().replace(/\s+/gu, " ");
    if (!name.includes(" ") || this.names.has(name)) return;
    this.names.add(name);
    this.namePatterns = undefined;
  }

  redact(text: string, mode: "all" | "mentions-only"): string {
    const patterns = mode === "all" ? (this.namePatterns ??= displayNamePatterns(this.names)) : [];
    const prose = (value: string) => {
      let redacted = value.replace(EMAIL, REDACTED).replace(MENTION, (match, login: string, offset: number, body: string) => {
        // A scoped package or a team handle can start with a known login.
        return this.logins.has(login.toLowerCase()) && body[offset + match.length] !== "/" ? REDACTED : match;
      });
      for (const pattern of patterns) redacted = redacted.replace(pattern, REDACTED);
      return redacted;
    };

    // Use source offsets so the model sees the original Markdown and code bytes.
    let result = "", offset = 0;
    visit(parseMarkdown(text), ["inlineCode", "code"], node => {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      result += prose(text.slice(offset, start)) + text.slice(start, end);
      offset = end;
    });
    return result + prose(text.slice(offset));
  }
}
