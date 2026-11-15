// Offline similarity and directive-conflict study across corpus pairs.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { arg, corpus } from "./evaluate.mjs";
const root = resolve(arg("--qset")),
  binary = resolve(arg("--binary")),
  output = resolve(arg("--output"));
const all = [],
  labels = new Set(),
  conflicts = new Set();
const key = (a, b) => [a, b].sort().join("/");
for (const repo of readdirSync(join(root, "corpora")).sort()) {
  const notes = readFileSync(join(root, "corpora", repo, "NOTES.md"), "utf8");
  for (const m of notes.matchAll(/Near-duplicate pair: `(mx_\w+)` \/ `(mx_\w+)`/g)) {
    labels.add(key(m[1], m[2]));
  }
  for (const m of notes.matchAll(/Conflicting policy\/context pair: `(mx_\w+)` \/ `(mx_\w+)`/g)) {
    conflicts.add(key(m[1], m[2]));
  }
  const r = spawnSync(binary, ["--pair-study"], {
    input: JSON.stringify({
      entries: corpus(root, repo).entries
    }),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  if (r.error || r.status) {
    throw Error(r.error ?? r.stderr);
  }
  all.push(...JSON.parse(r.stdout));
}
const variants = [];
for (const threshold of [null, .6, .7, .8, .85, .9, .95, 1]) {
  const selected = all.filter(p => threshold === null ? p.shingles : p.containment >= threshold),
    hits = selected.filter(p => labels.has(key(p.a, p.b))).length;
  // Unlabelled, overlapping pairs are treated conservatively as false merges.
  const falseMerges = selected.filter(p => p.overlap && !labels.has(key(p.a, p.b))).length;
  variants.push({
    method: threshold === null ? "three-shingle" : "stemmed-word-containment",
    threshold,
    duplicates: hits,
    totalDuplicates: labels.size,
    falseMerges,
    selected: selected.length,
    objective: hits - 4 * falseMerges
  });
}
const directiveTrial = {
  detected: all.filter(p => p.directive).length,
  labelled: conflicts.size,
  hits: all.filter(p => p.directive && conflicts.has(key(p.a, p.b))).length,
  falseConflicts: all.filter(p => p.directive && p.overlap && !conflicts.has(key(p.a, p.b))).length
};
writeFileSync(output, JSON.stringify({
  definition: "Unlabelled overlapping pairs count as false merges or trial conflicts; duplicate recall minus four times false merges",
  pairs: all.length,
  sameScopePairs: all.filter(p => p.overlap).length,
  variants,
  conflicts: {
    detected: all.filter(p => p.conflict).length,
    labelled: conflicts.size,
    hits: all.filter(p => p.conflict && conflicts.has(key(p.a, p.b))).length
  },
  directiveTrial,
  selectedPairs: all.filter(p => p.shingles || p.conflict || p.directive)
}, null, 2) + "\n");
console.log(JSON.stringify({
  variants,
  directiveTrial
}));
