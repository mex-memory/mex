/**
 * Diagnostics — the wiki engine's single way of reporting a problem.
 *
 * Validators in this layer never throw. A malformed `.mex` file usually has
 * several independent problems, and a user who has to re-run to see the second
 * one is a user who gives up; more importantly the CLI, the agent surface and
 * the future Hub all need a *machine-readable* report carrying a stable code, a
 * location and a suggested fix, which an exception cannot carry. So every check
 * returns `WikiDiagnostic[]` and callers decide what blocks.
 *
 * The code registry is a floor, not a ceiling: it holds the build spec's
 * required minimum plus every code this implementation actually needs. Adding a
 * code when a new check needs one is correct; removing one breaks consumers
 * matching on it, and is guarded by a test.
 */

/**
 * Severity, per build spec §14.4.
 *
 * - `error`   — unsafe or structurally invalid; blocks the affected operation.
 * - `warning` — likely stale, ambiguous or incomplete, but not unsafe.
 * - `info`    — an optional improvement, or knowledge that is simply ungrounded.
 */
export type DiagnosticSeverity = "error" | "warning" | "info";

export const DIAGNOSTIC_SEVERITIES = ["error", "warning", "info"] as const;

/**
 * Where a diagnostic points.
 *
 * **Offsets are UTF-16 code-unit indices into the decoded file text — not byte
 * offsets.** Every position in this engine originates in a Markdown AST, whose
 * offsets index a JavaScript string; the two coincide only for ASCII, and real
 * `.mex` prose is not ASCII. Slicing a Buffer with one of these would corrupt a
 * file the moment a document contains a curly quote or an emoji, so all
 * splicing operates on strings and nothing indexes a Buffer with these values.
 */
export interface DiagnosticLocation {
  /** Path relative to the project root. */
  file?: string;
  /** Inclusive start, in UTF-16 code units. */
  startOffset?: number;
  /** Exclusive end, in UTF-16 code units. */
  endOffset?: number;
  /** 1-based line number. */
  startLine?: number;
  /** 1-based line number. */
  endLine?: number;
}

export interface WikiDiagnostic {
  code: WikiDiagnosticCode;
  severity: DiagnosticSeverity;
  /** Human-readable, specific to this occurrence. */
  message: string;
  /** Path relative to the project root, when the diagnostic belongs to a file. */
  file?: string;
  /** The entity at fault, when known. */
  entityId?: string;
  location?: DiagnosticLocation;
  /**
   * Structural path to the offending value, e.g.
   * `entities[3].relations[1].target`. The Markdown layer maps this back to a
   * source range later; without it a diagnostic about the fourth relation in a
   * file is not actionable.
   */
  path?: string;
  /** What to do about it. Defaults to the registry's remediation for the code. */
  remediation?: string;
}

interface DiagnosticDefinition {
  /** Severity used when a caller does not override it. */
  severity: DiagnosticSeverity;
  /** Default remediation text. */
  remediation: string;
}

/**
 * The code registry.
 *
 * Grouped by the phase that emits each code so it is obvious what is live and
 * what is declared ahead of its implementation. Codes for later phases are
 * declared here deliberately: the vocabulary is a published contract, and
 * consumers should be able to match on a code before the check that emits it
 * ships. A test pins which codes are not yet emitted, and that list can only
 * shrink.
 */
