/**
 * Recipe readers for Makefiles, Python (tox, pyproject, setup.cfg), Cargo and
 * Gradle. Each names the exact command and the checks that prove it still
 * exists; none runs anything.
 */
import { pointer, record, strings, type Found, type Package, type Purpose, type RepoFiles } from "./source.js";

const MAKE_TARGETS: ReadonlyArray<[Purpose, readonly string[]]> = [
  ["test", ["test", "tests", "check"]],
  ["build", ["build", "all"]],
  ["lint", ["lint"]],
  ["typecheck", ["typecheck", "type-check", "types", "mypy"]],
  ["format", ["format", "fmt"]],
];
const MAKE_RULE = /^([A-Za-z0-9_.%/-]+(?:\s+[A-Za-z0-9_.%/-]+)*)\s*::?(?:[^=]|$)/u;

/** Target names a Makefile defines, as the evaluator reads them. */
export function makeTargets(text: string): Set<string> {
  const targets = new Set<string>();
  for (const line of text.replace(/\r\n/gu, "\n").split("\n")) {
    if (line.startsWith("\t") || line.startsWith("#")) continue;
    const match = MAKE_RULE.exec(line);
    if (match) for (const name of match[1]!.split(/\s+/u)) targets.add(name);
  }
  return targets;
}

export function readMake(files: RepoFiles): { packages: Package[]; found: Found[] } {
  const file = ["Makefile", "makefile", "GNUmakefile"].find(name => files.isFile(name));
  const text = file ? files.read(file) : undefined;
  if (!file || text === undefined) return { packages: [], found: [] };
  const targets = makeTargets(text);
  const found: Found[] = [];
  for (const [purpose, names] of MAKE_TARGETS) {
    const target = names.find(name => targets.has(name));
    if (!target) continue;
    const command = `make ${target}`;
    found.push({
      purpose, package: "", command, source: "config", local: "yes", origin: { file, pointer: pointer(target) }, match: `make::${target}`,
      checks: [{ kind: "command", role: "complete", target: { run: command, file, pointer: pointer(target) } }],
    });
  }
  return { packages: found.length ? [{ path: "", name: "Makefile", kind: "make" }] : [], found };
}

const TOX_PURPOSES: ReadonlyArray<[Purpose, RegExp]> = [
  ["typecheck", /^(type|types|typing|typecheck|mypy|pyright)$/u],
  ["lint", /^(lint|flake8|ruff|pylint|pre-commit|style)$/u],
  ["format", /^(format|fmt|black|isort)$/u],
  ["build", /^(build|dist|package)$/u],
  ["test", /^(py\d*(-.+)?|pypy\d*(-.+)?|test|tests|unit|unittest|pytest)$/u],
];

function toxPurpose(env: string): Purpose | undefined {
  return TOX_PURPOSES.find(([, pattern]) => pattern.test(env))?.[0];
}

/** Environment names from an envlist, expanding simple `{a,b}` groups. */
export function toxEnvs(envlist: string): string[] {
  const out: string[] = [];
  // Split on commas and spaces outside `{...}` groups.
  const items: string[] = [];
  let current = "", depth = 0;
  for (const char of envlist) {
    if (char === "{") depth++;
    if (char === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && /[\s,]/u.test(char)) { if (current) items.push(current); current = ""; continue; }
    current += char;
  }
  if (current) items.push(current);
  for (const item of items) {
    const group = /^(.*)\{([^}]*)\}(.*)$/u.exec(item);
    if (group) for (const part of group[2]!.split(",")) out.push(`${group[1]}${part.trim()}${group[3]}`);
    else out.push(item);
  }
  return [...new Set(out)];
}

export function readPython(files: RepoFiles): { packages: Package[]; found: Found[] } {
  const found: Found[] = [];
  const tox = files.isFile("tox.ini") ? files.ini("tox.ini") : undefined;
  if (tox) {
    const envlist = typeof record(tox.tox)?.envlist === "string" ? toxEnvs(record(tox.tox)!.envlist as string) : [];
    const named = Object.keys(tox).filter(name => name.startsWith("testenv:")).map(name => name.slice("testenv:".length));
    const seen = new Set<Purpose>();
    for (const env of [...new Set([...envlist, ...named])]) {
      const purpose = toxPurpose(env);
      if (!purpose || seen.has(purpose)) continue;
      // An env without its own section runs the shared [testenv] commands.
      const section = record(tox[`testenv:${env}`])?.commands !== undefined ? `testenv:${env}` : "testenv";
      if (typeof record(tox[section])?.commands !== "string") continue;
      seen.add(purpose);
      const command = `tox -e ${env}`, at = pointer(section, "commands");
      found.push({
        purpose, package: "", command, source: "config", local: "yes", origin: { file: "tox.ini", pointer: at }, match: `tox:${env}`,
        checks: [
          { kind: "key", role: "complete", target: { file: "tox.ini", pointer: at } },
          { kind: "command", role: "supporting", target: { run: command, file: "tox.ini", pointer: at } },
        ],
      });
    }
  }
  const tools: Array<{ file: string; doc: Record<string, unknown> | undefined; sections: Array<[Purpose, string[], string]> }> = [
    { file: "pyproject.toml", doc: files.isFile("pyproject.toml") ? files.toml("pyproject.toml") : undefined, sections: [
      ["test", ["tool", "pytest", "ini_options"], "pytest"],
      ["lint", ["tool", "ruff"], "ruff check ."],
      ["typecheck", ["tool", "mypy"], "mypy ."],
      ["format", ["tool", "black"], "black --check ."],
    ] },
    { file: "setup.cfg", doc: files.isFile("setup.cfg") ? files.ini("setup.cfg") : undefined, sections: [
      ["test", ["tool:pytest"], "pytest"],
      ["lint", ["flake8"], "flake8"],
      ["typecheck", ["mypy"], "mypy ."],
    ] },
  ];
  const have = new Set(found.map(item => item.purpose));
  for (const { file, doc, sections } of tools) {
    if (!doc) continue;
    for (const [purpose, path, command] of sections) {
      let value: unknown = doc;
      for (const part of path) value = record(value)?.[part];
      if (value === undefined || have.has(purpose)) continue;
      have.add(purpose);
      const at = pointer(...path);
      found.push({
        purpose, package: "", command, source: "config", local: "yes", origin: { file, pointer: at }, match: `python:${command}`,
        checks: [{ kind: "command", role: "complete", target: { run: command, file, pointer: at } }],
      });
    }
  }
  const python = tox || tools.some(tool => tool.doc);
  const name = typeof record(record(tools[0]!.doc)?.project)?.name === "string" ? record(tools[0]!.doc!.project)!.name as string : "(root)";
  return { packages: python ? [{ path: "", name, kind: "python" }] : [], found };
}

