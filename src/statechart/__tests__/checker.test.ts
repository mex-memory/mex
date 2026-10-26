import { it, expect } from "vitest";
import { checkArtifact } from "../checker.js";
import { exampleArtifact } from "../fixtures.js";
it("unavailable tooling yields an inspectable incomplete artifact", async () => { const a = await checkArtifact(exampleArtifact(), { env: {} }); expect(a.check.outcome).toBe("unavailable"); expect(a.check.modelStates).toBeNull(); expect(a.check.results.every(r => r.outcome === "unavailable")).toBe(true); });
it("a wrong checker checksum cannot produce a passed result", async () => { expect((await checkArtifact(exampleArtifact(), { env: { TLA2TOOLS: "/etc/hosts" } })).check.outcome).toBe("unavailable"); });
