import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireWikiMaintenanceLease,
  bindIndexGeneration,
  bindIndexDirectory,
  cloneIndexFile,
  IndexInUseError,
  IndexPublishRecoveryError,
  IndexPathError,
  removeIndexFiles,
  WikiMaintenanceLockedError,
} from "../dbfile.js";
import {
  createPendingIndex,
  publishPendingIndex,
  publishSealedPendingIndex,
  sealPendingIndex,
} from "../publish.js";
import {
  WIKI_MAINTENANCE_PHASES,
  WikiMaintenanceInterruptedError,
  WikiPreparedMaintenanceNotPreflightedError,
  WikiPreparedMaintenanceSettledError,
  type WikiMaintenancePhase,
} from "../maintenance.js";
import { prepareWikiRebuild, rebuildWikiIndex } from "../rebuild.js";
import { prepareWikiRefresh, refreshWikiIndex, WikiRefreshPathError } from "../refresh.js";
import { readContainedSource, WikiSourceReadError } from "../source-read.js";
import { WIKI_CORPUS_LIMITS, WikiCorpusLimitError, addWikiCorpusBytes } from "../corpus-policy.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function scaffold(): { root: string; path: string; indexPath: string } {
  const root = mkdtempSync(join(tmpdir(), "mex-wiki-maintenance-"));
  roots.push(root);
  const path = join(root, "context", "architecture.md");
  const indexPath = join(root, "wiki.db");
  mkdirSync(join(root, "context"), { recursive: true });
  writeFileSync(
    path,
    `<!-- mex:entity
id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD
type: architecture
status: promoted
revision: 1
-->
## Architecture

One service.
`,
    "utf8",
  );
  return { root, path, indexPath };
}

