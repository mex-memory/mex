import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runChain } from "../index.mjs";
import { git } from "../lib/workspace.mjs";

export const cli = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));
const fixture = name => fileURLToPath(new URL("./" + name, import.meta.url));
const source = "export function first() { return 0; }\nexport function second() { return 0; }\n";

export function fixtureRoot(parent = process.env.MEX_ARM_TEST_TMP ?? tmpdir()) {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return realpathSync.native(mkdtempSync(join(parent, "arm-")));
}

export function fixtureOptions(root, agent, mode = "ok", sampleMs = 0, { token = false } = {}) {
  const subjectRoot = join(root, "subject");
  mkdirSync(subjectRoot, { recursive: true });
  git(subjectRoot, ["init", "-q"]);
  const commit = message => git(subjectRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture", "commit", "-qm", message]);
  writeFileSync(join(subjectRoot, "subject.mjs"), source);
  git(subjectRoot, ["add", "subject.mjs"]);
  commit("Create fixture");
  writeFileSync(join(subjectRoot, "README.md"), "Offline sample.\n");
  git(subjectRoot, ["add", "README.md"]);
  commit("Update fixture");
  copyFileSync(fixture("fixtures/hidden/check.mjs"), join(subjectRoot, "check.mjs"));
  git(subjectRoot, ["add", "check.mjs"]);
  commit("Add the hidden fixture check");
  const credentialFile = token ? undefined : join(root, agent === "claude" ? ".credentials.json" : "auth.json");
  const tokenFile = token ? join(root, "claude-token") : undefined;
  const bytes = token ? Buffer.from("sk-ant-oat01-fixture-" + "x".repeat(40)) : Buffer.from([0x00, 0x80, 0x0d, 0x0a, 0xff, 0x20]);
  writeFileSync(token ? tokenFile : credentialFile, token ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes, { mode: 0o600 });
  return {
    agent, cli, fixtures: true, sampleMs,
    suiteFile: fixture("fixtures/dry.json"), subjectRoot, output: join(root, "output"), credentialFile, tokenFile,
    credentialHash: createHash("sha256").update(bytes).digest("hex"),
    command: [process.execPath, fixture("fake-agent.mjs"), agent, mode],
    pin: {
      model: agent === "claude" ? "claude-sonnet-5-5" : "gpt-6.1-sol",
      effort: "medium", version: agent + " fixture 1",
      mexVersion: JSON.parse(packageFile).version,
      mexCommit: "2bb3b1598ae6432998990d01e10c009be0f2f860",
    },
  };
}

const packageFile = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");

export const built = existsSync(cli);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const agent of ["claude", "codex"]) {
    const root = fixtureRoot(process.argv[2] ? resolve(process.argv[2]) : undefined);
    const result = await runChain(fixtureOptions(root, agent, "sample", 1000));
    console.log(result.reportText.trimEnd());
    console.log("Exported " + result.replay.sessions.length + " native sessions.\n");
  }
}
