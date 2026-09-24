import type { WikiDiagnosticCode } from "../../model/diagnostic.js";

/**
 * The oracle: what parsing each fixture must yield.
 *
 * **Hand-derived, not generated.** Nothing here was produced by running a
 * parser — the parser does not exist. An expectation generated from an
 * implementation is a change-detector, not a test.
 *
 * Ranges are expressed as **anchors into the fixture text** rather than as bare
 * numbers: `headingLine` is the exact heading text, `bodyEndsBefore` names the
 * text the body stops in front of. The test resolves them to offsets with
 * `indexOf`, which measures the fixture rather than consulting a parser, and
 * keeps the expectations readable and reviewable. An off-by-one shows up as a
 * wrong slice, which is legible, instead of as two numbers that differ by one.
 *
 * The fixtures that exist specifically to catch encoding errors additionally
 * carry `exact` absolute offsets, because that is precisely where an off-by-N
 * hides and where a relative assertion could agree with a wrong parser.
 */

/** Where a body stops. */
export type BodyEnd =
  /** Runs to end of file. */
  | { at: "eof" }
  /** Stops immediately before this text, searched from the body start. */
  | { at: "before"; text: string };

export interface ExactRanges {
  metadataStart: number;
  metadataEnd: number;
  headingStart: number;
  headingEnd: number;
  bodyStart: number;
  bodyEnd: number;
}

export interface ExpectedEntity {
  id: string;
  type: string;
  status: string;
  /** Derived from the bound heading, without the `#` markers. */
  title: string;
  /** 1-6; 0 for a file-level entity with no bound heading. */
  headingDepth: number;
  metadataKind: "frontmatter" | "comment";
  /**
   * Unique text the metadata range starts with. For a comment this is the
   * opening delimiter plus the id line; for frontmatter, the `mex` key.
   */
  metadataStartsWith: string;
  /** Text the metadata range stops before, searched from the metadata start. */
  metadataEndsBefore: string;
  /** The exact heading line including its terminator. Empty for no heading. */
  headingLine: string;
  bodyEnds: BodyEnd;
  /** Absolute offsets, for the fixtures where the numbers are the point. */
  exact?: ExactRanges;
}

export interface ExpectedAnchor {
  nodeId: string;
  /** Id of the containing entity, or null when the anchor sits outside them all. */
  entityId: string | null;
}

export interface FixtureExpectation {
  /** Path relative to `test/fixtures/wiki`. */
  path: string;
  /** What this fixture proves. Read this first when it fails. */
  note: string;
  /** Case numbers from the brief's §4 that this fixture covers. */
  covers: number[];
  entities: ExpectedEntity[];
  /** Diagnostic codes the file must produce, in no particular order. */
  diagnostics: WikiDiagnosticCode[];
  anchors?: ExpectedAnchor[];
  /** Counts of legacy root-level fields that must survive being read. */
  legacy?: { groundsTo: number; edges: number };
}

const ID1 = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const ID2 = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const NODE = "function:a3f8c21d9e4b7f60a1c2d3e4f5061728";
const NODE2 = "function:b7e1d4a2c8f30596e1a2b3c4d5e6f708";

/** A comment metadata block's opening anchor. */
function comment(id: string): string {
  return `<!-- mex:entity\nid: ${id}`;
}

