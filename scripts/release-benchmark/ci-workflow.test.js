import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function jobBlock(name, nextName) {
  const startMarker = `  ${name}:\n`;
  const start = workflow.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing CI job: ${name}`);
  if (nextName === undefined) return workflow.slice(start);
  const end = workflow.indexOf(`  ${nextName}:\n`, start + startMarker.length);
  if (end === -1) throw new Error(`Missing following CI job: ${nextName}`);
  return workflow.slice(start, end);
}

describe("release-performance CI topology", () => {
  it("allocates a fresh hosted job only for a requested confirmation", () => {
    const first = jobBlock(
      "release_performance_attempt_1",
      "release_performance_attempt_2",
    );
    const second = jobBlock("release_performance_attempt_2", "release-performance");

    expect(first).toContain("name: release-performance-attempt-1");
    expect(first).toContain("runs-on: ubuntu-24.04");
    expect(first).toContain("requires_confirmation:");
    expect(first).toContain("ci-orchestrator.mjs attempt");
    expect(first).toContain("ci-orchestrator.mjs retry-required");
    expect(first).not.toContain("npm run benchmark:release");

    expect(second).toContain("name: release-performance-attempt-2");
    expect(second).toContain("needs: release_performance_attempt_1");
    expect(second).toContain(
      "if: needs.release_performance_attempt_1.outputs.requires_confirmation == 'true'",
    );
    expect(second).toContain("runs-on: ubuntu-24.04");
    expect(second).toContain("ci-orchestrator.mjs attempt");
    expect(second).not.toContain("ci-orchestrator.mjs finalize");
    expect(second).not.toContain("npm run benchmark:release");
  });

  it("keeps one always-running final release-performance gate", () => {
    const final = jobBlock("release-performance");
    expect(workflow.match(/^  release-performance:$/gmu)).toHaveLength(1);
    expect(final).toContain(
      "needs: [release_performance_attempt_1, release_performance_attempt_2]",
    );
    expect(final).toContain("if: always()");
    expect(final).toContain("ci-orchestrator.mjs finalize");
    expect(final).toContain("--second-report");
    expect(final).toContain("--second-manifest");
    expect(final).toContain("name: release-performance-${{ github.run_attempt }}");
  });

  it("retains producer artifact identities across failed-only reruns", () => {
    const first = jobBlock(
      "release_performance_attempt_1",
      "release_performance_attempt_2",
    );
    const second = jobBlock("release_performance_attempt_2", "release-performance");
    const final = jobBlock("release-performance");

    expect(first).toContain(
      "artifact_name: ${{ steps.decision.outputs.artifact_name }}",
    );
    expect(first).toContain(
      "artifact_name=release-performance-attempt-1-$GITHUB_RUN_ATTEMPT",
    );
    expect(first).toContain("name: ${{ steps.decision.outputs.artifact_name }}");

    expect(second).toContain(
      "artifact_name: ${{ steps.evidence.outputs.artifact_name }}",
    );
    expect(second).toContain(
      "artifact_name=release-performance-attempt-2-$GITHUB_RUN_ATTEMPT",
    );
    expect(second).toContain("name: ${{ steps.evidence.outputs.artifact_name }}");

    expect(final).toContain(
      "name: ${{ needs.release_performance_attempt_1.outputs.artifact_name }}",
    );
    expect(final).toContain(
      "name: ${{ needs.release_performance_attempt_2.outputs.artifact_name }}",
    );
    expect(workflow).toContain("retention-days: 14");
  });

  it("retains the local benchmark command", () => {
    const packageJson = JSON.parse(readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    ));
    expect(packageJson.scripts["benchmark:release"]).toContain(
      "scripts/release-benchmark/enforce.mjs",
    );
  });
});