export const WIKI_DIAGNOSTICS = {
  // -- Identity and entity structure -----------------------------------------
  INVALID_ENTITY_ID: {
    severity: "error",
    remediation: "Entity ids use a registered lower-case owner prefix plus 26 upper-case Crockford Base32 characters. Wiki assigns `mx_` ids; Team repositories assign their own prefixes. Do not hand-edit them.",
  },
  DUPLICATE_ENTITY_ID: {
    severity: "error",
    remediation: "Two entities claim one id. Keep the original and let MEX assign a new id to the copy.",
  },
  INVALID_ENTITY_TYPE: {
    severity: "error",
    remediation: "Use a registered entity type, or register the new type through the entity type registry.",
  },
  INVALID_LIFECYCLE_STATE: {
    severity: "error",
    remediation: "Lifecycle is one of in_flight, promoted, deprecated, archived. Grounding health is a separate field.",
  },
  INVALID_REVISION: {
    severity: "error",
    remediation: "Revision is an integer starting at 1 that only ever increases.",
  },
  MISSING_ENTITY_TITLE: {
    severity: "error",
    remediation: "Give the entity a heading, or set an explicit title for a file-level entity.",
  },
  MISSING_REQUIRED_FIELD: {
    severity: "error",
    remediation: "Add the missing field.",
  },
  INVALID_FIELD_TYPE: {
    severity: "error",
    remediation: "Correct the field's type.",
  },
  REVISION_DIVERGED: {
    severity: "info",
    remediation:
      "The file was edited by hand since the last recorded operation. Reconcile to adopt the current text and bump the revision.",
  },

  // -- Relations -------------------------------------------------------------
  INVALID_RELATION_TYPE: {
    severity: "error",
    remediation: "Use one of the registered relation types.",
  },
  INVALID_RELATION_TARGET: {
    severity: "error",
    remediation: "Point the relation at an entity id that exists in the wiki.",
  },
  DUPLICATE_RELATION: {
    severity: "error",
    remediation: "Remove the repeated (source, type, target) triple; one relation carries the meaning.",
  },
  SELF_RELATION: {
    severity: "error",
    remediation: "An entity cannot relate to itself. Point the relation at the other entity.",
  },
  SUPERSESSION_CYCLE: {
    severity: "error",
    remediation: "Break the supersedes cycle — supersession must form a chain, not a loop.",
  },
  CONTRADICTORY_ACTIVE_DECISIONS: {
    severity: "error",
    remediation: "Deprecate the superseded decision, or waive the contradiction explicitly on the relation.",
  },
  INACTIVE_RELATION_TARGET: {
    severity: "warning",
    remediation: "This active entity depends on a deprecated or archived one. Retarget it, or retire the source too.",
  },
  ORPHANED_ENTITY: {
    severity: "info",
    remediation: "A promoted entity with no relations is hard to find. Relate it to a topic or a neighbouring entity.",
  },

  // -- Topics ----------------------------------------------------------------
  UNKNOWN_TOPIC: {
    severity: "error",
    remediation: "Create the topic entity, or point the membership at an existing topic id.",
  },
  AMBIGUOUS_TOPIC_REFERENCE: {
    severity: "error",
    remediation: "Several topics share this name or alias. Use the topic's id instead.",
  },
  INVALID_TOPIC_MEMBER: {
    severity: "error",
    remediation: "Topic membership must reference an entity of type `topic`.",
  },
  TOPIC_CYCLE: {
    severity: "error",
    remediation: "Break the parent-topic cycle; the topic hierarchy must be acyclic.",
  },

  // -- Sources and evidence --------------------------------------------------
  MALFORMED_SOURCE: {
    severity: "error",
    remediation: "Fill in the fields this source kind requires.",
  },
  INVALID_COMMIT_FORMAT: {
    severity: "error",
    remediation: "A commit reference is a hexadecimal SHA of at least 7 characters.",
  },
  DUPLICATE_SOURCE: {
    severity: "warning",
    remediation: "Remove the repeated evidence entry.",
  },
  UNRESOLVED_EXTERNAL_SOURCE: {
    severity: "info",
    remediation:
      "This evidence points outside the repository and has not been resolved. That is legal; it is recorded so it is not mistaken for verified.",
  },

  // -- Grounding -------------------------------------------------------------
  MALFORMED_GROUNDING: {
    severity: "error",
    remediation: "A grounding needs both a code-graph node id and a fingerprint, both produced by the graph.",
  },
  GROUNDING_UNVERIFIED: {
    severity: "error",
    remediation: "Node id and fingerprint must come from live graph output. MEX will not accept caller-supplied values.",
  },
  /**
   * Groundings split between a root `grounds_to` and the file-level `mex` map
   * (#226). Info, because both are read and the root ones belong to the
   * file-level entity; raised to a warning where the two keys ground one node
   * differently, since only the `mex.grounds_to` entry is then in effect.
   */
  GROUNDING_MIXED_SHAPE: {
    severity: "info",
    remediation:
      "Any `mex ground` write or `mex wiki migrate` moves the root `grounds_to` under `mex.grounds_to`. A node grounded differently in both stays at the root until you keep one and delete the other.",
  },

  // -- Operations ------------------------------------------------------------
  INVALID_OPERATION_ENVELOPE: {
    severity: "error",
    remediation: "Correct the operation envelope; it must carry an opId, type, actor and timestamp.",
  },
  UNKNOWN_OPERATION_TYPE: {
    severity: "error",
    remediation: "Use one of the eleven registered operation types.",
  },
  INVALID_OPERATION_PAYLOAD: {
    severity: "error",
    remediation: "Correct the payload for this operation type.",
  },
  REVISION_CONFLICT: {
    severity: "error",
    remediation: "The entity moved on since this operation was planned. Re-read it and retry.",
  },
  CONTENT_HASH_CONFLICT: {
    severity: "error",
    remediation: "The entity's text changed since this operation was planned. Re-read it and retry.",
  },

  // -- Declared for later phases ---------------------------------------------
  WIKI_INDEX_MISSING: {
    severity: "error",
    remediation: "Run `mex wiki rebuild-index`.",
  },
  WIKI_INDEX_REBUILD_REQUIRED: {
    severity: "error",
    remediation: "The index was built by a different schema version. Run `mex wiki rebuild-index`.",
  },
  WIKI_INDEX_FTS5_UNAVAILABLE: {
    severity: "error",
    remediation:
      "The running Node build embeds a SQLite without FTS5, which the wiki index requires. "
      + "Rebuilding cannot fix this — use a different Node build/version. See COMPATIBILITY.md.",
  },
  WIKI_PARSE_ERROR: {
    severity: "error",
    remediation: "Fix the malformed Markdown or entity metadata block. Prose is never deleted to resolve this.",
  },
  UNBOUND_ENTITY_METADATA: {
    severity: "error",
    remediation: "An entity metadata block must be followed by a heading, with only blank lines between.",
  },
  DUPLICATE_ENTITY_METADATA: {
    severity: "error",
    remediation: "Two metadata blocks bind to one heading. Remove one, or give the second its own heading.",
  },
  ENTITY_RANGE_OVERLAP: {
    severity: "error",
    remediation: "Two entities claim overlapping regions of one file. Re-check the heading depths.",
  },
  /**
   * A path in the scaffold resolves outside it.
   *
   * Added in P3 for discovery: a symlink whose target escapes the scaffold root
   * is not followed. The read side has to agree with P5's write-scope rule
   * about what "inside the scaffold" means, and the two disagreeing is its own
   * class of bug — so the boundary is one concept with one code, reported the
   * moment a read notices it rather than only when a write is refused.
   */
  PATH_OUTSIDE_SCAFFOLD: {
    severity: "warning",
    remediation: "Point the link inside the scaffold, or remove it. Files outside the scaffold root are never indexed.",
  },
  ENTITY_NOT_FOUND: {
    severity: "error",
    remediation: "No entity has that id. Check the id, or rebuild the index.",
  },
  GROUNDING_UNRESOLVED: {
    severity: "warning",
    remediation: "The code graph could not resolve this node. Build the graph, or re-ground the entity.",
  },
  GROUNDING_STALE: {
    severity: "warning",
    remediation: "The grounded code changed. Review the entity and re-ground it if it still holds.",
  },
  GROUNDING_MISSING: {
    severity: "warning",
    remediation: "The grounded declaration no longer exists. Re-ground the entity or retire it.",
  },
  SOURCE_FILE_MISSING: {
    severity: "warning",
    remediation: "The file this evidence names is gone. Update or remove the source.",
  },
  ANCHOR_GROUNDING_MISMATCH: {
    severity: "warning",
    remediation: "An inline `mex://` anchor disagrees with the entity's declared grounding. Reconcile the two.",
  },
  AMBIGUOUS_MIGRATION: {
    severity: "warning",
    remediation: "Migration will not guess. Assign this manually, then re-run migration.",
  },
  WRITE_SCOPE_VIOLATION: {
    severity: "error",
    remediation: "The write touched text outside its declared range, or targeted a read-only path. Nothing was written.",
  },
  INDEX_REFRESH_REQUIRED: {
    severity: "warning",
    remediation: "The Markdown write succeeded but the index did not refresh. Run `mex wiki rebuild-index`.",
  },
  MALFORMED_OPERATION_LOG: {
    severity: "warning",
    remediation: "A line in events/operations.jsonl is not valid JSON. The Markdown is unaffected.",
  },
  GENERATED_VIEW_DRIFT: {
    severity: "info",
    remediation: "A generated section no longer matches the index. Regenerate it.",
  },

  // -- Synthesis (§12) --------------------------------------------------------

  /**
   * The agent's response file is not the shape the stage expects.
   *
   * Distinct from every rejection a candidate can collect, and the distinction
   * is the point: a rejected candidate is the quality gate working, and a run
   * that refuses half of what it was given is a healthy run. This says the file
   * could not be read as a response at all, which is a different problem with a
   * different fix, and a caller that cannot tell them apart will read a broken
   * hand-off as a clean run that proposed nothing.
   */
  INVALID_AGENT_RESPONSE: {
    severity: "error",
    remediation:
      "The response must be JSON carrying the array this stage expects — `units`, `actions` or `judgments`. Re-run the stage and save the model's raw JSON output.",
  },
} as const satisfies Record<string, DiagnosticDefinition>;

