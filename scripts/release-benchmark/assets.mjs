import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { RELEASE_ROUTE_MANIFEST_HINTS } from "./routes.mjs";
import { assetBudgetCandidate } from "./statistics.mjs";

const FORBIDDEN_PRODUCTION_HINTS = [
  "src/app/",
  "src/pages/",
  "src/dev/",
  "fixture-api",
  "setuppage",
  "hub-contracts/dist/setup",
  "mermaid",
  "statechart",
];

export function measureBuiltAssets(outputRoot, budgets) {
  const root = resolve(outputRoot);
  const manifestPath = join(root, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Production Hub manifest is missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assertManifest(manifest);
  const entries = Object.entries(manifest).filter(([, record]) => record.isEntry === true);
  if (entries.length !== 1 || entries[0][0] !== "index.html") {
    throw new Error("The production Hub manifest must have one application entry at index.html.");
  }
  assertNoForbiddenWorkbench(manifest, Object.keys(manifest), "The production Hub manifest", FORBIDDEN_PRODUCTION_HINTS);
  const builtFiles = filesUnder(root);
  const inventory = new Set(builtFiles.map((path) => relativeAsset(root, path)));
  const initialKeys = manifestClosure(manifest, ["index.html"]);
  const initialFiles = filesForKeys(manifest, initialKeys);
  // Fonts are imported by the global entry CSS. Vite does not consistently
  // attach CSS URL assets to a manifest record, so account every built font as
  // initial instead of allowing it to disappear from a budget.
  for (const path of builtFiles) {
    if (isFont(path)) initialFiles.add(relativeAsset(root, path));
  }
  const initial = summarizeFiles(root, initialFiles, inventory);

  const routes = {};
  const measuredKeys = new Set(initialKeys);
  for (const [route, hints] of Object.entries(RELEASE_ROUTE_MANIFEST_HINTS)) {
    const closure = manifestClosure(manifest, findDynamicKeys(manifest, hints), true, initialKeys);
    for (const key of closure) measuredKeys.add(key);
    const files = filesForKeys(manifest, closure);
    for (const file of initialFiles) files.delete(file);
    routes[route] = summarizeFiles(root, files, inventory);
  }
  for (const [key, entry] of Object.entries(manifest)) {
    if (entry.isDynamicEntry && !measuredKeys.has(key)) {
      throw new Error(`The production Hub has an unmeasured dynamic chunk: ${key}`);
    }
  }

  const measuredFiles = filesForKeys(manifest, measuredKeys);
  for (const file of initialFiles) measuredFiles.add(file);
  for (const file of inventory) {
    if ([".js", ".css"].includes(extname(file)) && !measuredFiles.has(file)) {
      throw new Error(`The production Hub has an unmeasured asset: ${file}`);
    }
  }
  const chunks = builtFiles
    .filter((path) => extname(path) === ".js")
    .map((path) => ({ file: relativeAsset(root, path), bytes: statSync(path).size }))
    .sort((left, right) => right.bytes - left.bytes || left.file.localeCompare(right.file));
  const largestJsChunk = chunks[0] ?? { file: null, bytes: 0 };
  const result = { initial, routes, largestJsChunk };
  return {
    ...result,
    budgetCandidates: candidateAssetBudgets(result),
    violations: evaluateAssetBudgets(result, budgets),
  };
}

function assertNoForbiddenWorkbench(manifest, keys, label, hints) {
  for (const hint of hints) {
    if ([...keys].some((key) => {
      const record = manifest[key] ?? {};
      return [key, record.src, record.name, record.file]
        .some((value) => normalized(value ?? "").includes(normalized(hint)));
    })) {
      throw new Error(`${label} still includes ${hint}.`);
    }
  }
}

export function evaluateAssetBudgets(measurement, budgets) {
  const violations = [];
  compare(violations, "assets.maxJsChunkBytes", measurement.largestJsChunk.bytes, budgets.maxJsChunkBytes);
  compareSizeGroup(violations, "assets.initial", measurement.initial, budgets.initial);
  for (const [route, measured] of Object.entries(measurement.routes)) {
    const limit = budgets.routes[route];
    if (!limit) {
      violations.push({ metric: `assets.routes.${route}`, measured: null, budget: null, reason: "missing_budget" });
      continue;
    }
    compareSizeGroup(violations, `assets.routes.${route}`, measured, limit);
  }
  return violations.slice(0, 100);
}

function candidateAssetBudgets(measurement) {
  return {
    maxJsChunkBytes: assetBudgetCandidate(measurement.largestJsChunk.bytes),
    initial: candidateSizeGroup(measurement.initial),
    routes: Object.fromEntries(Object.entries(measurement.routes).map(([route, value]) => [
      route,
      candidateSizeGroup(value),
    ])),
  };
}

function candidateSizeGroup(value) {
  return {
    jsBytes: assetBudgetCandidate(value.jsBytes),
    cssBytes: assetBudgetCandidate(value.cssBytes),
    fontBytes: assetBudgetCandidate(value.fontBytes),
  };
}

function compareSizeGroup(violations, prefix, measured, budget) {
  for (const field of ["jsBytes", "cssBytes", "fontBytes"]) {
    compare(violations, `${prefix}.${field}`, measured[field], budget[field]);
  }
}

function compare(violations, metric, measured, budget) {
  if (!Number.isFinite(budget) || measured > budget) {
    violations.push({ metric, measured, budget, reason: "budget_exceeded" });
  }
}

function manifestClosure(manifest, roots, followDynamic = false, alreadyLoaded) {
  const seen = new Set();
  const visit = (key) => {
    // Lazy pages can import helpers from the entry chunk. That back edge
    // shouldn't charge other pages' dynamic imports to the current route.
    if (seen.has(key) || alreadyLoaded?.has(key)) return;
    const record = manifest[key];
    if (!record) throw new Error(`Manifest import ${key} does not resolve.`);
    seen.add(key);
    for (const imported of record.imports ?? []) visit(imported);
    for (const imported of record.dynamicImports ?? []) {
      if (!Object.hasOwn(manifest, imported)) throw new Error(`Manifest import ${imported} does not resolve.`);
      if (followDynamic) visit(imported);
    }
  };
  for (const key of roots) visit(key);
  return seen;
}

function filesForKeys(manifest, keys) {
  const files = new Set();
  for (const key of keys) {
    const record = manifest[key];
    if (typeof record.file === "string") files.add(record.file);
    for (const file of record.css ?? []) files.add(file);
    for (const file of record.assets ?? []) files.add(file);
  }
  return files;
}

function findDynamicKeys(manifest, hints) {
  return Object.entries(manifest)
    .filter(([, record]) => record?.isDynamicEntry === true)
    .filter(([key, record]) => hints.some((hint) => (
      normalized(key).includes(normalized(hint))
      || normalized(record.src ?? "").includes(normalized(hint))
      || normalized(record.name ?? "").includes(normalized(hint))
    )))
    .map(([key]) => key)
    .sort();
}

function summarizeFiles(root, relativeFiles, inventory) {
  let jsBytes = 0;
  let cssBytes = 0;
  let fontBytes = 0;
  const files = [];
  for (const relative of [...relativeFiles].sort()) {
    if (!inventory.has(relative)) {
      throw new Error(`Manifest asset is missing from the production build: ${relative}`);
    }
    const bytes = statSync(join(root, relative)).size;
    if (extname(relative) === ".js") jsBytes += bytes;
    else if (extname(relative) === ".css") cssBytes += bytes;
    else if (isFont(relative)) fontBytes += bytes;
    files.push({ file: relative, bytes });
  }
  return { jsBytes, cssBytes, fontBytes, files };
}

function filesUnder(root) {
  const out = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  visit(root);
  return out.sort();
}

function isFont(path) {
  return [".woff2", ".woff", ".ttf", ".otf", ".eot"].includes(extname(path).toLowerCase());
}

function relativeAsset(root, path) {
  return path.slice(root.length + 1).replaceAll("\\", "/");
}

function normalized(value) {
  return String(value).replaceAll("\\", "/").toLowerCase();
}

function assertManifest(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The production Hub manifest must be a JSON object.");
  }
}
