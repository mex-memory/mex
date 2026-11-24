import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(packageRoot, "../../dist/hub");
const manifestPath = join(outputRoot, ".vite", "manifest.json");
const manifestText = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
const maxJavaScriptChunkBytes = 500_000;

if (/fixture-api|src\/dev\//i.test(manifestText)) {
  throw new Error("The production Hub manifest contains a development fixture module.");
}

if (!manifest["index.html"]?.isEntry) {
  throw new Error("The production Hub manifest has no application entry.");
}

if (Object.keys(manifest).some((source) => /(?:^|\/)src\/(?:app|pages)\//u.test(source))) {
  throw new Error("The production Hub manifest contains a legacy project Hub route.");
}

const forbiddenFixtureData = [
  "job_01K36WVM6H7JK8M9NPQRSTVVWX",
  "Three knowledge pages lost grounding",
  "scf_mex",
  "event_01K36WVM6H7JK8M9NPQRSTVVWX",
  "Keep activity immutable and preserve Project notes",
  "Project Hub read boundaries",
  "mx_01K36WVM6H7JK8M9NPQRSTVVWX",
  "member_01K36WVM6H7JK8M9NPQRSTVVWX",
  "Release benchmark local draft Requirement",
  "Release benchmark pending Spec update",
  "inbox_00000000000000000000000000000001",
  "proposal_01000000000000000000001720",
  "mx_01000000000000000000000001",
  "relay-draft-01",
  "relay_01000000000000000000000001",
  "Exact fixture evidence for Relay UI validation.",
];

for (const file of filesUnder(outputRoot)) {
  const bytes = readFileSync(file);
  if (file.endsWith(".js") && statSync(file).size > maxJavaScriptChunkBytes) {
    throw new Error(
      `The production Hub JavaScript chunk ${file} exceeds ${maxJavaScriptChunkBytes} bytes.`,
    );
  }
  for (const sentinel of ["react.development.js", "Download the React DevTools"]) {
    if (file.endsWith(".js") && bytes.includes(Buffer.from(sentinel))) {
      throw new Error(`The production Hub asset ${file} contains the React development runtime.`);
    }
  }
  for (const sentinel of forbiddenFixtureData) {
    if (bytes.includes(Buffer.from(sentinel))) {
      throw new Error(`The production Hub asset ${file} contains development fixture data.`);
    }
  }
}

function* filesUnder(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}