export type WikiDiagnosticCode = keyof typeof WIKI_DIAGNOSTICS;

/** Every registered code, sorted, for coverage tests and `--help` style output. */
export const WIKI_DIAGNOSTIC_CODES = (Object.keys(WIKI_DIAGNOSTICS) as WikiDiagnosticCode[]).sort();

/**
 * The build spec's §14.4 "minimum codes" list, verbatim.
 *
 * Kept as data so a test can assert it stays a subset of the registry. A code
 * being dropped from the registry is a contract break that would otherwise only
 * surface in whatever consumer was matching on it.
 */
export const SPEC_MINIMUM_DIAGNOSTIC_CODES = [
  "WIKI_INDEX_MISSING",
  "WIKI_INDEX_REBUILD_REQUIRED",
  "WIKI_PARSE_ERROR",
  "DUPLICATE_ENTITY_ID",
  "UNBOUND_ENTITY_METADATA",
  "ENTITY_NOT_FOUND",
  "REVISION_CONFLICT",
  "CONTENT_HASH_CONFLICT",
  "INVALID_RELATION_TYPE",
  "INVALID_RELATION_TARGET",
  "DUPLICATE_RELATION",
  "SUPERSESSION_CYCLE",
  "UNKNOWN_TOPIC",
  "ORPHANED_ENTITY",
  "CONTRADICTORY_ACTIVE_DECISIONS",
  "GROUNDING_UNRESOLVED",
  "GROUNDING_STALE",
  "GROUNDING_MISSING",
  "AMBIGUOUS_MIGRATION",
  "WRITE_SCOPE_VIOLATION",
  "INDEX_REFRESH_REQUIRED",
] as const;

