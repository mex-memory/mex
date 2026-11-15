// Interleave cold CLI recall measurements against an isolated base build.
import { mkdirSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { arg } from "./evaluate.mjs";
const current = resolve(arg("--current")),
  base = resolve(arg("--base")),
  binary = resolve(arg("--binary")),
  output = resolve(arg("--output")),
  runs = Number(arg("--runs", "20"));
if (!Number.isInteger(runs) || runs < 5 || runs > 200) {
  throw Error("Invalid run count");
}
const root = join(resolve(arg("--work")), "recall-" + Date.now()),
  repo = join(root, "repo"),
  home = join(root, "home");
mkdirSync(repo, {
  recursive: true
});
mkdirSync(home, {
  recursive: true
});
const env = {
  ...process.env,
  MEX_HOME: home,
  MEX_TELEMETRY: "0",
  MEX_HOOK_BINARY: binary
};
function cli(file, args) {
  const start = performance.now(),
    r = spawnSync(process.execPath, [file, ...args], {
      cwd: repo,
      env,
      windowsHide: true,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024
    });
  if (r.status || r.error) {
    throw Error(r.error ?? r.stderr);
  }
  return {
    ms: performance.now() - start,
    json: JSON.parse(r.stdout)
  };
}
const saved = cli(base, ["note", "Shared pool survives requests because all requests reuse it.", "--kind", "pitfall", "--json"]).json;
const db = new DatabaseSync(join(home, ".mex", "record.db"), {
    readOnly: true
  }),
  project = db.prepare("SELECT project_id FROM checkouts LIMIT 1").get().project_id;
db.close();
const notes = join(home, ".mex", "projects", project, "notes");
for (let i = 0; i < 500; i++) {
  const id = i === 0 ? saved.entry.mex.id : "mx_timing" + String(i).padStart(4, "0"),
    text = i === 0 ? "Dedicated pool survives requests because all requests reuse it." : `Module ${i} retains isolated storage because its ownership is local.`;
  const e = {
    id,
    kind: "pitfall",
    scope: ["src/**"],
    source: {
      type: "person",
      ref: "mex note 2026-11-15",
      quote: text
    },
    evidence: "person",
    one_line: text,
    checks: [],
    status: "active",
    created: "2026-11-15"
  };
  writeFileSync(join(notes, id + ".md"), "---\nmex: " + JSON.stringify(e) + "\n---\n" + text + "\n");
}
if (readdirSync(notes).filter(n => n.endsWith(".md")).length !== 500) {
  throw Error("Fixture does not have 500 entries");
}
const times = {
  base: [],
  current: [],
  delta: []
};
for (let i = -2; i < runs; i++) {
  const r = {};
  for (const lane of i % 2 ? ["current", "base"] : ["base", "current"]) {
    r[lane] = cli(lane === "base" ? base : current, ["recall", "dedicated pool", "--json"]);
    if (r[lane].json.entries.length !== 1) {
      throw Error("Recall fixture " + lane + " returned " + r[lane].json.entries.length + " items: " + JSON.stringify(r[lane].json).slice(0, 600));
    }
  }
  ;
  if (i >= 0) {
    times.base.push(r.base.ms);
    times.current.push(r.current.ms);
    times.delta.push(r.current.ms - r.base.ms);
  }
}
const stat = xs => {
  const v = [...xs].sort((a, b) => a - b);
  return {
    p50: v[Math.floor(v.length * .5)],
    p95: v[Math.min(v.length - 1, Math.floor(v.length * .95))],
    runs: v.length
  };
};
const report = {
  fixtureEntries: 500,
  returned: 1,
  definition: "Cold real Node CLI processes, paired and interleaved; delta=current-base, milliseconds",
  ...Object.fromEntries(Object.entries(times).map(([k, v]) => [k, stat(v)]))
};
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
