import { execFile } from "node:child_process";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Folders never walked when there is no git. */
const ALWAYS_SKIPPED = new Set([".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".tox"]);

/** Listed but never read: lockfiles, maps and minified bundles. Their reason is `ignored`. */
const NOT_READ = [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/, /\.min\.(js|css)$/, /\.map$/];

export function skippedByRule(path: string): boolean {
  return NOT_READ.some((pattern) => pattern.test(path));
}

export interface Discovered {
  /** Paths relative to the checkout, `/`-separated, sorted. */
  paths: string[];
  via: "git" | "walk";
}

/** Every file in the checkout that git would track or show as untracked, honouring `.gitignore`. */
export async function discoverFiles(root: string): Promise<Discovered> {
  try {
    const { stdout } = await run("git", ["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root, maxBuffer: 1 << 30, windowsHide: true, encoding: "buffer",
    });
    const paths = [...new Set(stdout.toString("utf8").split("\0").filter(Boolean))].sort();
    return { paths, via: "git" };
  } catch {
    return { paths: walk(root), via: "walk" };
  }
}

interface Ignore { add(patterns: string): Ignore; test(path: string): { ignored: boolean; unignored: boolean } }
type IgnoreFactory = () => Ignore;

/** Without git: walk the folder, applying each `.gitignore` to the paths below it. */
export function walk(root: string): string[] {
  const factory = createRequire(import.meta.url)("ignore") as IgnoreFactory | { default: IgnoreFactory };
  const make = typeof factory === "function" ? factory : factory.default;
  const out: string[] = [];
  const visit = (relative: string, rules: Array<{ base: string; ignore: Ignore }>): void => {
    const absolute = relative ? join(root, relative) : root;
    let entries: Dirent[];
    try { entries = readdirSync(absolute, { withFileTypes: true }); } catch { return; }
    let local = rules;
    try {
      const text = readFileSync(join(absolute, ".gitignore"), "utf8");
      local = [...rules, { base: relative, ignore: make().add(text) }];
    } catch { /* no .gitignore here */ }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const directory = entry.isDirectory();
      if (directory && ALWAYS_SKIPPED.has(entry.name)) continue;
      if (!directory && !entry.isFile()) continue;
      // As git does: a deeper .gitignore overrides a shallower one, and within
      // one file the last matching rule wins (including `!` re-includes).
      let ignored = false;
      for (const { base, ignore } of local) {
        const inside = base ? path.slice(base.length + 1) : path;
        const verdict = ignore.test(directory ? `${inside}/` : inside);
        if (verdict.ignored) ignored = true;
        else if (verdict.unignored) ignored = false;
      }
      if (ignored) continue;
      if (directory) visit(path, local);
      else out.push(path);
    }
  };
  visit("", []);
  return out.sort();
}
