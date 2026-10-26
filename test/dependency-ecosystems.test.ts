import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractClaims } from "../src/drift/claims.js";
import { checkDependencies } from "../src/drift/checkers/dependency.js";
import { checkCrossFile } from "../src/drift/checkers/cross-file.js";
import { createConfig, runDriftCheck } from "../src/index.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-dependency-ecosystems-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { express: "4.18.0" } }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function claims(markdown: string, source = "stack.md") {
  const path = join(root, source);
  writeFileSync(path, markdown);
  return extractClaims(path, source);
}
function findings(markdown: string) {
  return checkDependencies(claims(markdown), root).map((issue) => [issue.code, issue.claim?.value]);
}

it.each(["requirements.txt", "setup.py"])("keeps npm missing-name and version checks active beside %s", (filename) => {
  writeFileSync(join(root, filename), "flask>=2\n");
  expect(findings([
    "# JavaScript Dependencies",
    "- **left-pad** — removed npm dependency",
    "- **Express 9.9.9** — wrong npm version",
    "# Python Dependencies",
    "- **flask 9.9.9** — unread Python declaration",
  ].join("\n"))).toEqual([
    ["DEPENDENCY_MISSING", "left-pad"],
    ["VERSION_MISMATCH", "Express 9.9.9"],
  ]);
});

it.each(["npm", "JavaScript", "TypeScript", "Node.js", "pnpm", "Yarn"])("recognizes an explicit %s dependency heading", (ecosystem) => {
  writeFileSync(join(root, "requirements.txt"), "");
  expect(findings(`# ${ecosystem} Dependencies\n- **left-pad** — missing`)).toEqual([
    ["DEPENDENCY_MISSING", "left-pad"],
  ]);
});

it("inherits an ecosystem through neutral subheadings and clears it at a sibling", () => {
  const extracted = claims([
    "# JavaScript", "## Key Libraries", "- **express 4.18.0**",
    "### Python Dependencies", "- **flask 2.0**",
    "## Dependencies", "- **left-pad**",
    "# Other Dependencies", "- **unclassified-package**",
  ].join("\n"));
  expect(extracted.map((claim) => [claim.value, claim.ecosystem])).toEqual([
    ["express", "npm"], ["express 4.18.0", "npm"],
    ["flask", "python"], ["flask 2.0", "python"],
    ["left-pad", "npm"], ["unclassified-package", undefined],
  ]);
});

it("inherits Python evidence for packages named in inline code", () => {
  const extracted = claims("# Python\n## Key Libraries\n- **`sentence_transformers`** — embeddings");
  expect(extracted).toHaveLength(1);
  expect(extracted[0]).toMatchObject({ kind: "dependency", ecosystem: "python" });
});

it("reads ecosystem evidence in formatted parent headings", () => {
  const extracted = claims("# **Python**\n## Key Libraries\n- **flask**");
  expect(extracted[0].ecosystem).toBe("python");
});

it("does not let quoted example headings replace the enclosing ecosystem", () => {
  const extracted = claims([
    "# Python Dependencies", "> # npm Dependencies",
    "> An example section, not the document's heading context.", "", "- **flask**",
  ].join("\n"));
  expect(extracted[0].ecosystem).toBe("python");
});

it("treats mixed ecosystem headings as ambiguous rather than inheriting a parent", () => {
  const extracted = claims([
    "# npm Dependencies", "## Python and JavaScript Dependencies", "### Key Libraries",
    "- **ambiguous-package**", "### Python Dependencies", "- **flask**",
  ].join("\n"));
  expect(extracted.map((claim) => claim.ecosystem)).toEqual([undefined, "python"]);
});

it("does not guess an ecosystem from a familiar package name or frontend label", () => {
  const extracted = claims("# Frontend Dependencies\n- **React**\n- **flask**");
  expect(extracted.every((claim) => claim.ecosystem === undefined)).toBe(true);
});

it("does not mistake graph-node dependencies for npm in a Python-only project", () => {
  rmSync(join(root, "package.json"));
  writeFileSync(join(root, "pyproject.toml"), '[project]\ndependencies = ["attrs==25.0.0"]\n');
  expect(findings("# Node Dependencies\n- **attrs 25.0.0** — graph-node attributes")).toEqual([]);
});

it("does not assign Cargo dependencies to npm under a mixed-language heading", () => {
  writeFileSync(join(root, "Cargo.toml"), '[dependencies]\nserde = "1.0.0"\n');
  writeFileSync(join(root, "requirements.txt"), "");
  expect(findings("# JavaScript and Rust Dependencies\n- **Express 4.18.0**\n- **serde 1.0.0**")).toEqual([]);
});

