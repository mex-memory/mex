import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { boundedHubDuration, HubTelemetry } from "../telemetry.js";
import { captureEvent } from "../../telemetry/index.js";

describe("Hub telemetry projection", () => {
  it("bounds page events with one counter and resumes in the next minute", () => {
    const sink = vi.fn();
    let now = 100_000;
    const telemetry = new HubTelemetry(sink, () => now);
    for (let i = 0; i < 100; i += 1) telemetry.pageViewed("knowledge");
    expect(sink).toHaveBeenCalledTimes(60);
    expect(sink.mock.calls.every(([name, attributes]) => name === "hub.page_viewed"
      && JSON.stringify(attributes) === '{"page":"knowledge"}')).toBe(true);
    now += 60_000;
    telemetry.pageViewed("relays");
    expect(sink).toHaveBeenCalledTimes(61);
  });

  it("records team-access steps as fixed categories under the shared browser-event cap", () => {
    const sink = vi.fn();
    const telemetry = new HubTelemetry(sink, () => 100_000);
    telemetry.teamAccess("card_viewed");
    telemetry.teamAccess("submitted");
    expect(sink.mock.calls).toEqual([
      ["hub.team_access", { step: "card_viewed" }],
      ["hub.team_access", { step: "submitted" }],
    ]);
    for (let i = 0; i < 100; i += 1) telemetry.pageViewed("home");
    telemetry.teamAccess("button_clicked");
    expect(sink).toHaveBeenCalledTimes(60);
  });

  it("records safe outcome metadata without changing results or propagating delivery errors", async () => {
    const sink = vi.fn(() => { throw new Error("delivery failed"); });
    let now = 500;
    const telemetry = new HubTelemetry(sink, () => now);
    const result = { privatePath: "/Users/private/project", idempotentReplay: true };
    await expect(telemetry.action("member.select", "apply", () => {
      now = 12;
      return result;
    }, value => value.idempotentReplay)).resolves.toBe(result);
    expect(sink).toHaveBeenLastCalledWith("hub.action_completed", {
      action: "member.select", stage: "apply", outcome: "success", duration_ms: 0, replayed: true,
    });
    const failure = new Error("private@example.test /Users/private/source.ts");
    await expect(telemetry.action("relay.publish", "apply", () => { throw failure; })).rejects.toBe(failure);
    expect(sink).toHaveBeenLastCalledWith("hub.action_completed", {
      action: "relay.publish", stage: "apply", outcome: "failure", duration_ms: 0,
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain("private");
  });

  it("has no delivery or clock side effects when embedded without a sink", async () => {
    const now = vi.fn();
    const telemetry = new HubTelemetry(undefined, now);
    telemetry.pageViewed("home");
    await expect(telemetry.action("job.start", "direct", () => 42)).resolves.toBe(42);
    expect(now).not.toHaveBeenCalled();
  });

  it("keeps the production sink non-persisting for an opted-out Hub", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mex-hub-telemetry-optout-"));
    vi.stubEnv("MEX_HOME", directory);
    vi.stubEnv("MEX_TELEMETRY", "0");
    try {
      const telemetry = new HubTelemetry(captureEvent);
      telemetry.pageViewed("home");
      await expect(telemetry.action("settings.logging.update", "direct", () => "done")).resolves.toBe("done");
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("clamps durations to finite nonnegative whole milliseconds", () => {
    expect([NaN, Infinity, -Infinity, -100, 12.7, 1e15].map(boundedHubDuration))
      .toEqual([0, 0, 0, 0, 13, 86_400_000]);
  });
});
