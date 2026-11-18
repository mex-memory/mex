// Optional, offline evaluation only. Model paths and runtime are supplied by
// the operator; none are downloaded, bundled, or invoked by an ordinary hook.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { arg, corpus, rows, native, metrics, gates } from "./evaluate.mjs";
const data = resolve(arg("--qset")),
  binary = resolve(arg("--binary")),
  split = arg("--split", "dev");
if (!["dev", "test"].includes(split)) {
  throw Error("Invalid split");
}
const labels = [...rows(resolve(data, "prompts", split + ".jsonl"))];
try {
  labels.push(...rows(resolve(data, "prompts", "extra-" + split + ".jsonl")));
} catch (e) {
  if (e.code !== "ENOENT") {
    throw e;
  }
}
const manifest = JSON.parse(readFileSync(arg("--models"), "utf8")),
  configs = gates();
const baselineGate = {
  floor: .55,
  groups: 2,
  margin: .6,
  ratio: .95,
  max: 2,
  cosine: .5
};
const reports = [];
for (const spec of [{
  name: "lexical"
}, ...manifest.models, ...(manifest.ceiling ? [manifest.ceiling] : [])]) {
  const pairs = [],
    cache = {};
  let extractor;
  if (spec.runtime) {
    const runtime = await import(pathToFileURL(resolve(spec.runtime)));
    runtime.env.allowRemoteModels = false;
    runtime.env.localModelPath = spec.root;
    extractor = await runtime.pipeline("feature-extraction", spec.model, {
      dtype: "q8"
    });
  }
  for (const repo of [...new Set(labels.map(q => q.repo))].sort()) {
    const c = corpus(data, repo),
      qs = labels.filter(q => q.repo === repo),
      query = qs.map(q => ({
        id: q.id,
        text: q.prompt
      }));
    let request = {
      mode: "lexical",
      entries: c.entries,
      queries: query,
      gates: configs
    };
    if (spec.path) {
      Object.assign(request, {
        model: spec.path,
        dims: spec.dims
      });
    }
    if (extractor) {
      const docs = native(binary, {
        ...request,
        gates: [baselineGate]
      }).docs;
      const texts = [...docs.map(d => d.title + ". " + d.text + " " + (d.scope ?? []).join(" ") + " " + (d.aliases ?? []).join(" ")), ...query.map(q => q.text)];
      const vectors = [];
      for (let i = 0; i < texts.length; i += 16) {
        const t = await extractor(texts.slice(i, i + 16), {
          pooling: "mean",
          normalize: true,
          truncation: true,
          max_length: 256
        });
        const dim = t.dims.at(-1);
        for (let j = 0; j < t.dims[0]; j++) {
          vectors.push(Array.from(t.data.slice(j * dim, (j + 1) * dim)));
        }
      }
      request.vectors = Object.fromEntries(docs.map((d, i) => [d.id, vectors[i]]));
      request.queries = query.map((q, i) => ({
        ...q,
        vector: vectors[docs.length + i]
      }));
    }
    const active = spec.name === "lexical" ? configs : configsDense();
    request.gates = active;
    const r = native(binary, request);
    qs.forEach((label, i) => pairs.push({
      label,
      result: r.results[i]
    }));
    cache[repo] = {
      request: {
        ...request,
        queries: undefined,
        gates: [baselineGate],
        vectors: r.vectors
      },
      query: query[0]
    };
  }
  const variants = (spec.name === "lexical" ? configs : configsDense()).map((gate, i) => ({
    gate,
    ...metrics(pairs.map(x => x.label), pairs.map(x => x.result), i)
  }));
  variants.sort((a, b) => b.helped - b.wrong - (a.helped - a.wrong) || a.falseSends - b.falseSends || a.sent - b.sent);
  reports.push({
    name: spec.name,
    licence: spec.licence ?? "none",
    best: variants[0],
    qualified: variants.filter(r => r.helped - r.wrong >= 30 && r.wrong <= 9 && r.falseSends <= 8),
    variants
  });
  writeFileSync(arg("--output") + "." + spec.name + ".cache.json", JSON.stringify(cache));
  console.log(JSON.stringify({
    name: spec.name,
    best: variants[0],
    qualityQualified: reports.at(-1).qualified.length
  }));
  if (extractor) {
    await extractor.dispose();
  }
  writeFileSync(arg("--output"), JSON.stringify({
    split,
    predeclared: {
      netGain: 5,
      wrongNoWorse: true,
      falseNoWorse: true,
      coldAddedP95MaxMS: 10
    },
    reports
  }, null, 2) + "\n");
}
function configsDense() {
  const out = [];
  for (const floor of [.24, .42, .55]) {
    for (const groups of [2, 3]) {
      for (const margin of [0, .02, .05]) {
        for (const ratio of [.98, 1]) {
          for (const cosine of [.3, .5, .7]) {
            out.push({
              floor,
              groups,
              margin,
              ratio,
              max: 2,
              cosine
            });
          }
        }
      }
    }
  }
  return out;
}
