import { it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord } from "../../record/index.js";
import { formatStatus, readStatus } from "../../status.js";
import { setOutputLevers, setGlobalEnabled } from "../index.js";
it("defaults off and persists output levers independently", () => {
 const home = mkdtempSync(join(tmpdir(), "mex-levers-"));
 const writer = openRecord({ home, isNetwork: () => false });
 try {
  expect(writer.setting("global", "levers.output")).toBeUndefined();
  expect(() => setOutputLevers(writer, "yes")).toThrow("on or off");
  for (const value of ["on", "off"]) {
   setOutputLevers(writer, value); setGlobalEnabled(writer, true);
   expect(writer.setting("global", "levers.output")).toBe(value);
   expect(JSON.parse(readFileSync(join(home, "controls.json"), "utf8")).levers).toBe(value);
  }
 } finally { writer.close(); }
});

it("shows the setting and environment override in status", () => {
 const home = mkdtempSync(join(tmpdir(), "mex-levers-status-"));
 const writer = openRecord({ home, isNetwork: () => false });
 try {
  const options = { home, cwd: home, isNetwork: () => false, env: {} };
  expect(formatStatus(readStatus(options))).toContain("Output levers off; turn on: mex config set levers.output on");
  setOutputLevers(writer, "on");
  expect(readStatus(options).outputLevers).toBe("on");
  expect(readStatus({ ...options, env: { MEX_LEVERS: "off" } }).outputLevers).toBe("off");
 } finally { writer.close(); }
});
