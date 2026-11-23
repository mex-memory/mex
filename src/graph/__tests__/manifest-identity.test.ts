import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  graphManifest,
  graphManifestDiffersOnlyByConfig,
  graphManifestHash,
  type GraphManifest,
} from "../engine-impl.js";

describe("graph manifest identity", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mex-manifest-identity-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("folds its own reported inputs into its reported hash", () => {
    const manifest = graphManifest(root);
    expect(graphManifestHash(manifest.inputs)).toBe(manifest.manifestHash);
    expect(manifest.inputs.configHash).toBe(manifest.configHash);
    expect(manifest.inputs.grammarHash).toBe(manifest.grammarHash);
  });

  it("moves the manifest hash when only config content changes", () => {
    const before = graphManifest(root);
    // A field that affects resolution; a version bump deliberately does not.
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
    const after = graphManifest(root);
    expect(after.configHash).not.toBe(before.configHash);
    expect(after.manifestHash).not.toBe(before.manifestHash);
    expect(graphManifestDiffersOnlyByConfig(after, before.manifestHash, before.configHash)).toBe(true);
  });

  const withInputs = (base: GraphManifest, patch: Partial<GraphManifest["inputs"]>): GraphManifest => {
    const inputs = { ...base.inputs, ...patch };
    return {
      manifestHash: graphManifestHash(inputs),
      configHash: inputs.configHash,
      grammarHash: inputs.grammarHash,
      inputs,
    };
  };

  it("refuses every engine-identity input as config drift", () => {
    const stored = graphManifest(root);
    const drifted = withInputs(stored, { configHash: `${stored.configHash}0` });
    // The config-only baseline this fixture varies from.
    expect(graphManifestDiffersOnlyByConfig(drifted, stored.manifestHash, stored.configHash)).toBe(true);

    for (const patch of [
      { db: stored.inputs.db + 1 },
      { extractor: "extractor-next" },
      { resolver: "resolver-next" },
      { corpusPolicyHash: "0".repeat(64) },
      { grammarHash: "0".repeat(64) },
    ]) {
      const current = withInputs(drifted, patch);
      expect(
        graphManifestDiffersOnlyByConfig(current, stored.manifestHash, stored.configHash),
        `${Object.keys(patch)[0]} must not read as config drift`,
      ).toBe(false);
    }
  });

  it("fails closed without a stored manifest or config hash", () => {
    const stored = graphManifest(root);
    const current = withInputs(stored, { configHash: `${stored.configHash}0` });
    expect(graphManifestDiffersOnlyByConfig(current, undefined, stored.configHash)).toBe(false);
    expect(graphManifestDiffersOnlyByConfig(current, stored.manifestHash, undefined)).toBe(false);
  });

  it("reports no drift when the stored manifest already matches", () => {
    const stored = graphManifest(root);
    expect(graphManifestDiffersOnlyByConfig(stored, stored.manifestHash, stored.configHash)).toBe(false);
  });
});
