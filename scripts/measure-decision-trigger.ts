// How often the decision capture prompt would fire (not a shipped feature).
//
//   npx vite-node scripts/measure-decision-trigger.ts -- <repo>[@<commit>] ... [--commits 2000] [--json out.json]
//
// Reads the newest N non-merge commits on each repository's first-parent line before the pinned
// commit (HEAD when none is given) and counts the share whose message has at least one, and at
// least two, distinct decision phrases: the hook offers its line at two. Shares are counted, with a
// Wilson 95% interval. Prints a few triggering subjects per repository so a person can judge them.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { DECISION_TRIGGER, decisionWords } from "../src/knowledge/decisions.js";

const args = process.argv.slice(2).filter(a => a !== "--");
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const commits = Number(flag("--commits") ?? 2000);
const json = flag("--json");
const wilson = (k: number, n: number) => {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
};
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const rows = [];
for (const spec of args) {
  const [repo, commit = "HEAD"] = spec.split("@");
  const out = execFileSync("git", ["-C", repo, "log", "--no-merges", "--first-parent", "-n", String(commits), "--format=%H%x00%s%x00%B%x01", commit], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const messages = out.split("\x01").map(b => b.trim()).filter(Boolean).map(b => { const [sha, subject, body] = b.split("\0"); return { sha, subject, body }; });
  let one = 0, two = 0;
  const samples: string[] = [];
  const byWord = new Map<string, number>();
  for (const m of messages) {
    const words = decisionWords(m.body);
    if (words.length >= 1) one++;
    if (words.length >= DECISION_TRIGGER) { two++; if (samples.length < 5) samples.push(`${m.sha.slice(0, 7)} ${m.subject.slice(0, 90)} [${words.join(", ")}]`); }
    for (const w of words) byWord.set(w, (byWord.get(w) ?? 0) + 1);
  }
  const n = messages.length;
  const row = { repo: basename(repo), commit, commits: n, one, two, oneShare: one / n, twoShare: two / n, twoInterval: wilson(two, n), topWords: [...byWord].sort((a, b) => b[1] - a[1]).slice(0, 6), samples };
  rows.push(row);
  console.log(`${row.repo}: ${n} commits; >=1 phrase ${pct(row.oneShare)}; >=2 phrases ${pct(row.twoShare)} (95% ${pct(row.twoInterval[0])}-${pct(row.twoInterval[1])})`);
  console.log(`  most common: ${row.topWords.map(([w, k]) => `${w} ${k}`).join(", ")}`);
  for (const s of samples) console.log(`  ${s}`);
}
if (json) writeFileSync(json, JSON.stringify(rows, null, 2));
