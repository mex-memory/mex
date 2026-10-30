import { it, expect } from "vitest";
import { checkArtifact, javaBinary } from "../checker.js";
import { exampleArtifact } from "../fixtures.js";
it("unavailable tooling yields an inspectable incomplete artifact", async () => { const a = await checkArtifact(exampleArtifact(), { env: {} }); expect(a.check.outcome).toBe("unavailable"); expect(a.check.modelStates).toBeNull(); expect(a.check.results.every(r => r.outcome === "unavailable")).toBe(true); });
it("a wrong checker checksum cannot produce a passed result", async () => { expect((await checkArtifact(exampleArtifact(), { env: { TLA2TOOLS: "/etc/hosts" } })).check.outcome).toBe("unavailable"); });
it("resolves a JAVA directory to its executable", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "mex-java-home-")), exe = process.platform === "win32" ? "java.exe" : "java";
  try { mkdirSync(join(home, "bin")); writeFileSync(join(home, "bin", exe), ""); expect(javaBinary(home)).toBe(join(home, "bin", exe)); expect(javaBinary(join(home, "bin"))).toBe(join(home, "bin", exe)); expect(javaBinary(undefined)).toBe("java"); expect(javaBinary("java")).toBe("java"); }
  finally { rmSync(home, { recursive: true, force: true }); }
});
