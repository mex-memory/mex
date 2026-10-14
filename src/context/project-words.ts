/**
 * Words that name the project itself, derived from the checkout rather than
 * hard-coded: the root directory's name and the `package.json` name (scope
 * removed). They are stop words for that project's index and prompts.
 */

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { projectNameWords } from "./tokenize.js";

const MAX_PACKAGE_JSON_BYTES = 256 * 1024;

export function readProjectWords(projectRoot: string): string[] {
  const names = [basename(projectRoot)];
  let fd: number | undefined;
  try {
    fd = openSync(join(projectRoot, "package.json"), "r");
    if (fstatSync(fd).size <= MAX_PACKAGE_JSON_BYTES) {
      const name = (JSON.parse(readFileSync(fd, "utf8")) as { name?: unknown }).name;
      if (typeof name === "string") names.push(name);
    }
  } catch {
    // No readable package.json: the directory name alone.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return projectNameWords(names);
}
