import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CLI version, read from package.json at runtime so it can never drift from the
 * published version (see #48 — this used to be a hard-coded literal that fell
 * behind package.json).
 *
 * `../package.json` resolves to the project root from this module in every
 * context: `src/version.ts` during tests, and the bundled `dist/cli.js` at
 * build time and in the installed package (package.json ships via the `files`
 * whitelist). We resolve via fileURLToPath + path.join rather than
 * `new URL("../package.json", import.meta.url)` so the bundler treats it as a
 * plain runtime read instead of a copied asset.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string };

export const VERSION = pkg.version;
