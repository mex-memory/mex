import { isAbsolute, normalize } from "node:path";

export function relativePath(path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || normalize(path).split(/[\\/]/).includes("..")) throw new Error(`expected repository-relative path: ${path}`);
  return path;
}

export function validateSuite(suite) {
  if (!suite.id || !suite.arms?.files || !Array.isArray(suite.tasks) || !suite.tasks.length) throw new Error("suite needs id, files arm and tasks");
  const ids = new Set();
  if (suite.agent !== undefined && !["claude", "codex"].includes(suite.agent)) throw new Error("agent must be claude or codex");
  if (suite.sandbox !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(suite.sandbox)) throw new Error("unsupported sandbox");
  if (suite.effort !== undefined && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(suite.effort)) throw new Error("unsupported effort");
  if (suite.workerCount !== undefined && (!Number.isInteger(suite.workerCount) || suite.workerCount < 1 || suite.workerCount > 3)) throw new Error("workerCount must be 1..3");
  if (suite.subjectType && !["node", "compiler", "python", "pnpm"].includes(suite.subjectType)) throw new Error("unsupported subjectType");
  if (suite.workerConfig) relativePath(suite.workerConfig.file);
  for (const task of suite.tasks) {
    if (!task.id || ids.has(task.id) || !task.base || !["qa", "change"].includes(task.type) || typeof task.prompt !== "string") throw new Error(`invalid task: ${task.id}`);
    ids.add(task.id);
    if (task.gold?.knowledge && (!Array.isArray(task.gold.knowledge) || task.gold.knowledge.some((id) => typeof id !== "string"))) throw new Error("gold.knowledge must contain ids or paths");
    for (const item of task.gold?.code ?? []) relativePath(item.path);
    const hidden = task.hiddenTests;
    if (hidden) {
      for (const path of hidden.files ?? []) relativePath(path);
      if (hidden.cwd) relativePath(hidden.cwd);
      if (hidden.command && (!Array.isArray(hidden.command) || hidden.command.length < 1 || hidden.command.some((s) => typeof s !== "string"))) throw new Error("hidden command must be an argv array");
      if (hidden.runner === "pnpm" && (!hidden.cwd || !hidden.command)) throw new Error("package tests need cwd and command argv");
    }
    if (task.heavy && task.complexity?.promptNamesGold) throw new Error(`heavy task prompt names gold: ${task.id}`);
  }
  return suite;
}