it.each(["Node Dependencies", "Graph Node Dependencies", "Rust Dependencies", "JavaScript and Rust Dependencies", "Python and Ruby Dependencies", "npm + Go Dependencies"])("clears enclosing ecosystem evidence for ambiguous heading %s", (heading) => {
  const extracted = claims(`# npm\n## ${heading}\n### Key Libraries\n- **ambiguous-package**`);
  expect(extracted[0].ecosystem).toBeUndefined();
});

it.each(["Node.js 22 Dependencies", "NodeJS Dependencies", "JavaScript / TypeScript Dependencies"])("keeps unambiguous npm heading %s checkable", (heading) => {
  writeFileSync(join(root, "requirements.txt"), "");
  expect(findings(`# ${heading}\n- **left-pad**`)).toEqual([["DEPENDENCY_MISSING", "left-pad"]]);
});

it("checks scoped npm names even without heading evidence", () => {
  writeFileSync(join(root, "requirements.txt"), "");
  expect(findings("# Dependencies\n- **`@scope/missing`**")).toEqual([
    ["DEPENDENCY_MISSING", "@scope/missing"],
  ]);
});

it("does not treat npm-compatible punctuation in a Python name as npm evidence", () => {
  writeFileSync(join(root, "requirements.txt"), "");
  expect(findings("# Dependencies\n- **sentence-transformers**\n- **Tree.Sitter**")).toEqual([]);
});

it("keeps unlabelled claims conservative when unread Python manifests are present", () => {
  writeFileSync(join(root, "requirements.txt"), "flask>=2\n");
  expect(findings("# Dependencies\n- **flask**\n- **left-pad**")).toEqual([]);
});

it("still reports unlabelled missing names when the understood corpus is complete", () => {
  expect(findings("# Dependencies\n- **left-pad**")).toEqual([["DEPENDENCY_MISSING", "left-pad"]]);
});

it("does not compare a Python version claim to a same-named npm package", () => {
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { requests: "1.0.0" } }));
  writeFileSync(join(root, "requirements.txt"), "requests==2.0.0\n");
  expect(findings("# Python Dependencies\n- **requests 2.0.0**")).toEqual([]);
});

it("matches same-named packages within the claimed ecosystem", () => {
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { requests: "1.0.0" } }));
  writeFileSync(join(root, "pyproject.toml"), '[project]\ndependencies = ["requests==2.0.0"]\n');
  expect(findings([
    "# npm Dependencies", "- **requests 1.0.0**", "# Python Dependencies", "- **requests 2.0.0**",
  ].join("\n"))).toEqual([]);
});

it("does not satisfy an npm claim with a Python declaration or Python name normalization", () => {
  writeFileSync(join(root, "pyproject.toml"), '[project]\ndependencies = ["httpx==1.0.0", "sentence-transformers>=3"]\n');
  writeFileSync(join(root, "requirements.txt"), "");
  expect(findings("# npm Dependencies\n- **httpx**\n- **sentence_transformers**")).toEqual([
    ["DEPENDENCY_MISSING", "httpx"], ["DEPENDENCY_MISSING", "sentence_transformers"],
  ]);
});

it("still normalizes and checks versions from understood Python manifests", () => {
  writeFileSync(join(root, "pyproject.toml"), '[project]\ndependencies = ["sentence-transformers>=3.0"]\n');
  writeFileSync(join(root, "requirements.txt"), "flask>=2\n");
  expect(findings("# Python Dependencies\n- **sentence_transformers 9.9.9**\n- **flask**")).toEqual([
    ["VERSION_MISMATCH", "sentence_transformers 9.9.9"],
  ]);
});

it("does not let a nested unread Python manifest disable an npm claim", () => {
  mkdirSync(join(root, "services/api"), { recursive: true });
  writeFileSync(join(root, "services/api/setup.py"), "raise RuntimeError('must not execute')\n");
  expect(findings("# npm Dependencies\n- **left-pad**")).toEqual([["DEPENDENCY_MISSING", "left-pad"]]);
});

it("preserves abstention for malformed understood manifests", () => {
  writeFileSync(join(root, "pyproject.toml"), "# no static dependencies\n");
  writeFileSync(join(root, "package.json"), "{");
  writeFileSync(join(root, "requirements.txt"), "flask>=2\n");
  expect(findings("# npm Dependencies\n- **left-pad**")).toEqual([]);
});

it("does not mutate manifests while checking claims", () => {
  const python = "raise RuntimeError('must not execute')\n";
  writeFileSync(join(root, "setup.py"), python);
  const npm = readFileSync(join(root, "package.json"), "utf-8");
  findings("# npm Dependencies\n- **left-pad**");
  expect(readFileSync(join(root, "setup.py"), "utf-8")).toBe(python);
  expect(readFileSync(join(root, "package.json"), "utf-8")).toBe(npm);
});

