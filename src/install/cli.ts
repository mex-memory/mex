import { excludeChanges, installAgents, installationChanges, uninstallAgents, type InstallResult } from "./index.js";

function summary(result: InstallResult) {
  return { agents: result.agents, changes: result.changes.map(change => ({ path: change.path, kind: change.kind,
    action: change.before.data === null ? "create" : "update" })), notices: result.notices, legacyTracked: result.legacyTracked };
}

export async function runInstall(options: { dryRun?: boolean; json?: boolean } = {}): Promise<void> {
  const result = await installAgents(options);
  const view = summary(result);
  if (options.json) { console.log(JSON.stringify({ dryRun: !!options.dryRun, ...view })); return; }
  if (!result.agents.length) { console.log("No supported agent found. Install Claude Code, Codex, Copilot CLI or OpenCode, then run mex install."); return; }
  console.log(options.dryRun ? "MEX would change:" : "MEX installation:");
  for (const change of view.changes) console.log(`  ${change.action} ${change.path}`);
  if (!view.changes.length) console.log("  Agent hooks are up to date.");
  for (const notice of view.notices) console.log(notice);
}

export async function runUninstall(options: { dryRun?: boolean; json?: boolean; purge?: boolean } = {}): Promise<void> {
  const changes = installationChanges();
  const paths = [...new Set([...changes.map(change => change.path), ...excludeChanges()])];
  if (!options.json) {
    console.log(paths.length ? "MEX will restore (hooks first, shim last):" : "No recorded installation changes.");
    for (const path of paths) console.log(`  ${path}`);
    if (!options.purge) console.log("MEX data will be kept. Use --purge to delete it.");
  }
  if (options.dryRun) {
    if (options.json) console.log(JSON.stringify({ dryRun: true, paths, purge: !!options.purge }));
    return;
  }
  const result = await uninstallAgents(options);
  if (options.json) console.log(JSON.stringify({ paths, ...result }));
  else if (result.conflicts.length) {
    console.error("Some changed files need review. Their installation records and required runtime files were kept:");
    for (const path of result.conflicts) console.error(`  ${path}`);
  } else console.log(result.purged ? "MEX hooks, runtime and data removed." : "MEX hooks and runtime removed; data kept.");
  if (result.conflicts.length) process.exitCode = 1;
}
