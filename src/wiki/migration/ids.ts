/**
 * Section 13.3 — ids at apply, and the operation ids that make a re-run a no-op.
 *
 * ## The `opId` is the whole idempotency story
 *
 * P5's replay is keyed on `opId`: an operation whose id already carries a
 * completion line in `.mex/events/operations.jsonl` is a no-op that reports
 * what the original did. So a migration that minted a fresh random `opId` per
 * run would find no record of anything, migrate every file a second time, and
 * break section 20.6's "repeated apply does not generate new IDs" **quietly** —
 * every individual operation behaving correctly the whole way down.
 *
 * So an `opId` is derived from the work it describes: the operation type, the
 * scaffold-relative path, and a stable anchor for the target. Re-run over the
 * same scaffold and the same ids come back out.
 *
 * ## What the anchor has to survive
 *
 * The first run **inserts bytes above later headings**. So the anchor cannot be
 * a byte offset, and it cannot be a heading ordinal taken after the fact
 * either — safest to key on what a reader would key on: the heading's text,
 * plus which occurrence of that text it is within the file. Two headings
 * reading "Verify" in one file get different anchors; the same heading before
 * and after an unrelated insertion gets the same one.
 *
 * ## And what the payload has to survive
 *
 * The same `opId` carrying a *different* payload is a validation failure in P5,
 * by design. That is the right failure — but it must not be reachable from an
 * ordinary re-run, so every payload migration builds has to be byte-stable:
 * no timestamps, no absolute paths, no set-iteration order. The one field that
 * legitimately differs between runs is the minted entity id, and that is not in
 * the payload — the planner mints it, and the audit log's intent line is what
 * hands it back to a resumed run.
 */
import { createHash } from "node:crypto";
import type { WikiOperationType } from "../model/operation.js";
import type { AdoptionTarget, Candidate } from "./classify.js";
import type { InventoryFile } from "./inventory.js";

/**
 * A target's stable name within its file.
 *
 * `f` for the file itself. `h:<occurrence>:<text>` for a heading, where the
 * occurrence disambiguates two headings that read the same.
 */
export function anchorOf(file: InventoryFile, target: AdoptionTarget): string {
  if (target.at === "file") return "f";
  let occurrence = 0;
  for (let index = 0; index < target.ordinal; index += 1) {
    if (file.headings[index]?.title === target.text) occurrence += 1;
  }
  return `h:${occurrence}:${target.text}`;
}

/**
 * The operation id for one unit of migration work.
 *
 * The fields are separated by U+0000, which cannot occur in an operation type,
 * a scaffold-relative path or a heading's text, so no two different units can
 * render to the same input. **Written as the unicode escape, never as a literal
 * byte** — a raw NUL makes the file binary to Git, which costs the diff, the
 * line-ending normalization and any future three-way merge (finding 45).
 */
export function migrationOpId(type: WikiOperationType, file: string, anchor: string): string {
  const digest = createHash("sha256").update(`mex-migration\u0000${type}\u0000${file}\u0000${anchor}`, "utf8").digest("hex");
  return `mig_${digest.slice(0, 40)}`;
}

/** The `opId` for adopting one classified candidate. */
export function opIdForCandidate(file: InventoryFile, candidate: Candidate): string {
  return migrationOpId("create-entry", candidate.file, anchorOf(file, candidate.target));
}

/**
 * The `opId` for adding one converted legacy edge as a relation.
 *
 * Keyed on the edge's own target path rather than on the entity id it resolved
 * to, because the entity id is minted by this same run: keying on it would make
 * the `opId` depend on something that did not exist when the work was decided,
 * and a re-run against a scaffold whose ids were minted in a different order
 * would compute different ids for the same edges.
 */
export function opIdForEdge(sourceFile: string, edgeTarget: string, index: number): string {
  return migrationOpId("add-relation", sourceFile, `e:${index}:${edgeTarget}`);
}

/**
 * The `opId` for folding a file's root `grounds_to` into its existing
 * file-level entity (#226).
 *
 * Keyed on the groundings moved as well as the file. Once applied the root key
 * is gone and nothing is planned again; if someone later writes a new root
 * `grounds_to` into the same file, that is new work with a different payload,
 * and reusing the old `opId` for it would be refused as a replay mismatch.
 */
export function opIdForRootGroundings(file: string, groundings: readonly unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify(groundings), "utf8").digest("hex");
  return migrationOpId("set-grounding", file, `r:${digest.slice(0, 16)}`);
}