export const FIXTURE_EXPECTATIONS: FixtureExpectation[] = [
  // ---------------------------------------------------------------- structure
  {
    path: "structure/file-entity.md",
    note: "One entity for a whole file, with pre-existing frontmatter keys that must survive untouched.",
    covers: [1],
    entities: [
      {
        id: ID1,
        type: "pattern",
        status: "promoted",
        title: "API error handling",
        headingDepth: 1,
        metadataKind: "frontmatter",
        metadataStartsWith: `mex:\n  id: ${ID1}`,
        metadataEndsBefore: "\n---\n",
        headingLine: "# API error handling\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
  },
  {
    path: "structure/multi-entity.md",
    note: "Two sibling block entities: the first must end exactly where the second's metadata begins, not where its heading does.",
    covers: [2, 5],
    entities: [
      {
        id: ID1,
        type: "decision",
        status: "promoted",
        title: "Rotate refresh tokens",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Rotate",
        headingLine: "## Rotate refresh tokens\n",
        bodyEnds: { at: "before", text: comment(ID2) },
      },
      {
        id: ID2,
        type: "decision",
        status: "in_flight",
        title: "Cache session lookups",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID2),
        metadataEndsBefore: "\n## Cache",
        headingLine: "## Cache session lookups\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
  },
  {
    path: "structure/mixed-entities.md",
    note: "A file-level entity containing a block entity. The file entity's body must stop at the block's metadata — the partition forces this, and the original spec's depth-only rule does not cover it.",
    covers: [3],
    entities: [
      {
        id: ID1,
        type: "architecture",
        status: "promoted",
        title: "System architecture",
        headingDepth: 1,
        metadataKind: "frontmatter",
        metadataStartsWith: `mex:\n  id: ${ID1}`,
        metadataEndsBefore: "\n---\n",
        headingLine: "# System architecture\n",
        bodyEnds: { at: "before", text: comment(ID2) },
      },
      {
        id: ID2,
        type: "component",
        status: "promoted",
        title: "Gateway",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID2),
        metadataEndsBefore: "\n## Gateway",
        headingLine: "## Gateway\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
  },
  {
    path: "structure/nested-headings.md",
    note: "Deeper headings belong to the body. A ### and a #### under a ## entity are its content, not siblings.",
    covers: [4],
    entities: [
      {
        id: ID1,
        type: "guide",
        status: "promoted",
        title: "Local setup",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Local setup",
        headingLine: "## Local setup\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
  },
  {
    path: "structure/final-entity-no-newline.md",
    note: "A body running to EOF with no trailing newline. The commonest off-by-one, and the partition catches it.",
    covers: [6],
    entities: [
      {
        id: ID1,
        type: "fact",
        status: "promoted",
        title: "Ends at EOF",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Ends at EOF",
        headingLine: "## Ends at EOF\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
  },
  {
    path: "structure/prose-around-entities.md",
    note: "Prose before the first entity and after the last belongs to no entity, and must appear as gaps rather than being absorbed.",
    covers: [7],
    entities: [
      {
        id: ID1,
        type: "convention",
        status: "promoted",
        title: "Name things plainly",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Name things",
        headingLine: "## Name things plainly\n",
        // Ends at the shallower "# Appendix", not at EOF.
        bodyEnds: { at: "before", text: "# Appendix" },
      },
    ],
    diagnostics: [],
  },
  {
    path: "structure/no-entities.md",
    note: "Ordinary Markdown with no entity metadata: no entities, no diagnostics, and the whole file is one gap.",
    covers: [8],
    entities: [],
    diagnostics: [],
  },
  {
    path: "structure/empty.md",
    note: "An empty file must parse to nothing rather than crashing, and its (empty) partition must hold.",
    covers: [9],
    entities: [],
    diagnostics: [],
  },
  {
    path: "structure/frontmatter-only.md",
    note: "Frontmatter with no mex key and no body.",
    covers: [9],
    entities: [],
    diagnostics: [],
  },

  // -------------------------------------------------------------- adversarial
  {
    path: "adversarial/fenced-metadata.md",
    note: "HARD: metadata inside a fenced block is content. Also covers fences containing --- and ## lines. Exactly one entity — the real one.",
    covers: [10, 12, 13],
    entities: [
      {
        id: ID1,
        type: "guide",
        status: "promoted",
        title: "Documenting the metadata format",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Documenting",
        headingLine: "## Documenting the metadata format\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
  },
  {
    path: "adversarial/indented-metadata.md",
    note: "HARD: metadata inside a four-space indented code block is content.",
    covers: [11],
    entities: [
      {
        id: ID1,
        type: "guide",
        status: "promoted",
        title: "Indented code is content",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Indented code",
        headingLine: "## Indented code is content\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
  },
  {
    path: "adversarial/setext-headings.md",
    note: "Setext headings are real headings with real depths. The --- underline is neither a thematic break nor a frontmatter delimiter, and the heading range covers both lines.",
    covers: [14],
    entities: [
      {
        id: ID1,
        type: "decision",
        status: "promoted",
        title: "Setext level one",
        headingDepth: 1,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\nSetext level one",
        headingLine: "Setext level one\n================\n",
        bodyEnds: { at: "before", text: comment(ID2) },
      },
      {
        id: ID2,
        type: "decision",
        status: "promoted",
        title: "Setext level two",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID2),
        metadataEndsBefore: "\nSetext level two",
        headingLine: "Setext level two\n----------------\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
  },
  {
    path: "adversarial/non-ascii.md",
    note: "HARD: accented Latin, curly quotes, an en-dash, an astral emoji (a surrogate pair, two UTF-16 units) and CJK, placed before the entity so its offsets depend on encoding. 294 UTF-16 units vs 351 UTF-8 bytes: a byte-oriented parser is off by 57 here.",
    covers: [15],
    entities: [
      {
        id: ID1,
        type: "decision",
        status: "promoted",
        title: "Naïve résumé handling",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Naïve",
        headingLine: "## Naïve résumé handling\n",
        bodyEnds: { at: "eof" },
        exact: {
          metadataStart: 110,
          metadataEnd: 207,
          headingStart: 208,
          headingEnd: 233,
          bodyStart: 233,
          bodyEnd: 294,
        },
      },
    ],
    diagnostics: [],
  },
  {
    path: "adversarial/crlf.md",
    note: "CRLF throughout. Every line terminator is two UTF-16 units, so offsets differ from the LF equivalent and the original endings must survive a write.",
    covers: [16],
    entities: [
      {
        id: ID1,
        type: "decision",
        status: "promoted",
        title: "CRLF throughout",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: "<!-- mex:entity\r\nid: " + ID1,
        metadataEndsBefore: "\r\n## CRLF",
        headingLine: "## CRLF throughout\r\n",
        bodyEnds: { at: "eof" },
        exact: {
          metadataStart: 0,
          metadataEnd: 102,
          headingStart: 104,
          headingEnd: 124,
          bodyStart: 124,
          bodyEnd: 197,
        },
      },
    ],
    diagnostics: [],
  },
  {
    path: "adversarial/bom.md",
    note: "A UTF-8 BOM shifts every offset by exactly one UTF-16 unit. A parser that strips it before measuring reports offsets that no longer index the file it was given.",
    covers: [17],
    entities: [
      {
        id: ID1,
        type: "decision",
        status: "promoted",
        title: "Byte order mark",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Byte order",
        headingLine: "## Byte order mark\n",
        bodyEnds: { at: "eof" },
        exact: {
          metadataStart: 1,
          metadataEnd: 98,
          headingStart: 99,
          headingEnd: 118,
          bodyStart: 118,
          bodyEnd: 200,
        },
      },
    ],
    diagnostics: [],
  },
  {
    path: "adversarial/spacing.md",
    note: "Several blank lines between metadata and heading are legal; a paragraph between them is not, and leaves the metadata unbound rather than binding to the heading past it.",
    covers: [18],
    entities: [
      {
        id: ID1,
        type: "decision",
        status: "promoted",
        title: "Blank lines are fine",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n\n\n## Blank lines",
        headingLine: "## Blank lines are fine\n",
        bodyEnds: { at: "before", text: comment(ID2) },
      },
    ],
    diagnostics: ["UNBOUND_ENTITY_METADATA"],
  },
  {
    path: "adversarial/html-blocks.md",
    note: "An ordinary HTML comment, a real HTML block, and a near-miss marker (mex:entitynot) are all content.",
    covers: [19],
    entities: [
      {
        id: ID1,
        type: "guide",
        status: "promoted",
        title: "Genuine HTML nearby",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Genuine HTML",
        headingLine: "## Genuine HTML nearby\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
  },

  // ---------------------------------------------------------------- malformed
  {
    path: "malformed/bad-frontmatter-yaml.md",
    note: "Malformed frontmatter YAML: a parse diagnostic, no entity, and the prose still intact.",
    covers: [20],
    entities: [],
    diagnostics: ["WIKI_PARSE_ERROR"],
  },
  {
    path: "malformed/bad-comment-yaml.md",
    note: "Malformed YAML inside a mex:entity comment. Diagnose; do not crash, and do not lose the heading or the prose.",
    covers: [21],
    entities: [],
    diagnostics: ["WIKI_PARSE_ERROR"],
  },
  {
    path: "malformed/unbound-metadata.md",
    note: "Metadata with no heading after it before EOF is unbound — a diagnostic, never a guess at some earlier heading.",
    covers: [22],
    entities: [],
    diagnostics: ["UNBOUND_ENTITY_METADATA"],
  },
  {
    path: "malformed/double-bound-metadata.md",
    note: "Two metadata blocks competing for one heading. Neither may silently win.",
    covers: [23],
    entities: [],
    diagnostics: ["DUPLICATE_ENTITY_METADATA"],
  },
  {
    path: "malformed/duplicate-id-a.md",
    note: "Half of a cross-file duplicate id. Alone it is valid; the duplicate is only visible across files, which is why uniqueness is scaffold-wide.",
    covers: [24],
    entities: [
      {
        id: ID1,
        type: "decision",
        status: "promoted",
        title: "First claimant",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## First claimant",
        headingLine: "## First claimant\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
  },
  {
    path: "malformed/duplicate-id-b.md",
    note: "The other half. Parsed alone it is also valid; DUPLICATE_ENTITY_ID belongs to the scaffold-wide check, not to either file.",
    covers: [24],
    entities: [
      {
        id: ID1,
        type: "decision",
        status: "promoted",
        title: "Second claimant",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Second claimant",
        headingLine: "## Second claimant\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
  },
  {
    path: "malformed/merge-conflict.md",
    note: "Conflict markers are prose to Markdown. The entity still parses and no content is lost; the markers survive verbatim for the human to resolve.",
    covers: [25],
    entities: [
      {
        id: ID1,
        type: "decision",
        status: "promoted",
        title: "Survived a bad merge",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Survived",
        headingLine: "## Survived a bad merge\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
  },
  {
    path: "malformed/explicit-null.md",
    note: "Added beyond the brief: YAML distinguishes an absent key from one set to null, and the model's optional() rejects the second. A parser that maps null to undefined would silently accept it.",
    covers: [],
    entities: [],
    diagnostics: ["WIKI_PARSE_ERROR"],
  },

  // ------------------------------------------------------------------- legacy
  {
    path: "legacy/grounds-to-single.md",
    note: "A root-level grounds_to beside the file-level mex key: unambiguous, preserved, attached to the file-level entity, and reported as a split store (#226).",
    covers: [26],
    entities: [
      {
        id: ID1,
        type: "pattern",
        status: "promoted",
        title: "Token rotation",
        headingDepth: 1,
        metadataKind: "frontmatter",
        metadataStartsWith: `mex:\n  id: ${ID1}`,
        metadataEndsBefore: "\n---\n",
        headingLine: "# Token rotation\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: ["GROUNDING_MIXED_SHAPE"],
    legacy: { groundsTo: 1, edges: 0 },
  },
  {
    path: "legacy/grounds-to-multi.md",
    note: "The same field on a multi-entity file is genuinely ambiguous. It must be preserved and left unattributed — assigning it to a section would be a guess.",
    covers: [27],
    entities: [
      {
        id: ID1,
        type: "component",
        status: "promoted",
        title: "Gateway",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Gateway",
        headingLine: "## Gateway\n",
        bodyEnds: { at: "before", text: comment(ID2) },
      },
      {
        id: ID2,
        type: "component",
        status: "promoted",
        title: "Worker",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID2),
        metadataEndsBefore: "\n## Worker",
        headingLine: "## Worker\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
    legacy: { groundsTo: 1, edges: 0 },
  },
  {
    path: "legacy/edges-with-condition.md",
    note: "Legacy edges with and without a condition, read but not interpreted.",
    covers: [28],
    entities: [
      {
        id: ID1,
        type: "guide",
        status: "promoted",
        title: "Authentication",
        headingDepth: 1,
        metadataKind: "frontmatter",
        metadataStartsWith: `mex:\n  id: ${ID1}`,
        metadataEndsBefore: "\n---\n",
        headingLine: "# Authentication\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
    legacy: { groundsTo: 0, edges: 2 },
  },
  {
    path: "legacy/inline-anchors.md",
    note: "Inline mex:// anchors inside an entity body and outside every entity. The outside one must be reported with a null entity rather than attached to the nearest.",
    covers: [29],
    entities: [
      {
        id: ID1,
        type: "decision",
        status: "promoted",
        title: "Rotation",
        headingDepth: 2,
        metadataKind: "comment",
        metadataStartsWith: comment(ID1),
        metadataEndsBefore: "\n## Rotation",
        headingLine: "## Rotation\n",
        bodyEnds: { at: "eof" },
      },
    ],
    diagnostics: [],
    anchors: [
      { nodeId: NODE, entityId: null },
      { nodeId: NODE2, entityId: ID1 },
    ],
  },
];

/**
 * The realistic scaffold, checked as a set rather than file by file.
 *
 * It exists to catch what isolated fixtures cannot: interactions, ordinary prose
 * that happens to look structural, generated-section markers, and a topic
 * entity that other files reference by id.
 */
export const SCAFFOLD_FIXTURE = {
  root: "scaffold",
  note: "A small but realistic .mex scaffold: bootstrap, router with a generated block, multi-entity context files, patterns, a generated index and a topic.",
  covers: [30],
  files: [
    "AGENTS.md",
    "ROUTER.md",
    "context/architecture.md",
    "context/conventions.md",
    "context/decisions.md",
    "patterns/INDEX.md",
    "patterns/api-errors.md",
    "topics/authentication.md",
  ],
  /** Every entity id the scaffold declares, so none is silently dropped. */
  entityIds: [
    "mx_01KQS7NZJ01XRTQHM8SEYB446Y",
    "mx_01KQVXGJ60VSKPKQ4H1GJ2S0CB",
    "mx_01KQYKB4T0FC6RE3HSRDJ4AVAH",
    "mx_01KR195QE08J72KRAYJSXW9CCT",
    "mx_01KR3Z0A20R4MWJHNSHJJ2ZJ1R",
    "mx_01KR6MTWP0C0HHBN2WXC06REXC",
    "mx_01KR9ANFA0C9Q0Z5WSGRHGVSFE",
    "mx_01KRC0G1Y0B27EG9PJMQMMD3RE",
  ],
  /** AGENTS.md carries no mex metadata at all and must yield no entity. */
  filesWithoutEntities: ["AGENTS.md"],
} as const;

/**
 * Resolve an expectation's anchors to absolute offsets against the fixture text.
 *
 * This measures the fixture, not a parser — it is `indexOf` over text the
 * expectation already names. That keeps the oracle independent of the
 * implementation while making the expectations readable, and it means a typo in
 * an anchor fails as "not found" rather than as a wrong number.
 */
export function resolveExpectedRanges(text: string, expected: ExpectedEntity): ExactRanges {
  const metadataStart = text.indexOf(expected.metadataStartsWith);
  if (metadataStart < 0) {
    throw new Error(`metadataStartsWith not found: ${JSON.stringify(expected.metadataStartsWith)}`);
  }

  const metadataEnd = text.indexOf(expected.metadataEndsBefore, metadataStart);
  if (metadataEnd < 0) {
    throw new Error(`metadataEndsBefore not found: ${JSON.stringify(expected.metadataEndsBefore)}`);
  }

  const headingStart = expected.headingLine === "" ? metadataEnd : text.indexOf(expected.headingLine, metadataEnd);
  if (headingStart < 0) {
    throw new Error(`headingLine not found after metadata: ${JSON.stringify(expected.headingLine)}`);
  }
  const headingEnd = headingStart + expected.headingLine.length;

  const bodyStart = headingEnd;
  let bodyEnd: number;
  if (expected.bodyEnds.at === "eof") {
    bodyEnd = text.length;
  } else {
    bodyEnd = text.indexOf(expected.bodyEnds.text, bodyStart);
    if (bodyEnd < 0) {
      throw new Error(`bodyEnds.text not found after body start: ${JSON.stringify(expected.bodyEnds.text)}`);
    }
  }

  return { metadataStart, metadataEnd, headingStart, headingEnd, bodyStart, bodyEnd };
}
