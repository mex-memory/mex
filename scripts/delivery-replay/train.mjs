// Offline, deterministic five-fold development evaluation. No test split reads.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { arg, rows, corpus, native, gates, metrics } from "./evaluate.mjs";
const seed = "20261115",
  data = resolve(arg("--qset")),
  binary = resolve(arg("--binary")),
  output = resolve(arg("--output"));
const labels = rows(join(data, "prompts", "dev.jsonl"));
if (existsSync(join(data, "prompts", "extra-dev.jsonl"))) {
  labels.push(...rows(join(data, "prompts", "extra-dev.jsonl")));
}
const mode = arg("--mode", "lexical"),
  previous = arg("--previous") ? JSON.parse(readFileSync(resolve(arg("--previous")), "utf8")) : undefined;
const pairs = [];
for (const repo of [...new Set(labels.map(q => q.repo))].sort()) {
  const c = corpus(data, repo),
    qs = labels.filter(q => q.repo === repo),
    r = native(binary, {
      mode,
      entries: c.entries,
      queries: qs.map(q => ({
        id: q.id,
        text: q.prompt
      })),
      gates: gates()
    });
  for (let i = 0; i < qs.length; i++) {
    pairs.push({
      label: qs[i],
      row: r.results[i]
    });
  }
}
const groups = new Map();
for (const p of pairs) {
  const key = p.label.repo + "/" + p.label.kind;
  if (!groups.has(key)) {
    groups.set(key, []);
  }
  groups.get(key).push(p);
}
let offset = 0;
const hash = id => createHash("sha256").update(seed + id).digest("hex");
for (const key of [...groups.keys()].sort()) {
  const group = groups.get(key).sort((a, b) => hash(a.label.id).localeCompare(hash(b.label.id)));
  group.forEach((p, i) => p.fold = (offset + i) % 5);
  offset = (offset + group.length) % 5;
}
const quality = m => m.helped - 2 * m.wrong;
const better = (a, b) => quality(b) - quality(a) || a.falseSends - b.falseSends || a.sent - b.sent;
const score = (ps, selected) => metrics(ps.map(x => x.label), ps.map((p, i) => ({
  ...p.row,
  selected: [selected(p, i)]
})), 0);
function logistic(z) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}
function fit(ps, l2) {
  const samples = ps.flatMap(p => p.row.ranked.slice(0, 2).map(r => ({
      x: r.features,
      y: Number([...p.label.relevant, ...p.label.acceptable].includes(r.id))
    }))),
    n = samples.length,
    d = samples[0].x.length;
  const mean = Array(d).fill(0),
    scale = Array(d).fill(1);
  for (let j = 1; j < d; j++) {
    mean[j] = samples.reduce((s, r) => s + r.x[j], 0) / n;
    scale[j] = Math.max(.01, Math.sqrt(samples.reduce((s, r) => s + (r.x[j] - mean[j]) ** 2, 0) / n));
  }
  const normalized = samples.map(r => ({
      y: r.y,
      x: r.x.map((v, j) => Math.max(-20, Math.min(20, (v - mean[j]) / scale[j])))
    })),
    weights = Array(d).fill(0);
  for (let epoch = 0; epoch < 800; epoch++) {
    const grad = Array(d).fill(0);
    for (const r of normalized) {
      const e = logistic(r.x.reduce((s, v, j) => s + v * weights[j], 0)) - r.y;
      for (let j = 0; j < d; j++) {
        grad[j] += e * r.x[j];
      }
    }
    for (let j = 0; j < d; j++) {
      weights[j] -= .08 * (grad[j] / n + (j ? l2 * weights[j] / n : 0));
    }
  }
  return {
    mean,
    scale,
    weights,
    l2
  };
}
function probability(r, m) {
  return logistic(r.features.reduce((s, v, j) => s + Math.max(-20, Math.min(20, (v - m.mean[j]) / m.scale[j])) * m.weights[j], 0));
}
const select = (p, m, t) => p.row.ranked.slice(0, 2).filter(r => probability(r, m) >= t);
function tune(ps) {
  const variants = [];
  for (const l2 of [.1, 1, 10, 100]) {
    const model = fit(ps, l2);
    for (let i = 15; i <= 95; i += 2) {
      const threshold = i / 100,
        m = score(ps, p => select(p, model, threshold));
      variants.push({
        model,
        threshold,
        ...m
      });
    }
  }
  variants.sort(better);
  return variants[0];
}
function baseline(ps) {
  return gates().map((gate, g) => ({
    gate,
    g,
    ...score(ps, p => p.row.selected[g])
  })).sort(better)[0];
}
const folds = [];
for (let fold = 0; fold < 5; fold++) {
  const train = pairs.filter(p => p.fold !== fold),
    test = pairs.filter(p => p.fold === fold),
    b = baseline(train),
    m = tune(train);
  folds.push({
    fold,
    queries: test.length,
    baseline: score(test, p => p.row.selected[b.g]),
    learned: score(test, p => select(p, m.model, m.threshold)),
    threshold: m.threshold,
    l2: m.model.l2
  });
}
const summarize = name => {
  const values = folds.map(f => ({
      ...f[name],
      objective: quality(f[name])
    })),
    out = {};
  for (const k of ["helped", "wrong", "falseSends", "objective"]) {
    const xs = values.map(v => v[k]),
      mean = xs.reduce((a, b) => a + b, 0) / 5;
    out[k] = {
      mean,
      sd: Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / 5),
      min: Math.min(...xs),
      max: Math.max(...xs),
      sum: xs.reduce((a, b) => a + b, 0)
    };
  }
  return out;
};
const b = baseline(pairs),
  winner = tune(pairs),
  cv = {
    baseline: summarize("baseline"),
    learned: summarize("learned")
  };
