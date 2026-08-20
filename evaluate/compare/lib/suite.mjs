import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileHash, objectHash } from "../../core/hash.mjs";

const ARM_KINDS = new Set(["grep", "graph"]);
const ARM_ROLES = new Set(["control", "released", "patched"]);

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value, label, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`${label} must be an array of at least ${min} non-empty strings`);
  }
  return value;
}

function validateGold(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  value.forEach((entry, index) => {
    const item = `${label}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${item} must be an object`);
    requiredString(entry.symbol, `${item}.symbol`);
    if (entry.kind !== undefined) requiredString(entry.kind, `${item}.kind`);
    requiredString(entry.path, `${item}.path`);
    if (isAbsolute(entry.path)) throw new Error(`${item}.path must be repository-relative`);
    if (entry.line !== undefined && (!Number.isInteger(entry.line) || entry.line < 1)) throw new Error(`${item}.line must be positive`);
    if (entry.startLine !== undefined && (!Number.isInteger(entry.startLine) || entry.startLine < 1)) throw new Error(`${item}.startLine must be positive`);
    if (entry.endLine !== undefined && (!Number.isInteger(entry.endLine) || entry.endLine < (entry.startLine ?? entry.line ?? 1))) {
      throw new Error(`${item}.endLine must not precede its source span`);
    }
  });
}

function validateFlows(value, label) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  value.forEach((flow, index) => {
    if (!flow || typeof flow !== "object" || Array.isArray(flow)) throw new Error(`${label}[${index}] must be an object`);
    for (const endpoint of ["from", "to"]) {
      const item = flow[endpoint];
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label}[${index}].${endpoint} must be an object`);
      requiredString(item.symbol, `${label}[${index}].${endpoint}.symbol`);
      requiredString(item.path, `${label}[${index}].${endpoint}.path`);
      if (isAbsolute(item.path)) throw new Error(`${label}[${index}].${endpoint}.path must be repository-relative`);
    }
    if (flow.kinds !== undefined) stringArray(flow.kinds, `${label}[${index}].kinds`, { min: 1 });
  });
}

function validateReleaseGates(value, label) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([
    "maxDistinctScopeQueries", "firstResponseFileHitAt5", "firstResponseSourceSpanRecall", "allRequiredFilesInFirstScope",
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  if (value.maxDistinctScopeQueries !== undefined && value.maxDistinctScopeQueries !== 1) {
    throw new Error(`${label}.maxDistinctScopeQueries must be exactly 1`);
  }
  for (const key of ["firstResponseFileHitAt5", "firstResponseSourceSpanRecall"]) {
    if (value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1)) {
      throw new Error(`${label}.${key} must be between 0 and 1`);
    }
  }
  if (value.allRequiredFilesInFirstScope !== undefined && typeof value.allRequiredFilesInFirstScope !== "boolean") {
    throw new Error(`${label}.allRequiredFilesInFirstScope must be boolean`);
  }
}

export function validateSuite(raw, source = "suite") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source} must contain a JSON object`);
  if (![1, 2].includes(raw.schemaVersion)) throw new Error(`${source}.schemaVersion must be 1 or 2`);
  requiredString(raw.id, `${source}.id`);
  if (!raw.subject || typeof raw.subject !== "object") throw new Error(`${source}.subject is required`);
  requiredString(raw.subject.name, `${source}.subject.name`);
  if (raw.requiredRepetitions !== undefined && (!Number.isInteger(raw.requiredRepetitions) || raw.requiredRepetitions < 1)) {
    throw new Error(`${source}.requiredRepetitions must be a positive integer`);
  }
  validateReleaseGates(raw.releaseGates, `${source}.releaseGates`);
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error(`${source}.tasks must be a non-empty array`);

  const taskIds = new Set();
  for (const [index, task] of raw.tasks.entries()) {
    const label = `${source}.tasks[${index}]`;
    requiredString(task?.id, `${label}.id`);
    if (taskIds.has(task.id)) throw new Error(`${label}.id is duplicated: ${task.id}`);
    taskIds.add(task.id);
    requiredString(task.question, `${label}.question`);
    if (task.gold !== undefined) {
      validateGold(task.gold, `${label}.gold`);
      if (task.expectedSymbols === undefined) task.expectedSymbols = task.gold.map((entry) => entry.symbol);
    }
    validateFlows(task.requiredFlows, `${label}.requiredFlows`);
    for (const [flowIndex, flow] of (task.requiredFlows ?? []).entries()) {
      for (const endpoint of ["from", "to"]) {
        if (!(task.gold ?? []).some((entry) => entry.symbol === flow[endpoint].symbol && entry.path === flow[endpoint].path)) {
          throw new Error(`${label}.requiredFlows[${flowIndex}].${endpoint} must identify task gold evidence`);
        }
      }
    }
    stringArray(task.expectedSymbols, `${label}.expectedSymbols`, { min: 1 });
  }

  if (!raw.arms || typeof raw.arms !== "object" || Array.isArray(raw.arms)) throw new Error(`${source}.arms is required`);
  const armIds = Object.keys(raw.arms);
  if (armIds.length !== 3) throw new Error(`${source}.arms must define exactly three arms`);
  for (const id of armIds) {
    const arm = raw.arms[id];
    if (!ARM_KINDS.has(arm?.kind)) throw new Error(`${source}.arms.${id}.kind must be grep or graph`);
    requiredString(arm.role, `${source}.arms.${id}.role`);
    if (!ARM_ROLES.has(arm.role)) throw new Error(`${source}.arms.${id}.role must be control, released, or patched`);
    if (arm.kind === "graph") {
      if (arm.cli !== undefined) stringArray(arm.cli, `${source}.arms.${id}.cli`, { min: 1 });
      if (arm.vocabRetry !== undefined) throw new Error(`${source}.arms.${id}.vocabRetry is obsolete and must be removed`);
      if (arm.buildFromGit !== undefined) {
        const build = arm.buildFromGit;
        if (!build || typeof build !== "object") throw new Error(`${source}.arms.${id}.buildFromGit must be an object`);
        requiredString(build.root, `${source}.arms.${id}.buildFromGit.root`);
        requiredString(build.revision, `${source}.arms.${id}.buildFromGit.revision`);
        requiredString(build.cli, `${source}.arms.${id}.buildFromGit.cli`);
        if (!Array.isArray(build.commands) || build.commands.length === 0) throw new Error(`${source}.arms.${id}.buildFromGit.commands must be non-empty`);
        build.commands.forEach((command, index) => stringArray(command, `${source}.arms.${id}.buildFromGit.commands[${index}]`, { min: 1 }));
      }
    }
  }
  if (armIds.filter((id) => raw.arms[id].kind === "grep").length !== 1) {
    throw new Error(`${source}.arms must contain exactly one grep arm`);
  }
  for (const role of ARM_ROLES) {
    if (armIds.filter((id) => raw.arms[id].role === role).length !== 1) {
      throw new Error(`${source}.arms must contain exactly one ${role} role`);
    }
  }
  const control = raw.arms[armIds.find((id) => raw.arms[id].role === "control")];
  if (control.kind !== "grep") throw new Error(`${source}.arms control role must use kind grep`);
  for (const role of ["released", "patched"]) {
    const arm = raw.arms[armIds.find((id) => raw.arms[id].role === role)];
    if (arm.kind !== "graph") throw new Error(`${source}.arms ${role} role must use kind graph`);
  }
  return raw;
}

