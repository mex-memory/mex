import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DEFAULT_SCAFFOLD_PATTERNS, findScaffoldFiles } from "./drift/index.js";
import { toPosix } from "./paths.js";
import type { MexConfig } from "./types.js";

export interface ExportOpts {
  /** Write the bundle to this file instead of stdout. */
  out?: string;
}

/**
 * Hard caps so export refuses instead of exhausting the heap: the file list
 * is bounded before anything is read, each file is read through its own file
 * descriptor with a per-file byte cap (never sized from `stat`), and the
 * running total of bytes actually read is checked before the joined document
 * is allocated.
 */
export const MAX_EXPORT_FILES = 1000;
export const MAX_EXPORT_FILE_BYTES = 1024 * 1024;
export const MAX_EXPORT_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * First line of every bundle this command writes. An existing `--out` target
 * carrying this marker is a previous export, not project state, so repeating
 * the export overwrites it (after excluding it from its own inputs) instead
 * of refusing.
 */
const BUNDLE_MARKER = "# mex scaffold export\n";

/** Resolve symlinks as far as the path exists, keeping any missing tail literal. */
function realpathBestEffort(target: string): string {
  const missing: string[] = [];
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return target;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

/** Whether an existing path is a previous export bundle (marker prefix, bounded read). */
function isPreviousExportBundle(target: string): boolean {
  let fd: number | undefined;
  try {
    // O_NONBLOCK + regular-file check: a FIFO at the target must neither hang
    // this probe nor be mistaken for a bundle.
    fd = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) {
      return false;
    }
    const prefix = Buffer.alloc(BUNDLE_MARKER.length);
    const read = readSync(fd, prefix, 0, prefix.length, 0);
    return read === prefix.length && prefix.toString("utf-8") === BUNDLE_MARKER;
  } catch {
    // Missing or unreadable: not a previous bundle. The write itself will
    // surface permission errors; refusal logic only treats markers as outputs.
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort: the descriptor is already open read-only and unused.
      }
    }
  }
}

/**
 * Read exactly the bytes of one scaffold file, bounded by the per-file cap.
 *
 * The file is opened `O_NONBLOCK` and read through the descriptor, so a FIFO
 * can neither hang the open nor be mistaken for content (`fstat` must report
 * a regular file). The cap is enforced on the bytes actually transferred —
 * never on an earlier `stat` — so a file that grows between discovery and
 * reading is still refused instead of exhausting the heap. Opening the
 * descriptor also pins the inode, so replacement races after open cannot
 * change what is read.
 */
function readBoundedFileSync(file: string, display: string): Buffer {
  const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`Refusing to export: "${display}" is not a regular file.`);
    }
    const chunks: Buffer[] = [];
    let remaining = MAX_EXPORT_FILE_BYTES + 1;
    const slab = Buffer.alloc(Math.min(64 * 1024, remaining));
    for (;;) {
      const got = readSync(fd, slab, 0, Math.min(slab.length, remaining), null);
      if (got === 0) break;
      chunks.push(Buffer.from(slab.subarray(0, got)));
      remaining -= got;
      if (remaining === 0) {
        throw new Error(
          `${display} is larger than ${MAX_EXPORT_FILE_BYTES} bytes; ` +
            `export supports at most ${MAX_EXPORT_FILE_BYTES} bytes per file.`
        );
      }
    }
    return Buffer.concat(chunks);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best effort: the descriptor is read-only and no longer needed.
    }
  }
}

/** Whether anything (file, symlink, directory, FIFO, hardlink) exists at `target`. */
function pathExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the whole document through an open descriptor, looping over partial
 * writes. A single `writeSync` may transfer only a prefix (disk quota, file
 * size limits), which must never be reported as success.
 */
function writeAllSync(fd: number, document: string, out: string): void {
  const bytes = Buffer.from(document, "utf-8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (written === 0) {
      throw new Error(
        `Refusing to export: "${out}" could not be fully written ` +
          `(${offset} of ${bytes.length} bytes stored). Choose a different --out path.`
      );
    }
    offset += written;
  }
}

/**
 * Overwrite a previous export bundle through a fresh descriptor, re-verifying
 * the bundle marker on the descriptor itself before truncating. This closes
 * the check→write race: a file swapped in after the pre-read check is refused
 * instead of truncated.
 */
function overwritePreviousBundle(target: string, out: string, document: string): void {
  // O_NONBLOCK is a no-op for regular files but keeps this open from hanging
  // if the target was replaced by a FIFO; the descriptor check below then
  // refuses the non-regular object instead of reading or truncating it.
  const fd = openSync(target, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(
        `Refusing to export: "${out}" already exists and is not a previous export bundle. ` +
          `Choose a different --out path.`
      );
    }
    const prefix = Buffer.alloc(BUNDLE_MARKER.length);
    const read = readSync(fd, prefix, 0, prefix.length, 0);
    if (read !== prefix.length || prefix.toString("utf-8") !== BUNDLE_MARKER) {
      throw new Error(
        `Refusing to export: "${out}" already exists and is not a previous export bundle. ` +
          `Choose a different --out path.`
      );
    }
    ftruncateSync(fd, 0);
    writeAllSync(fd, document, out);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best effort: the bundle bytes are already durable or an error propagates.
    }
  }
}

/**
 * Create a brand-new output file, refusing anything already present. The
 * exclusive `wx` open closes the check→write race: a concurrent creator wins
 * with `EEXIST`, which becomes the same refusal instead of a truncation.
 */
