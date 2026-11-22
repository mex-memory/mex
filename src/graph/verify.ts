// The full-rebuild check (graph-02): a fresh build of a checkout's current
// files must give the same rows, file by file, as its base plus overlay. A
// difference means incremental publication (warm or cold) drifted from what a
// build produces; the warm path then turns off for the repository until a
// later check matches.

import { openSqlite } from "./db/sqlite.js";
import { readsV5Graph, v5Rows } from "./db/v5.js";
import { prepareNativeGraphBuild } from "./native-build.js";
import { openGraphFile } from "./overlay-open.js";
import { withSourceMemo } from "./source-memo.js";
import { inspectGraphStatus } from "./status.js";
import { currentGraphPath, discardGraphTemporary, graphLocation, graphTemporary } from "./storage.js";
import { writeGraphState } from "./jobs.js";

export type GraphVerifyOutcome =
  | { status: "skipped"; reason: string; files: number }
  | { status: "match"; files: number }
  | { status: "differ"; files: number; differing: string[] };

/** Per file: its row digest and the columns that identify its content. */
const FILE_ROWS = `SELECT f.path, d.digest, f.content_hash, f.parse_status, c.reason AS coverage
  FROM files f LEFT JOIN file_row_digests d ON d.path = f.path LEFT JOIN coverage c ON c.path = f.path`;

function rowsOf(db: ReturnType<typeof openSqlite>): Map<string, string> {
  const sql = readsV5Graph(db) ? `SELECT f.path, hex(d.digest) AS digest, hex(f.content_hash) AS content_hash,
    f.parse_status, c.reason AS coverage
    FROM ${v5Rows(db, "files")} f LEFT JOIN ${v5Rows(db, "file_resolution")} d ON d.file = f.id
    LEFT JOIN main.coverage c ON c.path = f.path` : FILE_ROWS;
  return new Map((db.prepare(sql).all() as Array<{ path: string; digest: string | null; content_hash: string; parse_status: string; coverage: string | null }>)
    .map((row) => [row.path, JSON.stringify([row.digest, row.content_hash, row.parse_status, row.coverage])]));
}

export async function verifyGraph(root: string, options: { now?: Date; afterBuild?: (candidate: string) => void } = {}): Promise<GraphVerifyOutcome> {
  const location = graphLocation(root);
  const status = await inspectGraphStatus({ projectRoot: root });
  // Only a graph that describes the files as they are can be compared with a build of them.
  if (status.status !== "fresh") return { status: "skipped", reason: `the graph is ${status.status}`, files: 0 };
  const live = currentGraphPath(root);
  let current: ReturnType<typeof openSqlite>;
  try { current = openGraphFile(live); }
  catch { return { status: "skipped", reason: "the checkout has no graph", files: 0 }; }
  const native = readsV5Graph(current);
  let published: Map<string, string>;
  try {
    if (native && !current.prepare("SELECT 1 FROM main.sqlite_schema WHERE name = 'file_resolution'").get()) {
      return { status: "skipped", reason: "the graph predates v5 resolution digests", files: 0 };
    }
    published = rowsOf(current);
  } finally { current.close(); }

  // The fresh build goes into a private temporary graph file beside the published ones.
  const candidate = graphTemporary(location);
  try {
    if (native) {
      const built = await withSourceMemo(async () => {
        const capture = await prepareNativeGraphBuild(root);
        if (!capture) return false;
        try {
          await capture.build(candidate, {});
          capture.assertInputsUnchanged();
          return true;
        } finally { capture.dispose(); }
      });
      if (!built) return { status: "skipped", reason: "v5 is unavailable for the current corpus", files: 0 };
    } else {
      const { runGraphCandidateProcess } = await import("./candidate-process.js");
      await runGraphCandidateProcess({ projectRoot: root, candidatePath: candidate, operation: "rebuild" });
    }
    options.afterBuild?.(candidate);
    if (currentGraphPath(root) !== live) return { status: "skipped", reason: "the graph changed during verification", files: 0 };
    const fresh = openGraphFile(candidate);
    let built: Map<string, string>;
    try { built = rowsOf(fresh); } finally { fresh.close(); }
    const differing = [...new Set([...published.keys(), ...built.keys()])]
      .filter((path) => published.get(path) !== built.get(path))
      .sort();
    const checkedAt = (options.now ?? new Date()).toISOString();
    const schemaVersion = native ? 5 : 4;
    if (differing.length > 0) {
      writeGraphState(location.directory, { version: 1, warm: "off", checkedAt, schemaVersion, checkout: root, differing: differing.slice(0, 200) });
      return { status: "differ", files: built.size, differing };
    }
    writeGraphState(location.directory, { version: 1, warm: "on", checkedAt, schemaVersion, checkout: root });
    return { status: "match", files: built.size };
  } finally {
    discardGraphTemporary(candidate);
  }
}
