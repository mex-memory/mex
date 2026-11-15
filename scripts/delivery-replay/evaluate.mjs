// Dev-only by default. The reviewer may explicitly pass --split test once.
// No stored command is executed and no network service is used.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, lstatSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { fileURLToPath } from "node:url";
import { convert, transcript } from "./convert.mjs";
export const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
export function rows(file) {
  if (lstatSync(file).size > 64 * 1024 * 1024) {
    throw Error("Label file exceeds bound");
  }
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
export function corpus(root, repo) {
  const entries = [],
    levels = {};
  for (const [dir, level] of [["learned", "team"], ["notes", "personal"], ["hints", "hint"]]) {
    const path = join(root, "corpora", repo, dir);
    if (!existsSync(path)) {
      continue;
    }
    for (const name of readdirSync(path).filter(n => /^mx_[a-z0-9]+\.md$/.test(n)).sort()) {
      const file = join(path, name),
        stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) {
        throw Error("Invalid corpus file");
      }
      const s = readFileSync(file, "utf8"),
        m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(s);
      if (!m) {
        throw Error("Invalid corpus entry");
      }
      const mex = parse(m[1]).mex;
      entries.push({
        ...mex,
        text: m[2].trim()
      });
      levels[mex.id] = level;
    }
  }
  const alias = join(root, "corpora", repo, "aliases.json");
  return {
    entries,
    levels,
    aliases: existsSync(alias) ? JSON.parse(readFileSync(alias, "utf8")) : {}
  };
}
export function native(binary, request, env = {}) {
  const r = spawnSync(binary, ["--recall"], {
    input: JSON.stringify(request),
    encoding: "utf8",
    windowsHide: true,
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      MEX_TELEMETRY: "0",
      MEX_BACKGROUND: "1",
      ...env
    }
  });
  if (r.error || r.status !== 0) {
    throw Error(r.error?.message ?? r.stderr);
  }
  const result = JSON.parse(r.stdout);
  if (!result.ok) {
    throw Error(result.error);
  }
  return result;
}
export function metrics(labels, results, variant = 0) {
  let helped = 0,
    wrong = 0,
    falseSends = 0,
    missed = 0,
    optional = 0,
    mrr = 0,
    positives = 0,
    sent = 0;
  for (let i = 0; i < labels.length; i++) {
    const q = labels[i],
      r = results[i],
      ids = (r.selected[variant] ?? []).map(x => x.id),
      allowed = new Set([...q.relevant, ...q.acceptable]);
    sent += ids.length;
    wrong += ids.filter(id => !allowed.has(id)).length;
    optional += ids.filter(id => q.acceptable.includes(id)).length;
    if (q.relevant.length) {
      positives++;
      if (ids.some(id => q.relevant.includes(id))) {
        helped++;
      } else {
        missed++;
      }
      const at = (r.ranked ?? []).findIndex(x => q.relevant.includes(x.id));
      if (at >= 0) {
        mrr += 1 / (at + 1);
      }
    } else if (!q.acceptable.length && ids.length) {
      falseSends++;
    }
  }
  return {
    helped,
    wrong,
    falseSends,
    missed,
    optional,
    sent,
    mrr: positives ? mrr / positives : 0,
    positives,
    queries: labels.length
  };
}
export function gates() {
  const out = [];
  for (const floor of [.24, .34, .42, .55, .7]) {
    for (const groups of [2, 3, 4]) {
      for (const margin of [.2, .45, .6]) {
        for (const ratio of [.75, .95]) {
          out.push({
            floor,
            groups,
            margin,
            ratio,
            max: 2,
            cosine: .5
          });
        }
      }
    }
  }
  return out;
}
// Fixed, counts-only check of real typed development turns. Session labels
// mean useful at some point; this check never tunes the frozen gate.
async function realPromptCheck(data, binary) {
  const sessions = resolve(arg("--sessions", join(data, "..", "sessions", "claude-code-sessions")));
  if (!existsSync(sessions)) {
    return {
      notRun: "Saved development transcripts unavailable"
    };
  }
  const prompts = [];
  for (const label of rows(join(data, "sessions", "dev.jsonl"))) {
    const file = resolve(sessions, label.session),
      rel = relative(sessions, file);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw Error("Session path escaped root");
    }
    const events = convert(await transcript(file), {
      session: "check",
      project: "check",
      checkout: "/fixture",
      oldRoot: label.checkout_root,
      subagent: label.session.includes("/subagents/")
    });
    for (const event of events) {
      if (event.kind === "prompt" && event.prompt.typed) {
        prompts.push({
          ...label,
          prompt: event.prompt.text
        });
      }
    }
  }
  let sent = 0,
    wrong = 0,
    helped = 0;
  for (const repo of [...new Set(prompts.map(q => q.repo))].sort()) {
    const qs = prompts.filter(q => q.repo === repo),
      c = corpus(data, repo);
    const result = native(binary, {
      entries: c.entries,
      queries: qs.map((q, i) => ({
        id: String(i),
        text: q.prompt
      })),
      gates: [{
        learned: true
      }]
    });
    const m = metrics(qs, result.results);
    sent += m.sent;
    wrong += m.wrong;
    helped += m.helped;
  }
  return {
    queries: prompts.length,
    sent,
    wrong,
    helped
  };
}
export async function evaluate() {
  const data = resolve(arg("--qset")),
    binary = resolve(arg("--binary")),
    split = arg("--split", "dev");
  if (!["dev", "test"].includes(split)) {
    throw Error("Use --split dev or test");
  }
  const labels = [...rows(join(data, "prompts", split + ".jsonl"))];
  const extra = join(data, "prompts", "extra-" + split + ".jsonl");
  if (existsSync(extra)) {
    labels.push(...rows(extra));
  }
  const configs = arg("--learned") ? [{
      learned: true
    }] : gates(),
    output = resolve(arg("--output"));
  mkdirSync(dirname(output), {
    recursive: true
  });
  const reports = [];
  const cache = {};
  for (const aliases of [false, true]) {
    const all = [];
    for (const repo of [...new Set(labels.map(q => q.repo))].sort()) {
      const c = corpus(data, repo),
        qs = labels.filter(q => q.repo === repo);
      const r = native(binary, {
        entries: c.entries,
        aliases: aliases ? c.aliases : {},
        queries: qs.map(q => ({
          id: q.id,
          text: q.prompt
        })),
        gates: configs
      });
      for (let i = 0; i < qs.length; i++) {
        all.push({
          label: qs[i],
          row: r.results[i]
        });
      }
      cache[repo + ":" + aliases] = {
        ...c,
        queries: qs,
        result: r
      };
    }
    for (let g = 0; g < configs.length; g++) {
      reports.push({
        aliases,
        gate: configs[g],
        ...metrics(all.map(x => x.label), all.map(x => x.row), g)
      });
    }
  }
  reports.sort((a, b) => b.helped - 2 * b.wrong - (a.helped - 2 * a.wrong) || a.falseSends - b.falseSends || a.sent - b.sent || b.gate.floor - a.gate.floor);
  const realPrompts = split === "dev" ? await realPromptCheck(data, binary) : undefined;
  const best = reports[0];
  writeFileSync(output, JSON.stringify({
    split,
    includesExtra: existsSync(extra),
    definition: "helped: positive queries with a required hit; wrong: items outside relevant/acceptable; falseSends: empty-label queries receiving an item; MRR: lexical top 20",
    realPrompts,
    best,
    variants: reports
  }, null, 2) + "\n");
  writeFileSync(output.replace(/\.json$/, ".cache.json"), JSON.stringify(cache));
  console.log(JSON.stringify(best));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await evaluate();
}
