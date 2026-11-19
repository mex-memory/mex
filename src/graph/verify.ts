// The full-rebuild check (graph-02): a fresh build of a checkout's current
// files must give the same rows, file by file, as its base plus overlay. A
// difference means incremental publication (warm or cold) drifted from what a
// build produces; the warm path then turns off for the repository until a
// later check matches.

import { openSqlite } from "./db/sqlite.js";
import { openGraphRead } from "./overlay-open.js";
import { inspectGraphStatus } from "./status.js";
import { discardGraphTemporary, graphLocation, graphTemporary } from "./storage.js";
import { writeGraphState } from "./jobs.js";

export type GraphVerifyOutcome =
  | { status: "skipped"; reason: string; files: number }
  | { status: "match"; files: number }
  | { status: "differ"; files: number; differing: string[] };

/** Per file: its row digest and the columns that identify its content. */
const FILE_ROWS = `SELECT f.path, d.digest, f.content_hash, f.parse_status, c.reason AS coverage
  FROM files f LEFT JOIN file_row_digests d ON d.path = f.path LEFT JOIN coverage c ON c.path = f.path`;

function rowsOf(db: ReturnType<typeof openSqlite>): Map<string, string> {
  return new Map((db.prepare(FILE_ROWS).all() as Array<{ path: string; digest: string | null; content_hash: string; parse_status: string; coverage: string | null }>)
    .map((row) => [row.path, JSON.stringify([row.digest, row.content_hash, row.parse_status, row.coverage])]));
}

export async function verifyGraph(root: string, options: { now?: Date; afterBuild?: (candidate: string) => void } = {}): Promise<GraphVerifyOutcome> {
  const location = graphLocation(root);
  const status = await inspectGraphStatus({ projectRoot: root });
  // Only a graph that describes the files as they are can be compared with a build of them.
  if (status.status !== "fresh") return { status: "skipped", reason: `the graph is ${status.status}`, files: 0 };
  const current = openGraphRead(root);
  if (!current) return { status: "skipped", reason: "the checkout has no graph", files: 0 };
  let published: Map<string, string>;
  try { published = rowsOf(current); } finally { current.close(); }

  // The fresh build goes into a private temporary graph file beside the published ones.
  const candidate = graphTemporary(location);
  try {
    const { runGraphCandidateProcess } = await import("./candidate-process.js");
    await runGraphCandidateProcess({ projectRoot: root, candidatePath: candidate, operation: "rebuild" });
    options.afterBuild?.(candidate);
    const fresh = openSqlite(candidate, { readOnly: true });
    let built: Map<string, string>;
    try { built = rowsOf(fresh); } finally { fresh.close(); }
    const differing = [...new Set([...published.keys(), ...built.keys()])]
      .filter((path) => published.get(path) !== built.get(path))
      .sort();
    const checkedAt = (options.now ?? new Date()).toISOString();
    if (differing.length > 0) {
      writeGraphState(location.directory, { version: 1, warm: "off", checkedAt, checkout: root, differing: differing.slice(0, 200) });
      return { status: "differ", files: built.size, differing };
    }
    writeGraphState(location.directory, { version: 1, warm: "on", checkedAt, checkout: root });
    return { status: "match", files: built.size };
  } finally {
    discardGraphTemporary(candidate);
  }
}