it("does not invent cross-file version conflicts between different ecosystems", () => {
  const npm = claims("# npm Dependencies\n- **requests 1.0.0**", "npm.md");
  const python = claims("# Python Dependencies\n- **requests 2.0.0**", "python.md");
  expect(checkCrossFile([...npm, ...python])).toEqual([]);
});

it("still detects cross-file version conflicts within one ecosystem", () => {
  const first = claims("# npm Dependencies\n- **requests 1.0.0**", "first.md");
  const second = claims("# JavaScript Dependencies\n- **requests 2.0.0**", "second.md");
  expect(checkCrossFile([...first, ...second]).map((issue) => issue.code)).toEqual(["CROSS_FILE_CONFLICT"]);
});

it("does not lose a version conflict when only one claim has ecosystem evidence", () => {
  const first = claims("# npm Dependencies\n- **requests 1.0.0**", "first.md");
  const second = claims("# Dependencies\n- **requests 2.0.0**", "second.md");
  expect(checkCrossFile([...first, ...second]).map((issue) => issue.code)).toEqual(["CROSS_FILE_CONFLICT"]);
});

it.each([
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
])("keeps an incompatible unlabelled version visible in visit order %s, %s, %s", (a, b, c) => {
  const versions = [
    ...claims("# npm Dependencies\n- **requests 1.0.0**", "npm.md"),
    ...claims("# Dependencies\n- **requests 3.0.0**", "legacy.md"),
    ...claims("# Python Dependencies\n- **requests 2.0.0**", "python.md"),
  ].filter((claim) => claim.kind === "version");
  const issues = checkCrossFile([versions[a], versions[b], versions[c]]);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ code: "CROSS_FILE_CONFLICT", file: "legacy.md" });
  expect(issues[0].message).toContain("requests 3.0.0");
});

it("does not invent a conflict when unlabelled versions can belong to different known ecosystems", () => {
  const versions = [
    ...claims("# npm Dependencies\n- **requests 1.0.0**", "npm.md"),
    ...claims("# Python Dependencies\n- **requests 2.0.0**", "python.md"),
    ...claims("# Dependencies\n- **requests 1.0.0**", "first-legacy.md"),
    ...claims("# Dependencies\n- **requests 2.0.0**", "second-legacy.md"),
  ];
  expect(checkCrossFile(versions)).toEqual([]);
});

it("matches unlabelled versions to candidates independently of package-name case", () => {
  const versions = [
    ...claims("# npm Dependencies\n- **requests 1.0.0**", "npm.md"),
    ...claims("# Python Dependencies\n- **requests 2.0.0**", "python.md"),
    ...claims("# Dependencies\n- **Requests 1.0.0**", "legacy.md"),
  ];
  expect(checkCrossFile(versions)).toEqual([]);
});

it("preserves a conflict within an identified ecosystem when unlabelled versions match a candidate", () => {
  const versions = [
    ...claims("# npm Dependencies\n- **requests 1.0.0**", "npm.md"),
    ...claims("# JavaScript Dependencies\n- **requests 3.0.0**", "other-npm.md"),
    ...claims("# Python Dependencies\n- **requests 2.0.0**", "python.md"),
    ...claims("# Dependencies\n- **requests 1.0.0**", "legacy.md"),
  ];
  expect(checkCrossFile(versions).map((issue) => issue.code)).toEqual(["CROSS_FILE_CONFLICT"]);
});

it("carries ecosystem evidence through the public drift-check entry point", async () => {
  const scaffoldRoot = join(root, ".mex");
  mkdirSync(join(scaffoldRoot, "context"), { recursive: true });
  writeFileSync(join(root, "requirements.txt"), "flask>=2\n");
  writeFileSync(join(scaffoldRoot, "context/stack.md"), [
    "# TypeScript", "## Key Libraries", "- **left-pad**", "- **Express 9.9.9**",
    "# Python", "## Key Libraries", "- **flask 9.9.9**",
  ].join("\n"));
  const report = await runDriftCheck(createConfig({ projectRoot: root, scaffoldRoot }), { graphWarning: () => {} });
  const issues = report.issues.filter((issue) => issue.code === "DEPENDENCY_MISSING" || issue.code === "VERSION_MISMATCH");
  expect(issues.map((issue) => [issue.code, issue.claim?.value, issue.claim?.ecosystem])).toEqual([
    ["DEPENDENCY_MISSING", "left-pad", "npm"],
    ["VERSION_MISMATCH", "Express 9.9.9", "npm"],
  ]);
});
