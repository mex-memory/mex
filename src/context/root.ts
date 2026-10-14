/**
 * Finding the project from anywhere inside it.
 *
 * `findConfig` (used by `wiki query`) walks up to the nearest Git root and then
 * insists on a complete scaffold, and it throws when the working directory is
 * inside `.mex/`. A hook is launched from whatever directory the agent happens
 * to be in, and a monorepo package may be its own Git repository, so the
 * context commands look for the scaffold itself: the nearest ancestor holding a
 * `.mex/` directory that is actually a scaffold. Being inside `.mex/` resolves
 * to its project, and the per-machine `~/.mex` home is never mistaken for one.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { mexHomeDir } from "../global-config.js";

export interface ContextRoot {
  projectRoot: string;
  /** `<projectRoot>/.mex` */
  scaffoldRoot: string;
  /** `<scaffoldRoot>/local`, where every derived context file lives. */
  localDir: string;
}

/**
 * What makes a `.mex/` a project scaffold. `config.json` is deliberately not a
 * marker: the per-machine MEX home (`~/.mex`) has one too, and `findConfig`
 * itself requires `ROUTER.md`.
 */
const SCAFFOLD_MARKERS = ["ROUTER.md", "AGENTS.md", "wiki.db", "graph.db"] as const;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function sameLocation(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isScaffold(mexDir: string): boolean {
  if (!isDirectory(mexDir)) return false;
  let home: string | null = null;
  try {
    home = resolve(mexHomeDir());
  } catch {
    home = null;
  }
  if (home !== null && sameLocation(resolve(mexDir), home)) return false;
  return SCAFFOLD_MARKERS.some((marker) => existsSync(join(mexDir, marker)));
}

/** The project that owns `startDir`, or null when no ancestor holds a scaffold. */
export function resolveContextRoot(startDir: string = process.cwd()): ContextRoot | null {
  let current = resolve(startDir);
  // Inside the scaffold itself: begin at the directory that holds it.
  const parts = current.split(sep);
  const inside = parts.lastIndexOf(".mex");
  if (inside > 0) current = parts.slice(0, inside).join(sep) || sep;

  for (;;) {
    const scaffoldRoot = join(current, ".mex");
    if (isScaffold(scaffoldRoot)) {
      return { projectRoot: current, scaffoldRoot, localDir: join(scaffoldRoot, "local") };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
