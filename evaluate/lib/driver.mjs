// Agent driver contract for the end-to-end eval.
//
// A driver is `(task, tools) => { answer }`. It may call any tool on `tools`
// (scope/get/query/impact/read/grep); the harness records what each call costs.
// This keeps the rig model-agnostic: a real model is plugged in by supplying a
// module that default-exports `(variant) => driver`.
//
// The built-in `scriptedDriver` is a deterministic REFERENCE policy — a perfectly
// disciplined agent following the M4 guidance (scope first; for the minimal
// variant, expand ids via `graph get`; never fall back to grep). It validates the
// harness end to end and gives an idealized token-cost baseline. It is NOT a
// substitute for a real model run: it cannot reveal Read/Grep fallback behavior,
// which is exactly what a model driver measures.

import { parseJsonl } from "./run-cli.mjs";

function safeParse(stdout) {
  try { return parseJsonl(stdout); } catch { return []; }
}

export function scriptedDriver(variant) {
  return (task, tools) => {
    const scopeOut = tools.scope(task.query);
    const facts = safeParse(scopeOut).filter((r) => r.type === "fact");

    let sourceText = "";
    if (variant.detail === "source") {
      sourceText = scopeOut; // source is already grouped inline
    } else {
      const ids = facts.slice(0, 3).map((f) => f.id);
      if (ids.length > 0) sourceText = tools.get(ids);
    }

    const names = facts.map((f) => f.name).join(" ");
    return { answer: `${names}\n${sourceText}` };
  };
}

/** Load a driver factory from a module path, or fall back to the scripted one. */
export async function loadDriverFactory(path) {
  if (!path) return scriptedDriver;
  const mod = await import(path);
  const factory = mod.default ?? mod.driverFactory;
  if (typeof factory !== "function") throw new Error(`driver module ${path} must default-export (variant) => driver`);
  return factory;
}
