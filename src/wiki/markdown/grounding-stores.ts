/**
 * One file, two places a grounding can live, and the single rule for reading both (#226).
 *
 * A pre-wiki scaffold keeps `grounds_to` as a root frontmatter key. Once a file
 * is adopted as a wiki entity its metadata is the `mex:` map, and groundings
 * belong at `mex.grounds_to`. Setup used to leave both behind: population wrote
 * root groundings, and migration then added a `mex:` map to a multi-entity file
 * without moving them. Reading only one key made the other invisible — `mex
 * check` skipped the root entries and `wiki for-code` dropped them — which is
 * the silent loss of committed groundings the issue calls the one outcome to
 * avoid.
 *
 * So readers take the **union**, deduplicated by node. Where both keys carry
 * the same node with a different `fingerprint` or `bodyHash`, nothing here
 * guesses which one the author meant: the `mex.grounds_to` entry is the one
 * returned, because it is the store every writer maintains, and the node is
 * reported as a conflict so `mex check` and `wiki validate` can say so.
 *
 * Writers keep one store: they move the root entries under `mex.grounds_to`
 * and remove the root key. A root entry that was not in effect is the
 * exception — a conflicting one, or one the reader could not accept. No writer
 * can claim to have carried it forward, and deleting it would settle the
 * question by fiat. It stays at the root, and the diagnostic stays with it,
 * until a person resolves it.
 *
 * Kept free of any parser so the drift reader (`src/markdown.ts`) and the wiki
 * codec apply exactly the same rule — two copies of it would be two stores of
 * one rule.
 */

interface GroundingLike {
  node: string;
  fingerprint: string;
  bodyHash?: string;
}

export interface GroundingStores<T extends GroundingLike> {
  /** `mex.grounds_to` entries, then root entries for nodes it does not carry. */
  merged: T[];
  /** Root entries that carry a node `mex.grounds_to` also carries, differently. */
  conflicts: T[];
}

/** Same node with different identity or change evidence. */
function differs(left: GroundingLike, right: GroundingLike): boolean {
  return left.fingerprint !== right.fingerprint || left.bodyHash !== right.bodyHash;
}

/** Merge the two stores under the rule above. Order: `mex` first, then root. */
export function mergeGroundingStores<T extends GroundingLike>(
  mex: readonly T[],
  root: readonly T[],
): GroundingStores<T> {
  const byNode = new Map<string, T>();
  for (const entry of mex) if (!byNode.has(entry.node)) byNode.set(entry.node, entry);
  const merged = [...mex];
  const conflicts: T[] = [];
  const seen = new Set(mex.map((entry) => entry.node));
  for (const entry of root) {
    const existing = byNode.get(entry.node);
    if (existing !== undefined) {
      if (differs(existing, entry)) conflicts.push(entry);
      continue;
    }
    if (seen.has(entry.node)) continue;
    seen.add(entry.node);
    merged.push(entry);
  }
  return { merged, conflicts };
}

/**
 * The root entries a consolidating write must leave at the root: every one
 * that was **not in effect** before the write — a conflict the `mex.grounds_to`
 * entry shadowed, or an entry the reader could not accept. No writer carried
 * those forward, so removing them would delete an authored claim rather than
 * move it.
 *
 * Measured against the groundings in effect **before** the write, not after,
 * because a write that updates a root-sourced entry's fingerprint is carrying
 * that entry forward, not disagreeing with it.
 */
export function rootGroundingsNotInEffect<T extends GroundingLike>(
  inEffect: readonly GroundingLike[],
  root: readonly T[],
): T[] {
  return root.filter((entry) => !inEffect.some((effective) => effective.node === entry.node && !differs(effective, entry)));
}