function writeNewBundleFile(target: string, out: string, document: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(target, "wx", 0o666);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(
        `Refusing to export: "${out}" already exists and is not a previous export bundle. ` +
          `Choose a different --out path.`
      );
    }
    throw error;
  }
  try {
    writeAllSync(fd, document, out);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best effort: the bundle bytes are already durable or an error propagates.
    }
  }
}

/**
 * Bundle the whole scaffold into one Markdown document (#56).
 *
 * Section headers name the source file so a pasted copy stays navigable, and
 * files are emitted in a deterministic order (sorted by path). Reuses the
 * drift scanner's own file discovery, so what gets exported is exactly what
 * `mex check` scans — nothing drifts between the two.
 *
 * Safety: `--out` never overwrites existing state that is not a previous
 * export bundle — any pre-existing file, symlink, directory, FIFO, or
 * hardlink at the target is refused before anything is read or written, so
 * the original bytes always survive. A previous bundle (marker prefix) may be
 * overwritten, after re-verification on the write descriptor, and is excluded
 * from its own inputs. Reads are descriptor-bound: only regular files, with
 * per-file and aggregate caps enforced on the bytes actually transferred.
 */
export async function runExport(config: MexConfig, opts: ExportOpts = {}): Promise<void> {
  let files = findScaffoldFiles(config.projectRoot, config.scaffoldRoot, DEFAULT_SCAFFOLD_PATTERNS)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (files.length === 0) {
    throw new Error("No scaffold files found. Run: mex setup");
  }

  const configPath = resolve(config.scaffoldRoot, "config.json");
  if (opts.out) {
    const target = resolve(config.projectRoot, opts.out);
    const targetReal = realpathBestEffort(target);
    // A previous bundle is output, not project state: allow overwriting it
    // (it is still excluded from its own inputs below).
    const previousBundle = isPreviousExportBundle(target);
    assertExportTarget(config, files, configPath, opts.out, previousBundle ? targetReal : undefined);
    if (!previousBundle && pathExists(target)) {
      // Anything already present — scaffold or config missed above,
      // event history, README, hardlink/symlink/FIFO/dir aliases — is state,
      // not a fresh destination. Refuse before reading or writing anything.
      throw new Error(
        `Refusing to export: "${opts.out}" already exists and is not a previous export bundle. ` +
          `Choose a different --out path.`
      );
    }
    // A previous bundle inside the scaffold must not become an input:
    // repeated exports would otherwise duplicate the whole scaffold.
    files = files.filter((file) => realpathBestEffort(file) !== targetReal);
  }

  if (files.length === 0) {
    throw new Error("No scaffold files found. Run: mex setup");
  }
  if (files.length > MAX_EXPORT_FILES) {
    throw new Error(
      `Scaffold has ${files.length} files; export supports at most ${MAX_EXPORT_FILES}.`
    );
  }

  let totalBytes = 0;
  const contents: string[] = [];
  for (const file of files) {
    const display = toPosix(relative(config.scaffoldRoot, file));
    const data = readBoundedFileSync(file, display);
    totalBytes += data.length;
    if (totalBytes > MAX_EXPORT_TOTAL_BYTES) {
      throw new Error(
        `Scaffold totals more than ${MAX_EXPORT_TOTAL_BYTES} bytes; ` +
          `export supports at most ${MAX_EXPORT_TOTAL_BYTES} bytes in total.`
      );
    }
    contents.push(data.toString("utf-8"));
  }

  const bundle: string[] = ["# mex scaffold export", ""];
  for (let index = 0; index < files.length; index += 1) {
    const relativePath = toPosix(relative(config.scaffoldRoot, files[index]));
    bundle.push(`## ${relativePath}`, "", contents[index].trimEnd(), "");
  }
  const document = bundle.join("\n");

  if (opts.out) {
    const target = resolve(config.projectRoot, opts.out);
    mkdirSync(dirname(target), { recursive: true });
    if (isPreviousExportBundle(target)) {
      overwritePreviousBundle(target, opts.out, document);
    } else {
      writeNewBundleFile(target, opts.out, document);
    }
    console.log(`Wrote ${files.length} scaffold file(s) to ${opts.out}`);
    return;
  }
  process.stdout.write(document);
}

/**
 * Refuse an `--out` target that would overwrite project state: an existing
 * scaffold file, the project configuration, or a symlink alias of either.
 * Throws before anything is written, so the original bytes always survive.
 * `excludeReal`, when given, names a previous bundle output, which is output
 * rather than project state and is therefore not protected.
 */
function assertExportTarget(
  config: MexConfig,
  files: string[],
  configPath: string,
  out: string,
  excludeReal?: string
): void {
  const target = resolve(config.projectRoot, out);
  const targetReal = realpathBestEffort(target);
  const protectedPaths = [...files, configPath];
  for (const protectedPath of protectedPaths) {
    const resolved = resolve(protectedPath);
    if (excludeReal !== undefined && realpathBestEffort(resolved) === excludeReal) continue;
    if (target === resolved || targetReal === realpathBestEffort(resolved)) {
      const label =
        resolve(protectedPath) === resolve(configPath)
          ? `project configuration ${toPosix(relative(config.projectRoot, resolved))}`
          : `scaffold file ${toPosix(relative(config.scaffoldRoot, resolved))}`;
      throw new Error(
        `Refusing to export: "${out}" would overwrite ${label}. Choose a different --out path.`
      );
    }
  }
}
