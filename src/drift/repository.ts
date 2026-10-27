import { execFileSync } from "node:child_process";
import { lstatSync, opendirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import YAML from "yaml";

export interface WorkspaceManifest {
  path: string;
  name?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  targets: Record<string, unknown>;
}

/** One bounded inventory per check, shared by reference checkers. Null means incomplete. */
export class RepositoryInventory {
  readonly files: string[] | null;
  readonly manifests: WorkspaceManifest[] | null;
  constructor(readonly root: string) {
    this.files = this.listFiles();
    this.manifests = this.loadManifests();
  }

  scaffoldFiles(scaffoldRoot: string): string[] {
    if (resolve(scaffoldRoot) === resolve(this.root)) return [];
    return (this.walkFiles(scaffoldRoot) ?? []).map((file) => relative(this.root, resolve(scaffoldRoot, file)).split(sep).join("/"));
  }

  private listFiles(): string[] | null {
    try {
      const output = execFileSync("git", ["ls-files", "-z", "--cached"], {
        cwd: this.root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
      });
      const files = [...new Set(output.split("\0").filter(Boolean))];
      // Empty new Git repositories still need the ordinary filesystem fallback.
      if (files.length) return files.length > 100_000 ? null : files.filter((file) => !file.split("/").some((part) => part === "node_modules" || part === ".git")).sort();
    } catch { /* No Git: use the bounded walk below. */ }
    return this.walkFiles(this.root);
  }

  private walkFiles(root: string): string[] | null {
    const pending = [root];
    const files: string[] = [];
    let inspected = 0;
    try {
      while (pending.length) {
        const directory = opendirSync(pending.pop()!);
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            if (++inspected > 100_000) return null;
            if (entry.name === "node_modules" || entry.name === ".git"
              || (entry.name === "local" && directory.path.endsWith(".mex")) || entry.isSymbolicLink()) continue;
            const path = resolve(directory.path, entry.name);
            if (entry.isDirectory()) pending.push(path);
            else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
          }
        } finally { directory.closeSync(); }
      }
      return files.sort();
    } catch { return null; }
  }

  /** Do not read tracked symlinks, junctions, or paths outside the repository. */
  safeFile(file: string): boolean {
    if (isAbsolute(file)) return false;
    const parts = file.replace(/\\/g, "/").split("/");
    if (parts.some((part) => part === "node_modules" || part === ".git" || part === "..")) return false;
    let path = this.root;
    try {
      for (const part of parts) {
        path = resolve(path, part);
        if (lstatSync(path).isSymbolicLink()) return false;
      }
      return lstatSync(path).isFile();
    } catch { return false; } // Deleted tracked files must not satisfy references.
  }

  private loadManifests(): WorkspaceManifest[] | null {
    if (!this.files) return null;
    let paths = this.files.filter((file) => /(^|\/)package\.json$/.test(file));
    if (!paths.includes("package.json") && this.safeFile("package.json")) paths.unshift("package.json");
    let patterns: string[] = [];
    try {
      const pkg = JSON.parse(this.readBounded("package.json") ?? "{}");
      patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
    } catch { /* Independent applications can have no root manifest. */ }
    if (!patterns.length && this.safeFile("pnpm-workspace.yaml")) {
      try { patterns = YAML.parse(this.readBounded("pnpm-workspace.yaml") ?? "")?.packages ?? []; }
      catch { return null; }
    }
    if (!Array.isArray(patterns) || patterns.length > 1024 || patterns.some((p) => typeof p !== "string")) return null;
    if (patterns.length) {
      paths = paths.filter((file) => file === "package.json" || (
        patterns.some((p) => !p.startsWith("!") && globPattern(p).test(dirname(file).split(sep).join("/")))
        && !patterns.some((p) => p.startsWith("!") && globPattern(p.slice(1)).test(dirname(file).split(sep).join("/")))
      ));
    }
    if (paths.length > 1024) return null;
    let remaining = 8_388_608;
    const manifests: WorkspaceManifest[] = [];
    for (const path of paths.sort((a, b) => Number(b === "package.json") - Number(a === "package.json") || a.localeCompare(b))) {
      try {
        const content = this.readBounded(path, Math.min(remaining, 1_048_576));
        if (content === null) return null;
        remaining -= Buffer.byteLength(content);
        const pkg = JSON.parse(content);
        manifests.push({ path, name: pkg.name, scripts: pkg.scripts ?? {}, targets: pkg.nx?.targets ?? {}, dependencies: {
          ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.devDependencies, ...pkg.dependencies,
        } });
      } catch { return null; }
    }
    return manifests;
  }

  readBounded(file: string, limit = 1_048_576): string | null {
    if (!this.safeFile(file)) return null;
    const path = resolve(this.root, file);
    if (lstatSync(path).size > limit) return null;
    const content = readFileSync(path, "utf8");
    return Buffer.byteLength(content) <= limit ? content : null;
  }
}

/** Workspace globs operate on the inventory, never on installed dependency trees. */
function globPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/\/$/, "").replace(/[.+^$()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000").replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*")
    .replace(/\{([^{}]+)\}/g, (_, alternatives: string) => `(?:${alternatives.split(",").join("|")})`);
  return new RegExp(`^${escaped}$`);
}
