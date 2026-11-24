const CODEX_FEATURES_OFF = ["plugins", "apps", "browser_use", "multi_agent", "goals", "skill_search"];
/**
 * The Windows sandbox mode for a fresh home. Without one, every shell command is refused. The
 * elevated mode sets itself up per home through an elevation prompt, which an unattended session
 * cannot answer (error 1223), so a fresh home uses the unelevated restricted-token sandbox.
 * Other platforms need no setting.
 */
export function windowsSandbox(platform = process.platform) {
  return platform === "win32" ? "unelevated" : null;
}
export function codexConfig({ model, effort, windowsSandboxMode = null }) {
  const windows = windowsSandboxMode ? `\n[windows]\nsandbox = ${JSON.stringify(windowsSandboxMode)}\n` : "";
  return `model = ${JSON.stringify(model)}\nmodel_reasoning_effort = ${JSON.stringify(effort)}\nweb_search = "disabled"\ncli_auth_credentials_store = "file"\nsandbox_mode = "workspace-write"\napproval_policy = "never"\n\n[features]\nhooks = true\n${CODEX_FEATURES_OFF.map((f) => `${f} = false`).join("\n")}\n${windows}`;
}
