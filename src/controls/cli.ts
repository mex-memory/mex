import { openRecord } from "../record/index.js";
import { offDeadline, setCheckoutEnabled, setGlobalEnabled, setCaptureEnabled } from "./index.js";

export function runCheckoutSwitch(enabled: boolean, options: { for?: string; all?: boolean; json?: boolean }): void {
  const until = options.for === undefined ? null : offDeadline(options.for);
  if (enabled && until) throw new Error("Use --for with `mex off`.");
  if (options.all && until) throw new Error("Use --for for a repo; global off is undone with `mex on --all`.");
  const writer = openRecord();
  try {
    if (options.all) {
      setGlobalEnabled(writer, enabled);
      if (options.json) console.log(JSON.stringify({ scope: "global", state: enabled ? "on" : "off" }));
      else console.log(enabled ? "Global MEX off is cleared. Repo and session switches still apply." : "MEX is off everywhere. Shared rule files may still be loaded by your agent.");
      if (!options.json && enabled && process.env.MEX_OFF === "1") console.log("MEX_OFF=1 still turns MEX off in this terminal.");
      return;
    }
    const checkout = setCheckoutEnabled(writer, process.cwd(), enabled, until);
    if (options.json) console.log(JSON.stringify({ scope: "checkout", state: checkout.state, offUntil: checkout.off_until }));
    else {
      console.log(enabled ? "MEX is on for this repo." : until ? `MEX is off for this repo until ${until}.` : "MEX is off for this repo.");
      if (!enabled) console.log("Shared rule files may still be loaded by your agent.");
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
