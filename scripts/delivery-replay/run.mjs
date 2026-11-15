// Explicit offline replay. Tool commands remain strings and are never run.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, lstatSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { arg, rows, corpus } from "./evaluate.mjs";
import { convert, transcript } from "./convert.mjs";
const quantile = (xs, p) => {
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(v.length * p))] ?? 0;
};
const distribution = xs => ({
  p50: quantile(xs, .5),
  p95: quantile(xs, .95),
  runs: xs.length
});
function driver(binary, home, scorer) {
  const p = spawn(binary, ["--delivery-replay"], {
    windowsHide: true,
    env: {
      ...process.env,
      MEX_HOME: home,
      MEX_TELEMETRY: "0",
      MEX_DELIVERY_SCORER: scorer
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const queued = [];
  let error = "";
  p.stderr.on("data", s => {
    error += s.toString().slice(0, 4096);
  });
  const reader = createInterface({
    input: p.stdout
  });
  reader.on("line", s => {
    const next = queued.shift();
    if (!next) {
      throw Error("Unexpected replay response");
    }
    next.resolve(JSON.parse(s));
  });
  p.on("exit", code => {
    if (code) {
      for (const q of queued) {
        q.reject(Error(error || `Replay exited ${code}`));
      }
    }
  });
  return {
    send: event => new Promise((resolve, reject) => {
      queued.push({
        resolve,
        reject
      });
      p.stdin.write(JSON.stringify(event) + "\n");
    }),
    close: () => new Promise((resolve, reject) => {
      p.once("exit", c => c ? reject(Error(error)) : resolve());
      p.stdin.end();
    })
  };
}
function copyBounded(source, dest, budget) {
  if (!existsSync(source)) {
    return false;
  }
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || budget.bytes + stat.size > 256 * 1024 * 1024) {
    return false;
  }
  mkdirSync(resolve(dest, ".."), {
    recursive: true
  });
  copyFileSync(source, dest);
  budget.bytes += stat.size;
  return true;
}
function safeChild(root, path) {
  const dest = resolve(root, path),
    rel = relative(root, dest);
  return !rel.startsWith("..") && !isAbsolute(rel) ? dest : undefined;
}
function summary(file, labels, events) {
  const db = new DatabaseSync(file, {
    readOnly: true
  });
  db.exec("PRAGMA query_only=ON");
  const cols = db.prepare("PRAGMA table_info(deliveries)").all().map(x => x.name);
  const deliveries = db.prepare(`SELECT session_id,agent_id,epoch,entry_id,moment,form,tokens,action,${cols.includes("detail") ? "detail" : "'' AS detail"} FROM deliveries ORDER BY session_id,agent_id,epoch,rowid`).all();
  const epochs = db.prepare("SELECT session_id,agent_id,epoch,budget,tokens_sent,reserved_tokens FROM epochs ORDER BY session_id,agent_id,epoch").all();
  const followups = db.prepare("SELECT d.action,f.kind,count(*) AS count FROM followups f JOIN deliveries d ON d.id=f.delivery_id GROUP BY d.action,f.kind ORDER BY d.action,f.kind").all();
  const epochCols = db.prepare("PRAGMA table_info(epochs)").all().map(x => x.name);
  const counts = {
    helped: 0,
    wrong: 0,
    falseSends: 0,
    missed: 0,
    tokens: 0,
    deliveries: 0,
    budgetBinds: 0,
    ceilingBinds: 0,
    similar: 0,
    conflicts: 0
  };
  for (let i = 0; i < labels.length; i++) {
    const q = labels[i],
      sent = deliveries.filter(d => d.session_id === `session-${i}` && ["given", "replaced"].includes(d.action) && d.moment !== "correction"),
      ids = [...new Set(sent.map(x => x.entry_id))],
      allowed = new Set([...q.relevant, ...q.acceptable]);
    counts.helped += Number(q.relevant.some(id => ids.includes(id)));
    counts.missed += q.relevant.filter(id => !ids.includes(id)).length;
    counts.wrong += ids.filter(id => !allowed.has(id)).length;
    counts.falseSends += Number(!q.relevant.length && !q.acceptable.length && ids.length > 0);
  }
  counts.tokens = deliveries.filter(x => ["given", "replaced"].includes(x.action)).reduce((s, x) => s + x.tokens, 0);
  counts.deliveries = deliveries.filter(x => ["given", "replaced"].includes(x.action)).length;
  counts.budgetBinds = epochs.filter(e => deliveries.some(d => d.session_id === e.session_id && d.agent_id === e.agent_id && d.epoch === e.epoch && d.action === "held-back" && d.detail !== "investigating")).length;
  for (const q of labels.keys()) {
    const es = epochs.filter(e => e.session_id === `session-${q}`);
    const total = es.reduce((s, e) => s + e.tokens_sent + e.reserved_tokens, 0);
    if (es.length && total > 3 * es[0].budget) {
      counts.ceilingBinds++;
    }
  }
  counts.similar = deliveries.filter(x => x.detail === "similar").length;
  counts.conflicts = deliveries.filter(x => x.detail === "conflict").length;
  if (epochCols.includes("closed")) {
    const estimate = db.prepare(`SELECT count(*) AS total,sum(CASE WHEN NOT EXISTS(SELECT 1 FROM followups f WHERE f.delivery_id=d.id) AND NOT EXISTS(SELECT 1 FROM delivery_touches t WHERE t.delivery_id=d.id) THEN 1 ELSE 0 END) AS empty FROM deliveries d JOIN epochs e ON e.session_id=d.session_id AND e.agent_id=d.agent_id AND e.epoch=d.epoch WHERE e.closed=1 AND d.action IN ('given','replaced') AND d.moment<>'correction'`).get();
    counts.closedDeliveries = estimate.total;
    counts.estimatedFalse = estimate.empty ?? 0;
  }
  db.close();
  return {
    counts,
    followups,
    deliveries,
    epochs,
    events
  };
}
function buildFixtures(labels, data, work, sources) {
  const fixtures = {};
  for (const repo of [...new Set(labels.map(q => q.repo))].sort()) {
    const c = corpus(data, repo),
      root = join(work, "repos", repo),
      project = "g-" + createHash("sha256").update(repo).digest("hex").slice(0, 24),
      budget = {
        bytes: 0
      };
    mkdirSync(join(root, ".git"), {
      recursive: true
    });
    mkdirSync(join(root, ".mex", "learned"), {
      recursive: true
    });
    for (const e of c.entries) {
      if (c.levels[e.id] === "team") {
        copyFileSync(join(data, "corpora", repo, "learned", e.id + ".md"), join(root, ".mex", "learned", e.id + ".md"));
      }
    }
    const targets = new Set(c.entries.flatMap(e => e.checks.flatMap(k => [...Object.keys(k.files ?? {}), k.target?.file].filter(Boolean))));
    let copied = 0;
    for (const path of [...targets].sort()) {
      const source = safeChild(sources[repo], path),
        dest = safeChild(root, path);
      if (source && dest && copyBounded(source, dest, budget)) {
        copied++;
      }
    }
    fixtures[repo] = {
      ...c,
      root,
      project,
      copied,
      budget,
      sourceBytes: budget.bytes
    };
  }
  return fixtures;
}
async function loadEvents(labels, fixtures, sessions) {
  const converted = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i],
      f = fixtures[label.repo],
      file = safeChild(sessions, label.session);
    if (!file) {
      throw Error("Session path escaped root");
    }
    converted.push(convert(await transcript(file), {
      session: `session-${i}`,
      project: f.project,
      checkout: f.root,
      oldRoot: label.checkout_root,
      subagent: label.session.includes("/subagents/")
    }));
  }
  return converted;
}
function stageObservedFiles(fixtures, converted, sources) {
  // Stage current files touched by the historical events and the native rule
  // files for those folders. No historical edit is applied or command run.
  for (const [repo, f] of Object.entries(fixtures)) {
    const paths = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", ".claude/CLAUDE.md"]);
    for (const sequence of converted) {
      for (const event of sequence) {
        if (event.project_id === f.project) {
          for (const t of [...(event.batch ?? []), ...(event.tool ? [event.tool] : [])]) {
            if (!t.input?.path) {
              continue;
            }
            const rel = relative(f.root, t.input.path);
            if (rel.startsWith("..") || isAbsolute(rel)) {
              continue;
            }
            paths.add(rel);
            const parts = rel.replaceAll("\\", "/").split("/").slice(0, -1);
            for (let i = 1; i <= Math.min(parts.length, 64); i++) {
              for (const file of ["CLAUDE.md", "AGENTS.md", "AGENTS.override.md", "CLAUDE.local.md"]) {
                paths.add(parts.slice(0, i).join("/") + "/" + file);
              }
            }
          }
        }
      }
    }
    const rules = join(sources[repo], ".claude", "rules");
    if (existsSync(rules)) {
      for (const file of readdirSync(rules).filter(n => n.endsWith(".md")).sort().slice(0, 64)) {
        paths.add(".claude/rules/" + file);
      }
    }
    f.extraFiles = 0;
    for (const path of [...paths].sort()) {
      const source = safeChild(sources[repo], path),
        dest = safeChild(f.root, path);
      if (source && dest && !existsSync(dest) && copyBounded(source, dest, f.budget)) {
        f.extraFiles++;
      }
    }
    f.sourceBytes = f.budget.bytes;
  }
}
function stageLane(exe, mex, data, fixtures) {
  for (const [repo, f] of Object.entries(fixtures)) {
    for (const [dir, level] of [["notes", "personal"], ["hints", "hint"]]) {
      const dest = join(mex, "projects", f.project, dir);
      mkdirSync(dest, {
        recursive: true
      });
      for (const e of f.entries) {
        if (f.levels[e.id] === level) {
          copyFileSync(join(data, "corpora", repo, dir, e.id + ".md"), join(dest, e.id + ".md"));
        }
      }
    }
    const check = spawnSync(exe, ["--check-run"], {
      input: JSON.stringify({
        action: "evaluate",
        checkout: f.root,
        project_id: f.project,
        mex_home: mex,
        record_directory: mex,
        store: true
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024
    });
    if (check.status || !JSON.parse(check.stdout).ok) {
      throw Error(check.stderr || check.stdout);
    }
  }
}
export async function replay() {
  const data = resolve(arg("--qset")),
    sessions = resolve(arg("--sessions")),
    binary = resolve(arg("--binary")),
    base = arg("--base"),
    sources = JSON.parse(readFileSync(resolve(arg("--sources")), "utf8")),
    output = resolve(arg("--output")),
    split = arg("--split", "dev");
  if (!["dev", "test"].includes(split)) {
    throw Error("Use dev or test");
  }
  const labels = rows(join(data, "sessions", split + ".jsonl")),
    work = join(output, "work-" + Date.now());
  mkdirSync(work, {
    recursive: true
  });
  const fixtures = buildFixtures(labels, data, work, sources);
  const converted = await loadEvents(labels, fixtures, sessions);
  stageObservedFiles(fixtures, converted, sources);
  const variants = [],
    timings = [];
  for (const scorer of ["tiers", "bm25", "fcfs", "risk"]) {
    const lanes = [];
    for (const [name, exe] of [["current", binary], ...(base ? [["base", resolve(base)]] : [])]) {
      const home = join(work, scorer, name),
        mex = join(home, ".mex");
      mkdirSync(mex, {
        recursive: true
      });
      stageLane(exe, mex, data, fixtures);
      lanes.push({
        name,
        home,
        mex,
        driver: driver(exe, home, scorer),
        times: [],
        failed: 0,
        failures: [],
        contexts: [],
        phaseSamples: []
      });
    }
    let n = 0;
    const deltas = [];
    for (const sequence of converted) {
      for (const ev of sequence) {
        const replies = {};
        for (const lane of n++ % 2 ? [...lanes].reverse() : lanes) {
          const r = await lane.driver.send(ev);
          lane.times.push(r.ns / 1e6);
          if (r.phases) {
            lane.phaseSamples.push({
              event: n,
              kind: ev.kind,
              phases: r.phases
            });
          }
          lane.failed += Number(r.failed);
          if (r.failed) {
            lane.failures.push({
              event: n,
              kind: ev.kind,
              error: r.error ?? "unavailable",
              phases: r.phases
            });
          }
          if (r.reply.context) {
            lane.contexts.push({
              event: n,
              text: r.reply.context.replace(/\[mex [a-f0-9]+\]/g, "[mex block]")
            });
          }
          replies[lane.name] = r.ns / 1e6;
        }
        if (base) {
          deltas.push(replies.current - replies.base);
        }
      }
    }
    for (const lane of lanes) {
      await lane.driver.close();
      const s = summary(join(lane.mex, "hooks.db"), labels, n);
      variants.push({
        scorer,
        lane: lane.name,
        ...s
      });
      timings.push({
        scorer,
        lane: lane.name,
        failedEvents: lane.failed,
        failures: lane.failures,
        ...(lane.phaseSamples.length ? {
          phaseSamples: lane.phaseSamples
        } : {}),
        ...distribution(lane.times)
      });
    }
    if (base) {
      timings.push({
        scorer,
        lane: "paired-delta",
        ...distribution(deltas)
      });
    }
    console.log(scorer, JSON.stringify(variants.at(base ? -2 : -1).counts));
  }
  mkdirSync(output, {
    recursive: true
  });
  writeFileSync(join(output, "replay.json"), JSON.stringify({
    split,
    definition: "Session-level useful-at-some-point labels. Helped counts sessions; wrong counts distinct unacceptable ids per session; missed counts required ids. Receipt tokens are estimates. No recorded command executed.",
    fixtures: Object.fromEntries(Object.entries(fixtures).map(([repo, f]) => [repo, {
      entries: f.entries.length,
      copiedCheckFiles: f.copied,
      copiedTouchOrRuleFiles: f.extraFiles,
      sourceBytes: f.sourceBytes
    }])),
    variants
  }, null, 2) + "\n");
  writeFileSync(join(output, "timing.json"), JSON.stringify({
    definition: "Controller time in persistent real binary, excluding startup, interleaved base/current per event",
    timings
  }, null, 2) + "\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await replay();
}
