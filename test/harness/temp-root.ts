import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** Children and CLI subprocesses inherit one run-local discovery boundary. */
export default function setup(): () => void {
  const keys = ["TMPDIR", "TMP", "TEMP", "GIT_CEILING_DIRECTORIES", "MEX_HOME"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(join(tmpdir(), "mex-vitest-"));
  for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = root;
  // Accounting in real fake-agent launches must never open the user's record.
  process.env.MEX_HOME = join(root, "user-home");
  process.env.GIT_CEILING_DIRECTORIES = [root, previous.GIT_CEILING_DIRECTORIES].filter(Boolean).join(delimiter);
  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    // Individual fixtures own their cleanup. Never recursively sweep a root
    // that may contain package-install junctions left by a failed test.
  };
}