describe("Wiki maintenance lease and boundaries", () => {
  it("rejects a preexisting symlinked scaffold root before creating a lease or index", () => {
    const outside = mkdtempSync(join(tmpdir(), "mex-wiki-symlink-root-outside-"));
    const lexical = `${outside}-lexical`;
    roots.push(lexical, outside);
    mkdirSync(join(outside, "context"), { recursive: true });
    symlinkSync(outside, lexical, "dir");

    expect(() => rebuildWikiIndex({
      scaffoldRoot: lexical,
      indexPath: join(lexical, "wiki.db"),
    })).toThrow(IndexPathError);
    expect(existsSync(join(outside, "wiki.db"))).toBe(false);
    expect(existsSync(join(outside, "wiki.db.lock"))).toBe(false);
  });

  it("rejects a scaffold retarget between an adapter-style check and lease acquisition", () => {
    const target = scaffold();
    // Simulate the repository adapter's earlier successful root assertion.
    bindIndexDirectory(target.indexPath, target.root);
    const moved = `${target.root}-bound`;
    const outside = mkdtempSync(join(tmpdir(), "mex-wiki-retarget-outside-"));
    roots.push(moved, outside);
    renameSync(target.root, moved);
    symlinkSync(outside, target.root, "dir");

    expect(() => acquireWikiMaintenanceLease(target.indexPath, "rebuild", target.root))
      .toThrow(IndexPathError);
    expect(existsSync(join(outside, "wiki.db"))).toBe(false);
    expect(existsSync(join(outside, "wiki.db.lock"))).toBe(false);
  });

  it("rejects a discovered source leaf swapped to an escaping symlink after descriptor open", () => {
    const target = scaffold();
    const moved = `${target.path}.moved`;
    const outside = mkdtempSync(join(tmpdir(), "mex-wiki-source-outside-"));
    roots.push(outside);
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "external secret bytes", "utf8");

    expect(() => readContainedSource(target.root, target.path, {
      afterOpen: () => {
        renameSync(target.path, moved);
        symlinkSync(secret, target.path, "file");
      },
    })).toThrow(WikiSourceReadError);
    expect(readFileSync(secret, "utf8")).toBe("external secret bytes");
  });

  it("rejects malformed UTF-8 instead of hashing replacement characters", () => {
    const target = scaffold();
    writeFileSync(target.path, Buffer.from([0x23, 0x20, 0x61, 0x0a, 0xc3, 0x28]));
    expect(() => readContainedSource(target.root, target.path)).toThrow(WikiSourceReadError);
  });

  it("rejects oversized source and aggregate corpus bytes before decoding", () => {
    const target = scaffold();
    truncateSync(target.path, WIKI_CORPUS_LIMITS.maxFileBytes + 1);
    expect(() => readContainedSource(target.root, target.path)).toThrow(WikiCorpusLimitError);
    expect(() => addWikiCorpusBytes(WIKI_CORPUS_LIMITS.maxCorpusBytes, 1))
      .toThrow(WikiCorpusLimitError);
  });

  it("preserves a valid UTF-8 BOM as an exact source character", () => {
    const target = scaffold();
    writeFileSync(target.path, "\uFEFF# BOM\n", "utf8");
    expect(readContainedSource(target.root, target.path)).toBe("\uFEFF# BOM\n");
  });

  it("rejects a same-inode edit after descriptor bytes were read", () => {
    const target = scaffold();
    expect(() => readContainedSource(target.root, target.path, {
      afterRead: () => writeFileSync(target.path, `${readFileSync(target.path, "utf8")}late edit\n`, "utf8"),
    })).toThrow(WikiSourceReadError);
  });

  it("preflights the exact rebuild corpus before rename and releases on discard", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const live = readFileSync(target.indexPath);
    writeFileSync(target.path, `${readFileSync(target.path, "utf8")}prepared edit\n`, "utf8");
    const prepared = prepareWikiRebuild({ scaffoldRoot: target.root, indexPath: target.indexPath });
    writeFileSync(target.path, `${readFileSync(target.path, "utf8")}late edit\n`, "utf8");

    expect(() => prepared.preflight()).toThrow(WikiMaintenanceInterruptedError);
    expect(readFileSync(target.indexPath)).toEqual(live);
    prepared.discard();
    expect(existsSync(`${target.indexPath}.lock`)).toBe(false);
    expect(() => prepared.discard()).toThrow(WikiPreparedMaintenanceSettledError);
  });

  it("streams candidate source bodies and interrupts if a file changes between observation and parse", () => {
    const target = scaffold();
    let reads = 0;
    const original = readFileSync(target.path, "utf8");
    expect(() => rebuildWikiIndex({
      scaffoldRoot: target.root,
      indexPath: target.indexPath,
      readFile: () => {
        reads += 1;
        return reads === 1 ? original : `${original}\nchanged during candidate build\n`;
      },
    })).toThrow(WikiMaintenanceInterruptedError);
    expect(reads).toBe(2);
    expect(existsSync(target.indexPath)).toBe(false);
  });

  it("fast-rebinds the corpus after preflight and refuses a pre-commit edit", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const live = readFileSync(target.indexPath);
    writeFileSync(target.path, `${readFileSync(target.path, "utf8")}prepared edit\n`, "utf8");
    const prepared = prepareWikiRebuild({ scaffoldRoot: target.root, indexPath: target.indexPath });
    prepared.preflight();
    writeFileSync(target.path, `${readFileSync(target.path, "utf8")}after graph final\n`, "utf8");

    expect(() => prepared.commit()).toThrow(WikiMaintenanceInterruptedError);
    expect(readFileSync(target.indexPath)).toEqual(live);
    expect(existsSync(`${target.indexPath}.lock`)).toBe(false);
  });

  it("honors cancellation after preflight and before the final rename", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const live = readFileSync(target.indexPath);
    writeFileSync(target.path, `${readFileSync(target.path, "utf8")}prepared edit\n`, "utf8");
    const controller = new AbortController();
    const prepared = prepareWikiRebuild({
      scaffoldRoot: target.root,
      indexPath: target.indexPath,
      maintenance: { signal: controller.signal },
    });
    prepared.preflight();
    controller.abort();

    expect(() => prepared.commit()).toThrow(WikiMaintenanceInterruptedError);
    expect(readFileSync(target.indexPath)).toEqual(live);
    expect(existsSync(`${target.indexPath}.lock`)).toBe(false);
  });

  it("requires preflight and pins only the selected refresh paths", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    writeFileSync(target.path, readFileSync(target.path, "utf8").replace("One service.", "Two services."), "utf8");
    const result = prepareWikiRefresh({
      scaffoldRoot: target.root,
      indexPath: target.indexPath,
      changed: ["context/architecture.md"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => result.prepared.commit()).toThrow(WikiPreparedMaintenanceNotPreflightedError);
    // A failed not-preflighted call does not settle the handle.
    const unrelated = join(target.root, "context", "unrelated.md");
    writeFileSync(unrelated, "# unrelated concurrent edit\n", "utf8");
    result.prepared.preflight();
    expect(result.prepared.commit().ok).toBe(true);
    expect(existsSync(`${target.indexPath}.lock`)).toBe(false);
  });

  it("interrupts a prepared refresh when a selected path changes before preflight", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const live = readFileSync(target.indexPath);
    writeFileSync(target.path, readFileSync(target.path, "utf8").replace("One service.", "Two services."), "utf8");
    const result = prepareWikiRefresh({
      scaffoldRoot: target.root,
      indexPath: target.indexPath,
      changed: ["context/architecture.md"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    writeFileSync(target.path, `${readFileSync(target.path, "utf8")}late selected edit\n`, "utf8");
    expect(() => result.prepared.preflight()).toThrow(WikiMaintenanceInterruptedError);
    expect(readFileSync(target.indexPath)).toEqual(live);
    result.prepared.discard();
    expect(existsSync(`${target.indexPath}.lock`)).toBe(false);
  });

  it("rejects a zero-progress candidate clone and removes only its candidate", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const before = readFileSync(target.indexPath);
    const binding = bindIndexDirectory(target.indexPath, target.root);
    const candidate = `${target.indexPath}.tmp-zero`;
    expect(() => cloneIndexFile(target.indexPath, candidate, binding, () => 0)).toThrow();
    expect(readFileSync(target.indexPath)).toEqual(before);
    expect(existsSync(candidate)).toBe(false);
  });

  it("emits the fixed rebuild phases and releases its cross-process lease", () => {
    const target = scaffold();
    const phases: WikiMaintenancePhase[] = [];
    rebuildWikiIndex({
      scaffoldRoot: target.root,
      indexPath: target.indexPath,
      maintenance: { reportProgress: ({ phase }) => phases.push(phase) },
    });

    expect([...new Set(phases)]).toEqual(WIKI_MAINTENANCE_PHASES);
    expect(existsSync(`${target.indexPath}.lock`)).toBe(false);
    expect(existsSync(`${target.indexPath}.lock.gate`)).toBe(false);
  });

  it("rejects a competing writer without changing the live index", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const before = readFileSync(target.indexPath);
    const lease = acquireWikiMaintenanceLease(target.indexPath, "refresh", target.root);
    try {
      expect(() => rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath }))
        .toThrow(WikiMaintenanceLockedError);
      expect(readFileSync(target.indexPath)).toEqual(before);
    } finally {
      lease.release();
    }
  });

  it("uses one scaffold-wide lease even when callers name different index databases", () => {
    const target = scaffold();
    const first = acquireWikiMaintenanceLease(target.indexPath, "operation", target.root);
    try {
      expect(() => acquireWikiMaintenanceLease(join(target.root, "alternate.db"), "migration", target.root))
        .toThrow(WikiMaintenanceLockedError);
      expect(first.lockPath).toBe(join(target.root, "wiki.db.lock"));
    } finally {
      first.release();
    }
  });

  it.each(["../outside.md", "/tmp/outside.md", "context\\outside.md", "context/../outside.md", "context/bad\0.md"])(
    "rejects unsafe direct refresh path %j before candidate mutation",
    (path) => {
      const target = scaffold();
      rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
      const before = readFileSync(target.indexPath);
      expect(() => refreshWikiIndex({
        scaffoldRoot: target.root,
        indexPath: target.indexPath,
        changed: [path],
      })).toThrow(WikiRefreshPathError);
      expect(readFileSync(target.indexPath)).toEqual(before);
      expect(readdirSync(target.root).some((name) => name.includes(".tmp-"))).toBe(false);
    },
  );

  it("discards an aborted rebuild candidate and preserves the prior index", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const before = readFileSync(target.indexPath);
    writeFileSync(target.path, `${readFileSync(target.path, "utf8")}A new sentence.\n`, "utf8");
    const controller = new AbortController();

    expect(() => rebuildWikiIndex({
      scaffoldRoot: target.root,
      indexPath: target.indexPath,
      maintenance: {
        signal: controller.signal,
        reportProgress: ({ phase }) => {
          if (phase === "parse") controller.abort();
        },
      },
    })).toThrow(WikiMaintenanceInterruptedError);

    expect(readFileSync(target.indexPath)).toEqual(before);
    expect(existsSync(`${target.indexPath}.lock`)).toBe(false);
  });

  it("honors cancellation at the final boundary before publication", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const before = readFileSync(target.indexPath);
    writeFileSync(target.path, `${readFileSync(target.path, "utf8")}A final change.\n`, "utf8");
    const controller = new AbortController();

    expect(() => rebuildWikiIndex({
      scaffoldRoot: target.root,
      indexPath: target.indexPath,
      maintenance: {
        signal: controller.signal,
        reportProgress: ({ phase }) => {
          if (phase === "publish") controller.abort();
        },
      },
    })).toThrow(WikiMaintenanceInterruptedError);

    expect(readFileSync(target.indexPath)).toEqual(before);
    expect(readdirSync(target.root).filter((name) => name.includes(".tmp-") || name.includes(".recovery-")))
      .toEqual([]);
    expect(existsSync(`${target.indexPath}.lock`)).toBe(false);
  });

  it("rolls back an aborted refresh transaction", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const before = readFileSync(target.indexPath);
    writeFileSync(target.path, readFileSync(target.path, "utf8").replace("One service.", "Two services."), "utf8");
    const controller = new AbortController();

    expect(() => refreshWikiIndex({
      scaffoldRoot: target.root,
      indexPath: target.indexPath,
      changed: ["context/architecture.md"],
      maintenance: {
        signal: controller.signal,
        reportProgress: ({ phase }) => {
          if (phase === "resolve") controller.abort();
        },
      },
    })).toThrow(WikiMaintenanceInterruptedError);

    expect(readFileSync(target.indexPath)).toEqual(before);
    expect(existsSync(`${target.indexPath}.lock`)).toBe(false);
  });

  it("never steals a stale gate and leaves its exact owner record untouched", () => {
    const target = scaffold();
    const gatePath = `${target.indexPath}.lock.gate`;
    const stale = `${JSON.stringify({
      v: 1,
      pid: 2_147_483_647,
      token: "a".repeat(64),
      kind: "gate",
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`;
    writeFileSync(gatePath, stale, "utf8");
    const before = lstatSync(gatePath);

    expect(() => acquireWikiMaintenanceLease(target.indexPath, "rebuild", target.root))
      .toThrow(WikiMaintenanceLockedError);
    expect(readFileSync(gatePath, "utf8")).toBe(stale);
    const after = lstatSync(gatePath);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  });

  it("does not unlink a replacement lock when the held pathname is swapped", () => {
    const target = scaffold();
    const lease = acquireWikiMaintenanceLease(target.indexPath, "operation", target.root);
    const displaced = `${lease.lockPath}.displaced`;
    renameSync(lease.lockPath, displaced);
    const replacement = `${JSON.stringify({
      v: 1,
      pid: process.pid,
      token: "b".repeat(64),
      kind: "operation",
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`;
    writeFileSync(lease.lockPath, replacement, "utf8");

    expect(() => lease.release()).toThrow(WikiMaintenanceLockedError);
    expect(readFileSync(lease.lockPath, "utf8")).toBe(replacement);
    expect(existsSync(displaced)).toBe(true);
  });

  it("rejects a bound directory retarget without touching the escape target", () => {
    const target = scaffold();
    writeFileSync(target.indexPath, "inside generation", "utf8");
    const binding = bindIndexDirectory(target.indexPath, target.root);
    const movedRoot = `${target.root}-moved`;
    const escapeRoot = mkdtempSync(join(tmpdir(), "mex-wiki-maintenance-escape-"));
    roots.push(movedRoot, escapeRoot);
    renameSync(target.root, movedRoot);
    writeFileSync(join(escapeRoot, "wiki.db"), "outside generation", "utf8");
    symlinkSync(escapeRoot, target.root, "dir");

    expect(() => removeIndexFiles(target.indexPath, binding)).toThrow(IndexPathError);
    expect(readFileSync(join(escapeRoot, "wiki.db"), "utf8")).toBe("outside generation");
    expect(readFileSync(join(movedRoot, "wiki.db"), "utf8")).toBe("inside generation");
  });

  it("restores the exact prior index when post-publication validation fails", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const before = readFileSync(target.indexPath);
    const binding = bindIndexDirectory(target.indexPath, target.root);
    const pending = createPendingIndex(target.indexPath, binding);

    expect(() => publishPendingIndex(
      pending.handle,
      pending.tempPath,
      target.indexPath,
      binding,
      () => { throw new Error("injected postvalidation failure"); },
    )).toThrow(IndexInUseError);

    expect(readFileSync(target.indexPath)).toEqual(before);
    expect(readdirSync(target.root).filter((name) => name.includes(".recovery-") || name.includes(".tmp-")))
      .toEqual([]);
  });

  it("rejects candidate and live A-B-A substitutions before publication", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const before = readFileSync(target.indexPath);
    const binding = bindIndexDirectory(target.indexPath, target.root);

    const candidatePending = createPendingIndex(target.indexPath, binding);
    const candidate = sealPendingIndex(candidatePending.handle, candidatePending.tempPath, binding);
    const live = bindIndexGeneration(target.indexPath, binding);
    const candidateBytes = readFileSync(candidatePending.tempPath);
    expect(() => publishSealedPendingIndex(
      candidatePending.tempPath,
      target.indexPath,
      binding,
      candidate,
      live,
      undefined,
      undefined,
      {
        beforeCandidateRename: () => {
          writeFileSync(candidatePending.tempPath, "substitute", "utf8");
          writeFileSync(candidatePending.tempPath, candidateBytes);
          // Fast Windows writes can share both mtime and ctime. Make the
          // generation change observable without depending on clock resolution.
          const changedAt = new Date(lstatSync(candidatePending.tempPath).mtimeMs + 2_000);
          utimesSync(candidatePending.tempPath, changedAt, changedAt);
        },
      },
    )).toThrow(IndexInUseError);
    expect(readFileSync(target.indexPath)).toEqual(before);

    rmSync(candidatePending.tempPath, { force: true });
    const livePending = createPendingIndex(target.indexPath, binding);
    const liveCandidate = sealPendingIndex(livePending.handle, livePending.tempPath, binding);
    const liveAgain = bindIndexGeneration(target.indexPath, binding);
    expect(() => publishSealedPendingIndex(
      livePending.tempPath,
      target.indexPath,
      binding,
      liveCandidate,
      liveAgain,
      undefined,
      undefined,
      {
        beforeCandidateRename: () => {
          writeFileSync(target.indexPath, "substitute", "utf8");
          writeFileSync(target.indexPath, before);
          const changedAt = new Date(lstatSync(target.indexPath).mtimeMs + 2_000);
          utimesSync(target.indexPath, changedAt, changedAt);
        },
      },
    )).toThrow(IndexInUseError);
    expect(readFileSync(target.indexPath)).toEqual(before);
  });

  it("removes only sidecars created by the failed candidate before restoring the prior namespace", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const before = readFileSync(target.indexPath);
    const binding = bindIndexDirectory(target.indexPath, target.root);
    const pending = createPendingIndex(target.indexPath, binding);

    expect(() => publishPendingIndex(
      pending.handle,
      pending.tempPath,
      target.indexPath,
      binding,
      (publishedPath) => {
        writeFileSync(`${publishedPath}-wal`, "candidate generation", "utf8");
        throw new Error("injected candidate validation failure");
      },
    )).toThrow(IndexInUseError);

    expect(readFileSync(target.indexPath)).toEqual(before);
    expect(existsSync(`${target.indexPath}-wal`)).toBe(false);
    expect(readdirSync(target.root).filter((name) => name.includes(".recovery-") || name.includes(".tmp-")))
      .toEqual([]);
  });

  it("cleans the whole failed candidate namespace on first publication", () => {
    const target = scaffold();
    const binding = bindIndexDirectory(target.indexPath, target.root);
    const pending = createPendingIndex(target.indexPath, binding);

    expect(() => publishPendingIndex(
      pending.handle,
      pending.tempPath,
      target.indexPath,
      binding,
      (publishedPath) => {
        writeFileSync(`${publishedPath}-wal`, "first candidate generation", "utf8");
        throw new Error("injected first-publication validation failure");
      },
    )).toThrow(IndexInUseError);

    expect(existsSync(target.indexPath)).toBe(false);
    expect(existsSync(`${target.indexPath}-wal`)).toBe(false);
    expect(existsSync(`${target.indexPath}-shm`)).toBe(false);
  });

  it("retains the exact recovery generation when restoration itself fails", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const before = readFileSync(target.indexPath);
    const binding = bindIndexDirectory(target.indexPath, target.root);
    const pending = createPendingIndex(target.indexPath, binding);

    expect(() => publishPendingIndex(
      pending.handle,
      pending.tempPath,
      target.indexPath,
      binding,
      () => { throw new Error("injected postvalidation failure"); },
      () => { throw new Error("injected restore failure"); },
    )).toThrow(IndexPublishRecoveryError);

    const recoveries = readdirSync(target.root).filter((name) => name.includes(".recovery-"));
    expect(recoveries).toHaveLength(1);
    expect(readFileSync(join(target.root, recoveries[0]!))).toEqual(before);
  });

  it("refuses publication while the live namespace has a sidecar and preserves every byte", () => {
    const target = scaffold();
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath: target.indexPath });
    const before = readFileSync(target.indexPath);
    const sidecarPath = `${target.indexPath}-wal`;
    writeFileSync(sidecarPath, "owned sidecar", "utf8");
    const binding = bindIndexDirectory(target.indexPath, target.root);
    const pending = createPendingIndex(target.indexPath, binding);

    expect(() => publishPendingIndex(pending.handle, pending.tempPath, target.indexPath, binding))
      .toThrow(IndexInUseError);
    expect(readFileSync(target.indexPath)).toEqual(before);
    expect(readFileSync(sidecarPath, "utf8")).toBe("owned sidecar");
    expect(existsSync(pending.tempPath)).toBe(true);
  });
});