export function loadSuite(path) {
  const absolutePath = resolve(path);
  const suite = validateSuite(JSON.parse(readFileSync(absolutePath, "utf8")), absolutePath);
  Object.defineProperty(suite, "__path", { value: absolutePath, enumerable: false });
  return suite;
}

export function suiteHash(suite) {
  return suite.__path ? fileHash(suite.__path) : objectHash(suite);
}

export function expandToken(token, context) {
  return token.replaceAll(/\{(suiteDir|harnessRoot|subjectRoot|armRoot)\}/g, (_, key) => context[key]);
}

export function resolveSelectedArmIds(suite, requested = null) {
  const available = Object.keys(suite.arms);
  if (requested === null || requested === undefined) return available;
  if (!Array.isArray(requested)) throw new Error("--arms must be a comma-separated list of arm IDs");
  const normalized = requested.map((id) => typeof id === "string" ? id.trim() : "");
  if (![2, 3].includes(normalized.length) || normalized.some((id) => id === "")) {
    throw new Error("--arms must select exactly two or three non-empty arm IDs");
  }
  if (new Set(normalized).size !== normalized.length) throw new Error("--arms must not contain duplicate arm IDs");
  const unknown = normalized.filter((id) => !suite.arms[id]);
  if (unknown.length) throw new Error(`unknown arm ID(s): ${unknown.join(", ")}`);
  if (normalized.length === 2) {
    const roles = new Set(normalized.map((id) => suite.arms[id].role));
    if (!roles.has("control") || !roles.has("patched")) {
      throw new Error("a two-arm pilot must select the control and patched arms");
    }
  }
  const selected = new Set(normalized);
  return available.filter((id) => selected.has(id));
}

export function resolveArmCommands(suite, context, overrides = {}, armIds = null) {
  const commands = {};
  for (const id of resolveSelectedArmIds(suite, armIds)) {
    const arm = suite.arms[id];
    if (arm.kind === "grep") continue;
    const override = overrides[id];
    const raw = override ? [process.execPath, resolve(override)] : arm.cli;
    if (!raw) throw new Error(`No CLI configured for graph arm ${id}; pass --${id}-cli <file> or set arms.${id}.cli`);
    commands[id] = raw.map((token) => expandToken(token, context));
    const executable = commands[id][0];
    if ((isAbsolute(executable) || executable.includes("/")) && !existsSync(executable)) {
      throw new Error(`CLI executable for ${id} does not exist: ${executable}`);
    }
    if (commands[id][0] === process.execPath && !existsSync(commands[id][1])) {
      throw new Error(`CLI script for ${id} does not exist: ${commands[id][1]}`);
    }
  }
  return commands;
}

export function suiteContext(suite, harnessRoot, subjectRoot) {
  return {
    suiteDir: dirname(suite.__path ?? resolve(".")),
    harnessRoot: resolve(harnessRoot),
    subjectRoot: resolve(subjectRoot),
  };
}