export function readCargo(files: RepoFiles): { packages: Package[]; found: Found[] } {
  const root = files.isFile("Cargo.toml") ? files.toml("Cargo.toml") : undefined;
  if (!root) return { packages: [], found: [] };
  const members: Array<{ path: string; name: string }> = [];
  const own = record(root.package)?.name;
  if (typeof own === "string") members.push({ path: "", name: own });
  const excluded = new Set(strings(record(root.workspace)?.exclude));
  for (const glob of strings(record(root.workspace)?.members)) {
    for (const path of files.glob(glob)) {
      if (path === "" || excluded.has(path) || members.some(member => member.path === path)) continue;
      const name = record(files.toml(`${path}/Cargo.toml`)?.package)?.name;
      if (typeof name === "string") members.push({ path, name });
    }
  }
  const packages: Package[] = members.map(member => ({ ...member, kind: "cargo" }));
  const found: Found[] = [];
  const subcommands: Array<[Purpose, string]> = [["test", "test"], ["build", "build"], ["lint", "clippy"]];
  const workspace = members.length > 1;
  const rootPointer = typeof own === "string" ? pointer("package", "name") : pointer("workspace", "members");
  for (const [purpose, sub] of subcommands) {
    const command = `cargo ${sub}${workspace ? " --workspace" : ""}`;
    found.push({
      purpose, package: "", command, source: "config", local: "yes", origin: { file: "Cargo.toml", pointer: rootPointer }, match: `cargo::${sub}`,
      checks: [{ kind: "key", role: "complete", target: { file: "Cargo.toml", pointer: rootPointer } }],
    });
    if (!workspace) continue;
    for (const member of members.filter(item => item.path !== "")) {
      const file = `${member.path}/Cargo.toml`, at = pointer("package", "name"), run = `cargo ${sub} -p ${member.name}`;
      found.push({
        purpose, package: member.path, command: run, source: "config", local: "yes", origin: { file, pointer: at }, match: `cargo:${member.path}:${sub}`,
        checks: [{ kind: "key", role: "complete", target: { file, pointer: at } }],
      });
    }
  }
  return { packages, found };
}

const GRADLE_INCLUDE = /^\s*include\s*\(?([^)\n]*)\)?/gmu;
export function gradleProjects(settings: string): string[] {
  const out: string[] = [];
  for (const match of settings.matchAll(GRADLE_INCLUDE)) {
    for (const quoted of match[1]!.matchAll(/["']([^"']+)["']/gu)) out.push(quoted[1]!.replace(/^:/u, ""));
  }
  return [...new Set(out)];
}

export function readGradle(files: RepoFiles): { packages: Package[]; found: Found[] } {
  const wrapper = "gradle/wrapper/gradle-wrapper.properties";
  if (!files.isFile("gradlew") || !files.isFile(wrapper)) return { packages: [], found: [] };
  const settingsFile = ["settings.gradle.kts", "settings.gradle"].find(name => files.isFile(name));
  const projects = settingsFile ? gradleProjects(files.read(settingsFile) ?? "") : [];
  const packages: Package[] = [{ path: "", name: "(root)", kind: "gradle" }, ...projects.map(name => ({ path: name.replace(/:/gu, "/"), name: `:${name}`, kind: "gradle" as const }))];
  const at = pointer("distributionUrl");
  const found: Found[] = [];
  for (const [purpose, task] of [["test", "test"], ["build", "build"], ["lint", "check"]] as Array<[Purpose, string]>) {
    for (const pkg of packages) {
      const command = pkg.path === "" ? `./gradlew ${task}` : `./gradlew ${pkg.name}:${task}`;
      found.push({
        purpose, package: pkg.path, command, source: "config", local: "yes", origin: { file: wrapper, pointer: at }, match: `gradle:${pkg.path}:${task}`,
        checks: [{ kind: "command", role: pkg.path === "" ? "complete" : "supporting", target: { run: command, file: wrapper, pointer: at } }],
      });
    }
  }
  return { packages, found };
}
