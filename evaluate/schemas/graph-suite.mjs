import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileHash, objectHash } from "../core/hash.mjs";

export const GRAPH_SUITE_SCHEMA_VERSION = 2;
const OPERATIONS = new Set(["scope", "query", "impact"]);
const RELATIONS = new Set(["where-defined", "who-calls", "what-calls"]);
const DETAIL_LEVELS = new Set(["minimal", "standard", "source"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function stringArray(value, label, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must contain at least ${min} non-empty string(s)`);
  }
  return value;
}

function commandArray(value, label) {
  return stringArray(value, label, 1);
}

function finiteMetricMap(value, label) {
  if (value === undefined) return;
  object(value, label);
  for (const [metric, threshold] of Object.entries(value)) {
    string(metric, `${label} metric`);
    if (!Number.isFinite(threshold)) throw new Error(`${label}.${metric} must be a finite number`);
  }
}

function validateEvidence(value, label) {
  object(value, label);
  string(value.symbol, `${label}.symbol`);
  if (value.kind !== undefined) string(value.kind, `${label}.kind`);
  string(value.path, `${label}.path`);
  if (isAbsolute(value.path)) throw new Error(`${label}.path must be repository-relative`);
  if (value.line !== undefined && (!Number.isInteger(value.line) || value.line < 1)) {
    throw new Error(`${label}.line must be a positive integer`);
  }
  if (value.startLine !== undefined && (!Number.isInteger(value.startLine) || value.startLine < 1)) {
    throw new Error(`${label}.startLine must be a positive integer`);
  }
  if (value.endLine !== undefined && (!Number.isInteger(value.endLine) || value.endLine < (value.startLine ?? value.line ?? 1))) {
    throw new Error(`${label}.endLine must not precede its source span`);
  }
  const allowed = new Set(["symbol", "kind", "path", "line", "startLine", "endLine"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  return value;
}

function validateFlows(value, label) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  value.forEach((flow, index) => {
    object(flow, `${label}[${index}]`);
    for (const endpoint of ["from", "to"]) {
      const selector = object(flow[endpoint], `${label}[${index}].${endpoint}`);
      string(selector.symbol, `${label}[${index}].${endpoint}.symbol`);
      string(selector.path, `${label}[${index}].${endpoint}.path`);
      if (isAbsolute(selector.path)) throw new Error(`${label}[${index}].${endpoint}.path must be repository-relative`);
    }
    if (flow.kinds !== undefined) stringArray(flow.kinds, `${label}[${index}].kinds`, 1);
  });
}

function evidenceArray(value, label, min = 0) {
  if (!Array.isArray(value) || value.length < min) throw new Error(`${label} must contain at least ${min} evidence item(s)`);
  const keys = new Set();
  value.forEach((entry, index) => {
    validateEvidence(entry, `${label}[${index}]`);
    const key = `${entry.symbol}\0${entry.path}\0${entry.startLine ?? entry.line ?? ""}\0${entry.endLine ?? entry.line ?? ""}`;
    if (keys.has(key)) throw new Error(`${label}[${index}] duplicates evidence ${entry.symbol} in ${entry.path}`);
    keys.add(key);
  });
  return value;
}

function validateOptions(value, label) {
  if (value === undefined) return;
  object(value, label);
  const allowed = new Set(["detail", "maxNodes", "maxFiles", "maxOutputTokens", "maxSourceLines", "depth", "fingerprint"]);
  for (const [key, option] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
    if (key === "detail" && !DETAIL_LEVELS.has(option)) throw new Error(`${label}.detail is invalid`);
    if (["maxNodes", "maxFiles", "maxOutputTokens", "maxSourceLines", "depth"].includes(key) && (!Number.isInteger(option) || option < 1)) {
      throw new Error(`${label}.${key} must be a positive integer`);
    }
    if (key === "fingerprint") boolean(option, `${label}.fingerprint`);
  }
}

function validateTask(task, label) {
  object(task, label);
  string(task.id, `${label}.id`);
  string(task.category, `${label}.category`);
  if (!OPERATIONS.has(task.operation)) throw new Error(`${label}.operation must be scope, query, or impact`);
  string(task.query, `${label}.query`);
  if (task.family !== undefined) string(task.family, `${label}.family`);
  if (task.critical !== undefined) boolean(task.critical, `${label}.critical`);
  if (task.operation === "query") {
    if (!RELATIONS.has(task.relation)) throw new Error(`${label}.relation is invalid`);
  } else if (task.relation !== undefined) {
    throw new Error(`${label}.relation is only valid for query operations`);
  }
  validateOptions(task.options, `${label}.options`);
  const expectation = task.expect === undefined ? {} : object(task.expect, `${label}.expect`);
  if (expectation.noResult !== undefined) boolean(expectation.noResult, `${label}.expect.noResult`);
  if (expectation.errorCodes !== undefined) stringArray(expectation.errorCodes, `${label}.expect.errorCodes`, 1);
  const noResult = expectation.noResult === true;
  evidenceArray(task.gold ?? [], `${label}.gold`, noResult ? 0 : 1);
  evidenceArray(task.acceptableAlternates ?? [], `${label}.acceptableAlternates`);
  evidenceArray(task.mustNotReturn ?? [], `${label}.mustNotReturn`);
  validateFlows(task.requiredFlows, `${label}.requiredFlows`);
  for (const [flowIndex, flow] of (task.requiredFlows ?? []).entries()) {
    for (const endpoint of ["from", "to"]) {
      if (!(task.gold ?? []).some((entry) => entry.symbol === flow[endpoint].symbol && entry.path === flow[endpoint].path)) {
        throw new Error(`${label}.requiredFlows[${flowIndex}].${endpoint} must identify task gold evidence`);
      }
    }
  }
  if (noResult && (task.gold?.length ?? 0) > 0) throw new Error(`${label} cannot combine expect.noResult with gold evidence`);
  if (task.operation === "scope" && expectation.errorCodes?.length) {
    throw new Error(`${label}.expect.errorCodes is not supported for scope tasks`);
  }
  return task;
}

function validateSystem(system, label) {
  object(system, label);
  if (system.label !== undefined) string(system.label, `${label}.label`);
  if (system.role !== undefined) string(system.role, `${label}.role`);
  if (system.command !== undefined) commandArray(system.command, `${label}.command`);
  if (system.buildFromGit !== undefined) {
    const build = object(system.buildFromGit, `${label}.buildFromGit`);
    string(build.root, `${label}.buildFromGit.root`);
    string(build.revision, `${label}.buildFromGit.revision`);
    string(build.cli, `${label}.buildFromGit.cli`);
    if (!Array.isArray(build.commands) || build.commands.length === 0) {
      throw new Error(`${label}.buildFromGit.commands must be non-empty`);
    }
    build.commands.forEach((command, index) => commandArray(command, `${label}.buildFromGit.commands[${index}]`));
    if (build.shareNodeModules !== undefined) boolean(build.shareNodeModules, `${label}.buildFromGit.shareNodeModules`);
  }
  if (!system.command && !system.buildFromGit) throw new Error(`${label} needs command or buildFromGit`);
  return system;
}

export function validateGraphSuite(raw, source = "graph suite") {
  object(raw, source);
  if (raw.schemaVersion !== GRAPH_SUITE_SCHEMA_VERSION) {
    throw new Error(`${source}.schemaVersion must be ${GRAPH_SUITE_SCHEMA_VERSION}`);
  }
  string(raw.id, `${source}.id`);
  if (raw.description !== undefined) string(raw.description, `${source}.description`);
  const subject = object(raw.subject, `${source}.subject`);
  string(subject.name, `${source}.subject.name`);
  if (subject.repository !== undefined) string(subject.repository, `${source}.subject.repository`);
  if (subject.revision !== undefined) string(subject.revision, `${source}.subject.revision`);
  if (subject.requireClean !== undefined) boolean(subject.requireClean, `${source}.subject.requireClean`);
  if (raw.determinismRebuilds !== undefined && (!Number.isInteger(raw.determinismRebuilds) || raw.determinismRebuilds < 1)) {
    throw new Error(`${source}.determinismRebuilds must be a positive integer`);
  }
  const systems = object(raw.systems, `${source}.systems`);
  if (Object.keys(systems).length === 0) throw new Error(`${source}.systems must be non-empty`);
  for (const [id, system] of Object.entries(systems)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`${source}.systems has invalid id ${id}`);
    validateSystem(system, `${source}.systems.${id}`);
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error(`${source}.tasks must be non-empty`);
  const taskIds = new Set();
  raw.tasks.forEach((task, index) => {
    validateTask(task, `${source}.tasks[${index}]`);
    if (taskIds.has(task.id)) throw new Error(`${source}.tasks[${index}].id is duplicated: ${task.id}`);
    taskIds.add(task.id);
  });
  if (raw.gates !== undefined) {
    const gates = object(raw.gates, `${source}.gates`);
    finiteMetricMap(gates.integrityFloors, `${source}.gates.integrityFloors`);
    finiteMetricMap(gates.integrityCeilings, `${source}.gates.integrityCeilings`);
  }
  return raw;
}

export function loadGraphSuite(path) {
  const absolute = resolve(path);
  const raw = JSON.parse(readFileSync(absolute, "utf8"));
  let taskPath = null;
  if (raw.tasksFile !== undefined) {
    string(raw.tasksFile, `${absolute}.tasksFile`);
    taskPath = resolve(dirname(absolute), raw.tasksFile);
    const taskDocument = JSON.parse(readFileSync(taskPath, "utf8"));
    raw.tasks = Array.isArray(taskDocument) ? taskDocument : taskDocument.tasks;
  }
  const suite = validateGraphSuite(raw, absolute);
  Object.defineProperty(suite, "__path", { value: absolute, enumerable: false });
  Object.defineProperty(suite, "__taskPath", { value: taskPath, enumerable: false });
  return suite;
}

export function graphSuiteHash(suite) {
  return objectHash({ suite: fileHash(suite.__path), tasks: suite.__taskPath ? fileHash(suite.__taskPath) : null });
}

export function suiteContext(suite, harnessRoot, subjectRoot, artifactRoot = null) {
  return {
    suiteDir: dirname(suite.__path ?? resolve(".")),
    harnessRoot: resolve(harnessRoot),
    subjectRoot: resolve(subjectRoot),
    artifactRoot: artifactRoot ? resolve(artifactRoot) : "",
  };
}

export function expandToken(token, context) {
  return token.replaceAll(/\{(suiteDir|harnessRoot|subjectRoot|artifactRoot)\}/g, (_, key) => context[key]);
}

export function resolveSystemCommands(suite, context, overrides = {}) {
  const commands = {};
  for (const [id, system] of Object.entries(suite.systems)) {
    const raw = overrides[id]
      ? [process.execPath, resolve(overrides[id])]
      : system.command?.map((token) => expandToken(token, context));
    if (!raw) throw new Error(`system ${id} has no resolved CLI; prepare its artifact or pass --system-cli ${id}=<file>`);
    const command = raw[0] === "node" ? [process.execPath, ...raw.slice(1)] : raw;
    const entrypoint = command[0] === process.execPath ? command[1] : command[0];
    if ((isAbsolute(entrypoint) || entrypoint.includes("/")) && !existsSync(entrypoint)) {
      throw new Error(`system ${id} entrypoint does not exist: ${entrypoint}`);
    }
    commands[id] = command;
  }
  return commands;
}

export function graphTaskArgs(task) {
  const args = task.operation === "scope"
    ? ["graph", "scope", task.query]
    : task.operation === "query"
      ? ["graph", "query", task.relation, task.query]
      : ["impact", task.query];
  const options = task.options ?? {};
  if (options.detail) args.push("--detail", options.detail);
  if (options.maxNodes) args.push("--max-nodes", String(options.maxNodes));
  if (options.maxFiles) args.push("--max-files", String(options.maxFiles));
  if (options.maxOutputTokens) args.push("--max-output-tokens", String(options.maxOutputTokens));
  if (options.maxSourceLines) args.push("--max-source-lines", String(options.maxSourceLines));
  if (options.depth) args.push("--depth", String(options.depth));
  if (options.fingerprint) args.push("--fingerprint");
  return args;
}

export function expectedGraphCommand(task) {
  return task.operation === "query" ? `graph query ${task.relation}` : task.operation === "scope" ? "graph scope" : "impact";
}
