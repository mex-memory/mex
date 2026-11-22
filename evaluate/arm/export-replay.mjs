import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;

export function exportReplay(runManifest, output) {
  const run = JSON.parse(readFileSync(runManifest, "utf8"));
  if (run.schemaVersion !== 1 || !Array.isArray(run.sessions) || !run.sessions.length) throw new Error("Invalid run manifest");
  const used = new Set();
  const sessions = run.sessions.map(({ agent, arm, task, subjectRepo, commit, file }) => {
    if (!["claude", "codex"].includes(agent) || !["baseline", "mex"].includes(arm) || !NAME.test(task)
        || typeof subjectRepo !== "string" || !subjectRepo.trim()
        || !/^(?:[\da-f]{40}|[\da-f]{64})$/.test(commit)) throw new Error("Invalid replay session");
    const name = [agent, arm, task].join("-") + ".jsonl";
    if (file !== "recordings/" + name || used.has(name)) throw new Error("Invalid or repeated recording path");
    const source = join(dirname(runManifest), "recordings", name);
    if (!lstatSync(source).isFile()) throw new Error("Native recording must be a regular file");
    used.add(name);
    return { source, row: { agent: agent === "claude" ? "claude-code" : agent,
      file: "sessions/" + name, repo: subjectRepo, commit, arm, task, entries: [] } };
  });
  mkdirSync(output, { mode: 0o700 });
  mkdirSync(join(output, "sessions"), { mode: 0o700 });
  const files = {};
  const subjects = new Map();
  for (const { source, row } of sessions) {
    const dest = join(output, row.file);
    copyFileSync(source, dest, constants.COPYFILE_EXCL);
    files[row.file] = createHash("sha256").update(readFileSync(dest)).digest("hex");
    subjects.set(JSON.stringify([row.repo, row.commit]), { repo: row.repo, commit: row.commit, files: {} });
  }
  const manifest = { version: 1, subjects: [...subjects.values()], sessions: sessions.map(({ row }) => row), files };
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [manifest, output] = process.argv.slice(2);
    if (!manifest || !output) throw new Error("Usage: node evaluate/arm/export-replay.mjs <run-manifest.json> <new-directory>");
    const result = exportReplay(resolve(manifest), resolve(output));
    console.log("Exported " + result.sessions.length + " native sessions.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
