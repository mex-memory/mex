import { pointer, record, strings, type Found, type Package, type Purpose, type RepoFiles, type ReviewItem } from "./source.js";

export type Manager = "npm" | "pnpm" | "yarn" | "bun";

/** Script names that mean each purpose, in the order they're preferred. */
export const SCRIPT_PURPOSES: ReadonlyArray<[Purpose, readonly string[]]> = [
  ["test", ["test"]],
  ["build", ["build"]],
  ["lint", ["lint"]],
  ["typecheck", ["typecheck", "type-check", "check-types", "tsc", "types"]],
  ["format", ["format", "fmt"]],
];

const LOCKFILES: ReadonlyArray<[string, Manager]> = [
  ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"], ["package-lock.json", "npm"],
];

export interface NodeScan {
  manager: Manager | null;
  packages: Package[];
  found: Found[];
  buildOrder: string[];
  review: ReviewItem[];
}

function managerOf(files: RepoFiles, manifest: Record<string, unknown> | undefined): { manager: Manager | null; lockfiles: string[] } {
  const lockfiles = LOCKFILES.filter(([file]) => files.isFile(file)).map(([file]) => file);
  const declared = typeof manifest?.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined;
  if (declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun") return { manager: declared, lockfiles };
  const first = LOCKFILES.find(([file]) => lockfiles.includes(file));
  return { manager: first ? first[1] : manifest ? "npm" : null, lockfiles };
}

/** The exact command to run one script, for the root or a workspace package. */
export function scriptCommand(manager: Manager, script: string, pkg: Package | undefined): string {
  if (!pkg || pkg.path === "") return `${manager} run ${script}`;
  switch (manager) {
    case "pnpm": return `pnpm --filter ${pkg.name} run ${script}`;
    case "yarn": return `yarn workspace ${pkg.name} run ${script}`;
    case "bun": return `bun run --filter ${pkg.name} ${script}`;
    default: return `npm run ${script} --workspace ${pkg.path}`;
  }
}

/** Whether a folder path matches a workspace glob (`**` any depth, `*` one segment). */
export function globMatcher(pattern: string): (path: string) => boolean {
  const clean = pattern.replace(/^\.\//u, "").replace(/\/+$/u, "");
  let source = "";
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i]!;
    if (clean.startsWith("**/", i)) { source += "(?:.*/)?"; i += 2; continue; }
    if (clean.startsWith("/**", i) && i + 3 === clean.length) { source += "(?:/.*)?"; i += 2; continue; }
    if (clean.startsWith("**", i)) { source += ".*"; i += 1; continue; }
    source += char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[.+^$()|[\]{}\\]/gu, "\\$&");
  }
  const regex = new RegExp(`^${source}$`, "u");
  return path => regex.test(path);
}

function workspaceGlobs(files: RepoFiles, manifest: Record<string, unknown>): string[] {
  const declared = Array.isArray(manifest.workspaces) ? strings(manifest.workspaces) : strings(record(manifest.workspaces)?.packages);
  const pnpm = record(files.yaml("pnpm-workspace.yaml"));
  return [...declared, ...strings(pnpm?.packages)];
}

/** Topological order of internal dependencies; only packages that take part. */
export function buildOrder(packages: Array<{ path: string; name: string; deps: string[] }>): string[] {
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
  const edges = new Map(packages.map(pkg => [pkg.path, pkg.deps.filter(dep => byName.has(dep) && dep !== pkg.name).map(dep => byName.get(dep)!.path)]));
  const involved = new Set<string>();
  for (const [path, deps] of edges) if (deps.length) { involved.add(path); for (const dep of deps) involved.add(dep); }
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (path: string) => {
    if (state.get(path) === "done" || state.get(path) === "visiting") return; // a cycle keeps the first order found
    state.set(path, "visiting");
    for (const dep of [...(edges.get(path) ?? [])].sort()) visit(dep);
    state.set(path, "done");
    order.push(path);
  };
  for (const path of [...involved].sort()) visit(path);
  return order;
}

export function readNode(files: RepoFiles): NodeScan {
  const root = files.json("package.json");
  const { manager, lockfiles } = managerOf(files, root);
  const review: ReviewItem[] = [];
  if (lockfiles.length > 1) {
    review.push({ kind: "two-lockfiles", paths: lockfiles, message: `Two package managers' lockfiles: ${lockfiles.join(" and ")}` });
  }
  if (!root || !manager) return { manager, packages: [], found: [], buildOrder: [], review };

  const manifests: Array<{ path: string; manifest: Record<string, unknown> }> = [{ path: "", manifest: root }];
  const globs = workspaceGlobs(files, root);
  // Negations filter what the other patterns found; they are never walked.
  const excluded = globs.filter(glob => glob.startsWith("!")).map(glob => globMatcher(glob.slice(1)));
  for (const glob of globs.filter(glob => !glob.startsWith("!"))) {
    for (const path of files.glob(glob)) {
      if (path === "" || manifests.some(item => item.path === path) || excluded.some(matches => matches(path))) continue;
      const manifest = files.json(`${path}/package.json`);
      if (manifest) manifests.push({ path, manifest });
    }
  }
  const kept = manifests;
  const packages: Package[] = kept.map(({ path, manifest }) => ({
    path, kind: "node", name: typeof manifest.name === "string" && manifest.name ? manifest.name : path || "(root)",
  }));

  const found: Found[] = [];
  for (const [index, { path, manifest }] of kept.entries()) {
    const scripts = record(manifest.scripts);
    if (!scripts) continue;
    const file = path ? `${path}/package.json` : "package.json";
    for (const [purpose, names] of SCRIPT_PURPOSES) {
      const script = names.find(name => typeof scripts[name] === "string" && (scripts[name] as string).trim() !== "");
      if (!script) continue;
      const command = scriptCommand(manager, script, packages[index]);
      const at = pointer("scripts", script);
      found.push({
        purpose, package: path, command, source: "config", local: "yes", origin: { file, pointer: at },
        match: `script:${path}:${script}`,
        checks: [
          { kind: "key", role: "complete", target: { file, pointer: at } },
          { kind: "command", role: "supporting", target: { run: command, file, pointer: at } },
        ],
      });
    }
  }

  const deps = (manifest: Record<string, unknown>) => ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .flatMap(field => Object.keys(record(manifest[field]) ?? {}));
  const order = buildOrder(kept.map(({ path, manifest }, index) => ({ path, name: packages[index]!.name, deps: deps(manifest) })));
  return { manager, packages, found, buildOrder: order, review };
}
