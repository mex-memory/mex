#!/usr/bin/env node
// Compute pre-run complexity from immutable repository objects and gold patches.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./lib/workspace.mjs";
import { validateSuite } from "./lib/suite.mjs";

const source = /\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|c|cpp|h|rb|vue|svelte)$/;
export function patchComplexity(patch, prompt, packages = [], goldSymbols = []) {
  const files = [], symbols = new Set(goldSymbols);
  let added = 0, removed = 0;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = line.match(/ b\/(.+)$/)?.[1];
      if (path) files.push(path);
    } else if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    if ((/^[+ -]/.test(line) || line.startsWith("@@")) && !/^(?:\+\+\+|---)/.test(line)) {
      for (const m of line.matchAll(/\b(?:function|class|interface|type|enum|const|let|def|fn)\s+([A-Za-z_$][\w$]*)/g)) symbols.add(m[1]);
    }
  }
  const names = [...new Set(files)];
  const span = names.map((file) => {
    let dir = posix.dirname(file);
    while (dir !== ".") { if (packages.includes(`${dir}/package.json`)) return dir; dir = posix.dirname(dir); }
    return ".";
  });
  const mentions = (name) => prompt.includes(name);
  const namedFiles = names.filter((p) => mentions(p) || mentions(posix.basename(p)));
  const namedSymbols = [...symbols].filter((s) => new RegExp(`\\b${s.replace(/[$]/g, "\\$")}\\b`).test(prompt));
  return { goldFiles: names.length, files: names, directories: new Set(names.map(posix.dirname)).size,
    packages: new Set(span).size, packagePaths: [...new Set(span)].sort(), goldLinesChanged: added + removed,
    added, removed, promptNamesGold: namedFiles.length > 0 || namedSymbols.length > 0, namedFiles, namedSymbols };
}

export function annotateComplexity(suite, subject, suiteDir = ".") {
  const cache = new Map();
  for (const task of suite.tasks) {
    if (!cache.has(task.base)) {
      const paths = git(subject, ["ls-tree", "-r", "--name-only", task.base]).stdout.trim().split("\n");
      let loc = 0;
      for (const path of paths.filter((p) => source.test(p) && !/(?:^|\/)(?:node_modules|vendor|dist)\//.test(p))) {
        const text = git(subject, ["show", `${task.base}:${path}`]).stdout;
        loc += text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
      }
      cache.set(task.base, { loc, packages: paths.filter((p) => /(?:^|\/)package.json$/.test(p)) });
    }
    const patchFile = task.goldPatch ?? task.gold?.patch;
    const fix = task.goldCommit ?? task.mergeCommit ?? task.hiddenTests?.fromCommit;
    if (!patchFile && !fix && task.type === "change") throw new Error(`goldPatch or goldCommit required to compute complexity: ${task.id}`);
    const patch = patchFile ? readFileSync(resolve(suiteDir, patchFile), "utf8")
      : fix ? git(subject, ["diff", "--ignore-cr-at-eol", task.base, fix, "--"]).stdout
      : (task.gold?.code ?? []).map((g) => `diff --git a/${g.path} b/${g.path}\n ${g.symbol ? `function ${g.symbol}` : ""}`).join("\n");
    const { loc, packages } = cache.get(task.base);
    const symbols = [...(task.gold?.symbols ?? []), ...(task.gold?.code ?? []).flatMap((g) => [g.symbol, g.name, ...(g.symbols ?? [])])].filter((s) => typeof s === "string");
    task.complexity = { ...patchComplexity(patch, task.prompt, packages, symbols), repoSourceLoc: loc,
      provenance: { base: git(subject, ["rev-parse", task.base]).stdout.trim(), gold: patchFile ?? fix, sourceExtensions: source.source } };
    if (task.heavy && task.complexity.promptNamesGold) throw new Error(`heavy task prompt names gold file or symbol: ${task.id}`);
  }
  return suite;
}

export function main(argv) {
  const value = (name) => argv[argv.indexOf(name) + 1];
  if (!["--suite", "--subject", "--output"].every((f) => argv.includes(f) && value(f))) throw new Error("--suite --subject --output are required");
  const suite = validateSuite(JSON.parse(readFileSync(value("--suite"), "utf8")));
  const annotated = annotateComplexity(suite, resolve(value("--subject")), dirname(resolve(value("--suite"))));
  writeFileSync(value("--output"), `${JSON.stringify(annotated, null, 2)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