export function isWikiDiagnosticCode(value: unknown): value is WikiDiagnosticCode {
  return typeof value === "string" && Object.hasOwn(WIKI_DIAGNOSTICS, value);
}

/** The registry's default severity for a code. */
export function defaultSeverity(code: WikiDiagnosticCode): DiagnosticSeverity {
  return WIKI_DIAGNOSTICS[code].severity;
}

export interface DiagnosticOptions {
  file?: string;
  entityId?: string;
  location?: DiagnosticLocation;
  path?: string;
  /** Override the registry default, where context changes how bad the problem is. */
  severity?: DiagnosticSeverity;
  /** Override the registry default. */
  remediation?: string;
}

/** Build a diagnostic, defaulting severity and remediation from the registry. */
export function diagnostic(
  code: WikiDiagnosticCode,
  message: string,
  options: DiagnosticOptions = {},
): WikiDiagnostic {
  const definition = WIKI_DIAGNOSTICS[code];
  const result: WikiDiagnostic = {
    code,
    severity: options.severity ?? definition.severity,
    message,
    remediation: options.remediation ?? definition.remediation,
  };
  if (options.file !== undefined) result.file = options.file;
  if (options.entityId !== undefined) result.entityId = options.entityId;
  if (options.location !== undefined) result.location = options.location;
  if (options.path !== undefined) result.path = options.path;
  return result;
}

/** True when any diagnostic is severe enough to block an operation. */
export function hasBlockingDiagnostic(diagnostics: readonly WikiDiagnostic[]): boolean {
  return diagnostics.some((entry) => entry.severity === "error");
}

/**
 * Stable ordering for reporting: worst first, then by file, position, code.
 *
 * Deterministic output is a testability requirement across the whole engine —
 * the CLI's JSON envelope and the golden fixtures both depend on two runs over
 * the same input producing the same text.
 */
export function sortDiagnostics(diagnostics: readonly WikiDiagnostic[]): WikiDiagnostic[] {
  const rank: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };
  return [...diagnostics].sort((left, right) => {
    if (rank[left.severity] !== rank[right.severity]) return rank[left.severity] - rank[right.severity];
    const leftFile = left.file ?? left.location?.file ?? "";
    const rightFile = right.file ?? right.location?.file ?? "";
    if (leftFile !== rightFile) return leftFile < rightFile ? -1 : 1;
    const leftOffset = left.location?.startOffset ?? Number.MAX_SAFE_INTEGER;
    const rightOffset = right.location?.startOffset ?? Number.MAX_SAFE_INTEGER;
    if (leftOffset !== rightOffset) return leftOffset - rightOffset;
    if (left.code !== right.code) return left.code < right.code ? -1 : 1;
    const leftPath = left.path ?? "";
    const rightPath = right.path ?? "";
    return leftPath === rightPath ? 0 : leftPath < rightPath ? -1 : 1;
  });
}
