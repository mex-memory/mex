import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REMOVED_COMMANDS } from "../src/removed-commands.js";

const cli = resolve("dist/cli.js");
const removed = Object.keys(REMOVED_COMMANDS);

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, MEX_TELEMETRY: "0" },
    timeout: 15_000,
  });
}

describe("removed command pointers", () => {
  for (const name of removed) {
    it.each([[], ["--help"], ["sync", "--json", "--unknown", "value"]].map((suffix) => ({ suffix })))(
      `${name} prints one pointer for $suffix`, ({ suffix }) => {
        const result = run([name, ...suffix]);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(`${REMOVED_COMMANDS[name]}\n`);
      },
    );
  }

  it.each(removed)("help %s prints its pointer", (name) => {
    const result = run(["help", name]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${REMOVED_COMMANDS[name]}\n`);
  });

  it.each([["--help"], ["setup", "--help"], ["graph", "--help"], ["wiki", "--help"], ["relay", "--help"]])(
    "omits removed names from %j", (...args) => {
      const result = run(args);
      expect(result.status).toBe(0);
      for (const name of removed) {
        expect(result.stdout).not.toMatch(new RegExp(`^\\s+${name}(?:\\s|\\[|<|$)`, "mu"));
      }
    },
  );
});
