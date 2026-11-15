// Public synthetic converter/controller golden; never reads private corpora.
import { beforeAll, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { convert, remap, transcript } from "./convert.mjs";
let binary, work;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "mex-delivery-replay-"));
  binary = join(work, process.platform === "win32" ? "hook.exe" : "hook");
  const build = spawnSync("go", ["build", "-buildvcs=false", "-o", binary, "./cmd/mex-hook"], {
    cwd: resolve("native"),
    windowsHide: true,
    encoding: "utf8",
    timeout: 120000
  });
  if (build.status) {
    throw Error(build.stderr || build.error?.message);
  }
}, 120000);
it("converts and replays the same synthetic session byte for byte for every scorer", async () => {
  const records = await transcript(resolve("scripts/delivery-replay/fixture.jsonl")),
    result = {};
  for (const scorer of ["tiers", "bm25", "fcfs", "risk"]) {
    const runs = [];
    for (let run = 0; run < 2; run++) {
      const root = join(work, scorer + "-" + run),
        mex = join(root, "home", ".mex"),
        checkout = join(root, "repo");
      mkdirSync(join(checkout, ".mex", "learned"), {
        recursive: true
      });
      mkdirSync(mex, {
        recursive: true
      });
      writeFileSync(join(checkout, ".mex", "learned", "mx_poolaa.md"), "---\nmex:\n  id: mx_poolaa\n  kind: pitfall\n  scope: [\"src/**\"]\n  source: {type: docs, ref: CONTRIBUTING.md}\n  evidence: docs\n  one_line: Keep the shared pool open.\n  checks: []\n  status: active\n  created: 2026-11-03\n---\nKeep the shared pool open because later requests reuse it.\n");
      const events = convert(records, {
        session: "fixture",
        project: "project",
        checkout,
        oldRoot: "/repo"
      });
      const r = spawnSync(binary, ["--delivery-replay"], {
        input: events.map(e => JSON.stringify(e)).join("\n") + "\n",
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          MEX_HOME: join(root, "home"),
          MEX_DELIVERY_SCORER: scorer
        },
        timeout: 30000
      });
      if (r.status) {
        throw Error(r.stderr || r.error?.message);
      }
      const replies = r.stdout.trim().split("\n").map(s => JSON.parse(s));
      expect(replies.filter(r => r.failed), `${scorer} run ${run}: failed replay events`).toEqual([]);
      runs.push(replies.map(r => r.reply.context?.replace(/\[mex [a-f0-9]+\]/g, "[mex block]") ?? ""));
    }
    expect(JSON.stringify(runs[0])).toBe(JSON.stringify(runs[1]));
    result[scorer] = runs[0];
  }
  const file = resolve("scripts/delivery-replay/golden.json");
  if (process.env.MEX_UPDATE_REPLAY_GOLDEN === "1") {
    writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  }
  expect(JSON.stringify(result, null, 2) + "\n").toBe(readFileSync(file, "utf8"));
});
it("never remaps a path outside the historical checkout into the fixture", () => {
  expect(remap("/repo/../private/data", "/repo", "/fixture")).toBe("/outside-checkout");
  expect(remap("/other/file", "/repo", "/fixture")).toBe("/outside-checkout");
});