const comparison = previous?.cv.learned ?? cv.baseline;
const kept = cv.learned.objective.sum > comparison.objective.sum;
const report = {
  seed,
  folds: 5,
  stratification: "repo and prompt kind; SHA256 seeded ordering; rotating balanced fold assignment",
  rule: "Keep only an increase in held-out helped minus twice wrong; tie prefers fewer false sends and fewer items. Threshold and L2 chosen on each training fold only.",
  mode,
  previous: previous ? {
    round: previous.round,
    cv: comparison
  } : undefined,
  round: previous ? previous.round + 1 : 1,
  idea: mode === "bm25f-common" ? "BM25F with project-common query stop words" : mode === "bm25f" ? "BM25F with field length normalization and the same learned gate" : "L2 logistic abstention over the top two lexical candidates",
  kept,
  cv,
  heldOut: folds,
  inSample: {
    baseline: b,
    learned: {
      ...winner,
      model: undefined
    }
  },
  model: kept ? {
    ...winner.model,
    threshold: winner.threshold
  } : undefined,
  assignments: pairs.map(p => ({
    id: p.label.id,
    fold: p.fold
  }))
};
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({
  kept,
  cv,
  inSample: report.inSample
}));
if (kept && arg("--freeze")) {
  const m = report.model,
    array = xs => "[...]float64{" + xs.map(x => x.toPrecision(17)).join(",") + "}";
  let source = readFileSync(new URL("../../native/delivery/rank/frozen.go", import.meta.url), "utf8");
  source = source.replace(/\/\/ Tuned[\s\S]*?type Gate/, "// Tuned on development prompts only after seeded five-fold validation.\n// No sealed labels read. Reproduce with scripts/delivery-replay/train.mjs.\ntype Gate");
  for (const [name, key] of [["gateMeans", "mean"], ["gateScales", "scale"], ["gateWeights", "weights"]]) {
    source = source.replace(new RegExp("var " + name + " = \\[\\.\\.\\.\\]float64\\{[^}]*\\}"), "var " + name + " = " + array(m[key]));
  }
  source = source.replace(/const gateThreshold = [0-9.]+/, "const gateThreshold = " + m.threshold).replace(/const DefaultMode = "[^"]+"/, "const DefaultMode = \"" + mode + "\"");
  writeFileSync(resolve(arg("--freeze")), source);
}
