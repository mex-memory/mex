import { execFileSync } from "node:child_process";

/** Sum of RSS (KB) over `pid` and its descendants. */
export function treeRssKb(pid) {
  let out;
  try { out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" }); } catch { return 0; }
  const children = new Map(); const rss = new Map();
  for (const line of out.trim().split("\n")) {
    const [p, pp, r] = line.trim().split(/\s+/).map(Number);
    rss.set(p, r);
    if (!children.has(pp)) children.set(pp, []);
    children.get(pp).push(p);
  }
  let total = 0; const stack = [pid]; const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p); total += rss.get(p) ?? 0;
    for (const c of children.get(p) ?? []) stack.push(c);
  }
  return total;
}
