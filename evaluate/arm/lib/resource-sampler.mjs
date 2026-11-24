import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { processTable, resourceSnapshot, treeRss } from "./resources.mjs";

const [root, path, csv, interval, record] = process.argv.slice(2);
const roots = new Set([Number(root)]);
let peak = 0;
writeFileSync(csv, "at,rssBytes,availableRamBytes,freeDiskBytes,peakRssBytes,agentRssBytes,backgroundRssBytes,hookRssBytes\n");

function backgroundPid() {
  if (!record || !existsSync(record)) return null;
  const db = new DatabaseSync(record, { readOnly: true, timeout: 1000 });
  try { return db.prepare("SELECT pid FROM background WHERE id = 1").get()?.pid ?? null; }
  finally { db.close(); }
}

function sample() {
  const table = processTable();
  treeRss(table, Number(root), roots);
  const background = backgroundPid();
  const excluded = new Set([process.pid]);
  treeRss(table, process.pid, excluded);
  const backgroundTree = new Set(background ? [background] : []);
  if (background) treeRss(table, background, backgroundTree);
  const involved = table.filter(process => !excluded.has(process.pid) && process.pid !== Number(root)
    && (roots.has(process.pid) || backgroundTree.has(process.pid)));
  if (involved.some(process => process.rssUnavailable)) throw new Error("RSS unavailable for a sampled process");
  let agent = 0;
  let worker = 0;
  let hook = 0;
  for (const process of involved) {
    if (backgroundTree.has(process.pid)) worker += process.rss;
    else if (/\bmex-hook(?:\.exe|\.cjs)?\b/i.test(process.command)) hook += process.rss;
    else agent += process.rss;
  }
  const rss = agent + worker + hook;
  const state = resourceSnapshot(path);
  peak = Math.max(peak, rss);
  appendFileSync(csv, [state.at, rss, state.availableRam, state.freeDisk, peak, agent, worker, hook].join(",") + "\n");
}

sample();
const timer = setInterval(sample, Number(interval));
process.on("message", () => { clearInterval(timer); sample(); process.disconnect(); });
process.on("disconnect", () => { clearInterval(timer); });
if (process.connected) process.send("ready");
