import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { priceModelCall, priceSession } from "../../../scripts/delivery-replay/cost.mjs";

const fields = ["input", "cacheWrite", "cacheRead", "output"];
const zero = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });

export function records(file) {
  return readFileSync(file, "utf8").split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error("Invalid transcript JSON on line " + (index + 1)); }
  });
}

export function sessionUsage(events, agent, fallbackModel) {
  const { classes, reasoning, unpricedModels } = priceSession(events, agent, { allowUnpriced: true, fallbackModel });
  return {
    input: classes.input.tokens, cacheWrite: classes.cache_write.tokens, cacheRead: classes.cache_read.tokens,
    output: classes.output.tokens, reasoning, unpricedModels,
    dollars: unpricedModels.length ? null : Object.values(classes).reduce((sum, entry) => sum + entry.dollars, 0),
  };
}

export function recordPath(profile) {
  const home = join(profile.env.MEX_HOME, ".mex");
  const pointer = join(home, "location");
  const directory = existsSync(pointer) ? readFileSync(pointer, "utf8").trim() : home;
  const outside = relative(profile.root, directory);
  if (!isAbsolute(directory) || isAbsolute(outside) || outside === ".." || outside.startsWith(".." + sep)) {
    throw new Error("MEX record location is outside the arm");
  }
  return join(directory, "record.db");
}

export function readModelCalls(profile, afterId = 0) {
  const file = recordPath(profile);
  if (!existsSync(file)) {
    if (profile.arm === "mex") throw new Error("MEX arm has no local record");
    return [];
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT id, agent, model, purpose, input, cache_write AS cacheWrite, cache_read AS cacheRead, output, estimated, session_id AS sessionId FROM model_calls WHERE kind = 'headless' AND id > ? ORDER BY id").all(afterId);
  } finally { db.close(); }
}

export function totals(rows) {
  const summed = zero();
  const unknown = new Set();
  let usd = 0;
  let reasoning = 0;
  for (const row of rows) {
    for (const key of fields) summed[key] += row[key];
    reasoning += row.reasoning ?? 0;
    for (const model of row.unpricedModels) unknown.add(model);
    usd += row.dollars ?? 0;
  }
  return { ...summed, reasoning, dollars: unknown.size ? null : usd, unpricedModels: [...unknown].sort(),
    estimated: rows.some(row => Boolean(row.estimated)) };
}

export function modelUsage(calls) {
  return totals(calls.map(call => {
    const priced = priceModelCall(call);
    const dollars = fields.some(key => call[key]) ? priced : 0;
    return { ...call, dollars, unpricedModels: dollars === null ? [call.model ?? "unknown"] : [] };
  }));
}
