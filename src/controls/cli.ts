import { openRecord } from "../record/index.js";
import { toolLevers } from "../ledger/accounting.js";
import { reenableLever } from "../ledger/view.js";
import { offDeadline, setCheckoutEnabled, setGlobalEnabled, setCaptureEnabled } from "./index.js";
import { rebuildNative } from "../knowledge/native.js";

export function runCheckoutSwitch(enabled: boolean, options: { for?: string; all?: boolean; lever?: string; json?: boolean }): void {
  const until = options.for === undefined ? null : offDeadline(options.for);
  if (enabled && until) throw new Error("Use --for with `mex off`.");
  if (options.all && until) throw new Error("Use --for for a repo; global off is undone with `mex on --all`.");
  const lever = toolLevers.find(name => name === options.lever);
  if (options.lever !== undefined && (!enabled || options.all || !lever)) {
    throw new Error("Use `mex on --lever` with outline, shell-trim or codex-wrapper.");
  }
  const writer = openRecord();
  try {
    if (lever) {
      reenableLever(writer, lever);
      if (options.json) console.log(JSON.stringify({ scope: "user", lever, state: "on" }));
      else console.log(`MEX will evaluate ${lever} over the next 10 new sessions that use it.`);
      return;
    }
    if (options.all) {
      setGlobalEnabled(writer, enabled);
      if (options.json) console.log(JSON.stringify({ scope: "global", state: enabled ? "on" : "off" }));
      else console.log(enabled ? "Global MEX off is cleared. Repo and session switches still apply." : "MEX is off everywhere. Shared rule files may still be loaded by your agent.");
      if (!options.json && enabled && process.env.MEX_OFF === "1") console.log("MEX_OFF=1 still turns MEX off in this terminal.");
      return;
    }
    const checkout = setCheckoutEnabled(writer, process.cwd(), enabled, until);
    // Off removes MEX's personal rule files here; on writes them back. Best effort.
    let personal = false;
    try {
      const result = rebuildNative({ projectPath: process.cwd() }, { force: true });
      personal = (result.removed?.length ?? 0) > 0 || (result.written?.length ?? 0) > 0;
    } catch { /* the next rebuild catches up */ }
    if (options.json) console.log(JSON.stringify({ scope: "checkout", state: checkout.state, offUntil: checkout.off_until }));
    else {
      console.log(enabled ? "MEX is on for this repo." : until ? `MEX is off for this repo until ${until}.` : "MEX is off for this repo.");
      if (!enabled) console.log(`${personal ? "Its rule files for you are removed. " : ""}Shared rule files in git may still be loaded by your agent.`);
      if (enabled && writer.setting("global", "enabled") === "false") console.log("MEX is still off everywhere. Run `mex on --all` to clear that switch.");
      if (enabled && process.env.MEX_OFF === "1") console.log("MEX_OFF=1 still turns MEX off in this terminal.");
    }
  } finally { writer.close(); }
}

export function runCaptureSwitch(value: string, options: { all?: boolean; json?: boolean }): void {
  if (value !== "on" && value !== "off") throw new Error("Use `mex capture off` or `mex capture on`.");
  const writer = openRecord();
  try {
    const scope = setCaptureEnabled(writer, value === "on", options.all ? undefined : process.cwd());
    if (options.json) console.log(JSON.stringify({ scope: scope === "global" ? "global" : "project", capture: value }));
    else {
      console.log(`Capture is ${value} ${options.all ? "everywhere" : "for this repo"}. Delivery has its own off switches.`);
      if (value === "on" && !options.all && writer.setting("global", "capture.enabled") === "false") console.log("Capture is still off everywhere. Run `mex capture on --all` to clear that switch.");
    }
  } finally { writer.close(); }
}
