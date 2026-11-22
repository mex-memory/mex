#!/usr/bin/env node
// Usage from the repository root, with Cargo on PATH:
// node scripts/graph-engine-bench/scanner-parity.mjs <directory>
// Compare complete files against TypeScript and exit with status 1 on a mismatch.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ENGINE = fileURLToPath(new URL("../../native/engine/", import.meta.url));
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const BATCH_SIZE = 32;

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      yield* sourceFiles(path);
    } else if (entry.isFile() && EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      yield path;
    }
  }
}

function buildExample() {
  const output = execFileSync("cargo", [
    "build", "--locked", "--release", "-p", "mex-graph-ecmascript", "--example", "scan",
    "--message-format=json-render-diagnostics",
  ], { cwd: ENGINE, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  for (const line of output.trim().split("\n")) {
    const artifact = JSON.parse(line);
    if (artifact.reason === "compiler-artifact" && artifact.target.name === "scan" && artifact.executable) {
      return artifact.executable;
    }
  }
  throw new Error("Cargo did not report the scan example executable");
}

function compilerTokens(text, path) {
  const jsx = path.endsWith(".tsx") || path.endsWith(".jsx");
  const variant = jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, variant, text);
  const tokens = [];
  try {
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      tokens.push(ts.SyntaxKind[kind] ?? `SyntaxKind:${kind}`);
    }
    return { tokens };
  } catch (error) {
    // Retain the successful prefix when TypeScript throws while scanning a file.
    return { tokens, typescriptError: String(error) };
  }
}

function compareFile(summary, root, file, rust) {
  const { tokens: typescript, typescriptError } = compilerTokens(readFileSync(join(root, file), "utf8"), file);
  summary.tokens += typescript.length;
  const sharedLength = Math.min(typescript.length, rust.length);
  let index = 0;
  while (index < sharedLength && typescript[index] === rust[index]) index++;
  if (index === typescript.length && index === rust.length && typescriptError === undefined) return;

  const contextStart = Math.max(0, index - 4);
  summary.mismatchingFiles.push({
    file, index, contextStart,
    typescript: typescript.slice(contextStart, index + 5),
    rust: rust.slice(contextStart, index + 5),
    typescriptError,
  });
}

async function compareOutput(lines, root, batch, summary) {
  let count = 0;
  for await (const line of lines) {
    const file = batch[count++];
    if (file === undefined) throw new Error("Scan example returned too many token lists");
    compareFile(summary, root, file, JSON.parse(line));
  }
  return count;
}

async function compareBatch(binary, root, batch, summary) {
  const child = spawn(binary, batch, { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    const [[code, signal], count] = await Promise.all([
      once(child, "close"),
      compareOutput(lines, root, batch, summary),
    ]);
    if (code !== 0 || count !== batch.length) {
      throw new Error(`Scan example exited with ${signal ?? code} after ${count}/${batch.length} files`);
    }
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

if (process.argv.length !== 3) {
  console.error("Usage: node scripts/graph-engine-bench/scanner-parity.mjs <directory>");
  process.exit(2);
}
if (ts.version !== "5.9.3") throw new Error(`Expected TypeScript 5.9.3, got ${ts.version}`);

const root = resolve(process.argv[2]);
const files = [...sourceFiles(root)].map((file) => relative(root, file)).sort();
const summary = { files: files.length, tokens: 0, mismatchingFiles: [] };
const binary = buildExample();
for (let i = 0; i < files.length; i += BATCH_SIZE) {
  await compareBatch(binary, root, files.slice(i, i + BATCH_SIZE), summary);
}
console.log(JSON.stringify(summary, null, 2));
if (summary.mismatchingFiles.length > 0) process.exitCode = 1;
