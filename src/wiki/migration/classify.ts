/**
 * Section 13.2 — which heading is an entity, and of what type.
 *
 * ## Everything here is structural
 *
 * MEX makes no model calls, so nothing in this file reads prose for meaning.
 * Every rule is a path, a heading depth, a heading position, or a count. Where
 * a rule cannot be stated that way it is an **abstain**, not an invitation to
 * be clever: section 13.1 says report ambiguity instead of guessing, and
 * abstention is a first-class outcome here rather than a fallback.
 *
 * ## The threshold is named, not buried
 *
 * "Do not create an entity for every paragraph" needs a line somewhere. It is
 * {@link SUBSTANTIAL_SECTION_LINES} and {@link SUBSTANTIAL_SECTION_WORDS}, both
 * exported and both tested on either side. A rule nobody can see is a rule
 * nobody can fix.
 *
 * ## Ordering is a correctness property, not presentation
 *
 * See {@link orderForAdoption}. A body runs to the start of the next entity's
 * metadata (findings 14 and 22), so inserting a metadata block above a heading
 * **shortens the body of whatever entity currently contains that heading**.
 * P5's `verifyPlan` compares every entity the operation did not name and
 * refuses a plan that changed one. Adopting top-down therefore fails on the
 * second adoption in any file with nesting; adopting bottom-up never does,
 * because each insertion only ever truncates prose no entity yet owns.
 */
import type { WikiEntityType } from "./../model/entity.js";
import type { RawHeading } from "../markdown/parse.js";
import type { InventoryFile } from "./inventory.js";
import { isTeamOwnedReadOnlyPath } from "../model/team-owned-paths.js";

/** A section must have at least this many non-blank prose lines to be an entity. */
export const SUBSTANTIAL_SECTION_LINES = 3;

/** ...and at least this many words. Two short sentences do not make a claim. */
export const SUBSTANTIAL_SECTION_WORDS = 25;

/** Where an entity's metadata will go. */
export type AdoptionTarget =
  | { at: "file" }
  | { at: "heading"; ordinal: number; text: string; depth: number; start: number };

/** A heading (or a file) migration proposes to adopt as an entity. */
export interface Candidate {
  file: string;
  target: AdoptionTarget;
  type: WikiEntityType;
  title: string;
  /** The rule that fired, in words. Goes into the report. */
  rule: string;
}

/** Something migration deliberately did not decide. */
export interface Abstention {
  file: string;
  /** Null when the whole file was abstained on. */
  target: AdoptionTarget | null;
  reason: string;
}

export interface FileClassification {
  file: string;
  candidates: Candidate[];
  abstentions: Abstention[];
  /** True for a file migration deliberately does not annotate at all. */
  skipped: boolean;
  skipReason?: string;
}

/**
 * The role a path plays in a scaffold.
 *
 * Keyed on path because that is what a scaffold's own conventions key on —
 * `mex pattern add` writes `patterns/<slug>.md` and `mex setup` writes
 * `context/<name>.md`. Anything off this table is an abstain, which is the
 * honest answer for a file whose role nothing structural can establish.
 */
export interface Role {
  /** Type for the file-level entity, or null when the file gets none. */
  fileType: WikiEntityType | null;
  /** Type for a substantial section, or null when sections are not entities. */
  sectionType: WikiEntityType | null;
  /** Depth of the headings that may become section entities. */
  sectionDepth: number;
  rule: string;
}

/** Files that are navigation or generated output, never knowledge. */
export const NON_KNOWLEDGE_FILES: Record<string, string> = {
  "ROUTER.md": "a navigation hub, not a claim about the system",
  "AGENTS.md": "project identity and commands, addressed to a tool rather than a reader",
  "SETUP.md": "scaffold bootstrap instructions, superseded by context/setup.md",
  "SYNC.md": "scaffold maintenance instructions",
  "HEARTBEAT.md": "session state, rewritten constantly",
  "patterns/README.md": "generated index prose",
  "patterns/INDEX.md": "a generated view (section 13.5), regenerated rather than adopted",
};

const CONTEXT_ROLES: Record<string, Role> = {
  "context/architecture.md": {
    fileType: "architecture",
    sectionType: "component",
    sectionDepth: 2,
    rule: "section 13.2: architecture file to `architecture`, its sections to `component`",
  },
  "context/conventions.md": {
    fileType: "convention",
    sectionType: "convention",
    sectionDepth: 2,
    rule: "section 13.2: conventions file and its sections to `convention`",
  },
  "context/setup.md": {
    fileType: "guide",
    sectionType: "guide",
    sectionDepth: 2,
    rule: "section 13.2: setup/runbook to `guide`",
  },
  "context/risks.md": {
    // No file-level entity: a risk register is a list, not one claim.
    fileType: null,
    sectionType: "risk",
    sectionDepth: 2,
    rule: "section 13.2: risk section to `risk`; the register itself is not a claim",
  },
  "context/decisions.md": {
    // Handled by the decision-log rule below, which is depth-3 and conditional.
    fileType: null,
    sectionType: null,
    sectionDepth: 3,
    rule: "section 13.2: decision only when the section expresses an actual decision",
  },
};

/** A `patterns/<slug>.md` file is one pattern entity, and its sections are its parts. */
const PATTERN_ROLE: Role = {
  fileType: "pattern",
  sectionType: null,
  sectionDepth: 2,
  rule: "section 13.2: pattern file to a file-level `pattern`",
};

export function roleFor(path: string): Role | null {
  // Navigation and generated output outrank every other rule, including the
  // pattern directory rule below: a `patterns/INDEX.md` is not a pattern.
  if (Object.hasOwn(NON_KNOWLEDGE_FILES, path)) return null;
  if (Object.hasOwn(CONTEXT_ROLES, path)) return CONTEXT_ROLES[path] ?? null;
  if (path.startsWith("patterns/")) return PATTERN_ROLE;
  return null;
}

/** The text of a heading's section: from its terminator to the next heading of equal or shallower depth. */
export function sectionTextOf(file: InventoryFile, index: number): string {
  const heading = file.headings[index];
  if (heading === undefined) return "";
  let end = file.text.length;
  for (let next = index + 1; next < file.headings.length; next += 1) {
    const candidate = file.headings[next];
    if (candidate !== undefined && candidate.depth <= heading.depth) {
      end = candidate.start;
      break;
    }
  }
  return file.text.slice(heading.end, end);
}

/** Non-blank, non-heading lines and their word count. */
export function proseWeight(sectionText: string): { lines: number; words: number } {
  let lines = 0;
  let words = 0;
  let fenced = false;
  for (const raw of sectionText.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    // Fenced code is not a claim, and a heading is a label rather than prose.
    if (fenced || line === "") continue;
    if (/^#{1,6}\s/.test(line)) continue;
    lines += 1;
    words += line.split(/\s+/).filter((word) => word !== "").length;
  }
  return { lines, words };
}

export function isSubstantial(sectionText: string): boolean {
  const weight = proseWeight(sectionText);
  return weight.lines >= SUBSTANTIAL_SECTION_LINES && weight.words >= SUBSTANTIAL_SECTION_WORDS;
}

/** A `##` heading whose text names a decision log, under which `###` entries live. */
const DECISION_LOG_HEADING = /^decision log$/i;

/** The structural marker a decision entry carries. Not a reading of the prose. */
const DECISION_MARKER = /^\*\*Decision:\*\*/m;

function targetOf(heading: RawHeading, ordinal: number): AdoptionTarget {
  return { at: "heading", ordinal, text: heading.title, depth: heading.depth, start: heading.start };
}

/**
 * Why a file that already carries entities is skipped. Exported because it is
 * the one skip reason that still lets migration fold a root `grounds_to` into
 * the file's existing file-level entity (#226); every other skip means the file
 * is not migration's to write.
 */
export const ALREADY_ADOPTED_REASON = "already carries entity metadata";

/**
 * Classify one file.
 *
 * Never throws, never guesses, and reports what it declined to decide.
 */
export function classifyFile(file: InventoryFile): FileClassification {
  const result: FileClassification = { file: file.path, candidates: [], abstentions: [], skipped: false };

  // Ownership outranks every other question, including whether the file already
  // carries entity metadata. A Team-owned root belongs to the Team workflow:
  // `operations/paths.ts` refuses at plan time any operation that touches one,
  // so offering these for classification asked a human to make a decision
  // migration would then reject. Reported as skipped with a reason — "not our
  // business" is a decision, and an abstention says the opposite, that nobody
  // could decide. The predicate is the one the operation and query layers
  // already share; a second copy here would drift from it silently.
  if (isTeamOwnedReadOnlyPath(file.path)) {
    return {
      ...result,
      skipped: true,
      skipReason: "a Team-owned path: the Team workflow owns these files and migration never writes into them",
    };
  }

  const nonKnowledge = NON_KNOWLEDGE_FILES[file.path];
  if (nonKnowledge !== undefined) {
    return { ...result, skipped: true, skipReason: nonKnowledge };
  }

  // A file that already carries entities has been migrated. Section 13.3: a
  // file with valid ids is skipped, never regenerated.
  if (file.parsed.entities.length > 0) {
    return { ...result, skipped: true, skipReason: ALREADY_ADOPTED_REASON };
  }

  // A file the codec could not read is a file migration must not write into.
  // Section 13.1: a failed file migration must not corrupt files it left alone,
  // and splicing a `mex:` key into frontmatter that does not parse is how one
  // file's damage becomes two.
  if (file.parsed.diagnostics.some((entry) => entry.severity === "error")) {
    result.abstentions.push({
      file: file.path,
      target: null,
      reason:
        `${file.path} could not be read cleanly: ` +
        file.parsed.diagnostics
          .filter((entry) => entry.severity === "error")
          .map((entry) => entry.message)
          .join("; ") +
        ". Migration will not write into a file it cannot parse.",
    });
    return result;
  }

  const role = roleFor(file.path);
  if (role === null) {
    result.abstentions.push({
      file: file.path,
      target: null,
      reason:
        `No classification rule determines the type of ${file.path}. ` +
        "The context directory contains several knowledge types; its location alone does not establish architecture. " +
        "Add explicit Wiki entity metadata with the intended type before retrying. Migration leaves this file unchanged.",
    });
    return result;
  }

  // Decision log: depth-3 entries under a depth-2 heading that names the log,
  // each carrying the structural decision marker.
  if (file.path === "context/decisions.md") {
    file.headings.forEach((heading, index) => {
      if (heading.depth === 1) return;
      if (heading.depth === 2) {
        result.abstentions.push({
          file: file.path,
          target: targetOf(heading, index),
          reason: DECISION_LOG_HEADING.test(heading.title.trim())
            ? "A decision log is a container for its entries, not a decision of its own."
            : "A depth-2 heading in a decisions file groups entries; it makes no claim of its own.",
        });
        return;
      }
      if (heading.depth !== 3) {
        result.abstentions.push({
          file: file.path,
          target: targetOf(heading, index),
          reason: `A decision entry is a depth-3 heading; this one is depth ${heading.depth}.`,
        });
        return;
      }
      const section = sectionTextOf(file, index);
      if (!DECISION_MARKER.test(section)) {
        result.abstentions.push({
          file: file.path,
          target: targetOf(heading, index),
          reason:
            "A section in the decision log with no `**Decision:**` line. Section 13.2 makes a " +
            "decision entity only when the section expresses an actual decision, and nothing " +
            "structural here says it does.",
        });
        return;
      }
      result.candidates.push({
        file: file.path,
        target: targetOf(heading, index),
        type: "decision",
        title: heading.title,
        rule: role.rule,
      });
    });
    return result;
  }

  if (role.sectionType !== null) {
    const sectionType = role.sectionType;
    file.headings.forEach((heading, index) => {
      if (heading.depth === 1) return;
      if (heading.depth !== role.sectionDepth) {
        // Reported rather than silently passed over. Section 13.2 says
        // ambiguous prose is retained *and reported*, and a subsection nested
        // inside a section that did become an entity is exactly the case a
        // reader needs told about — its prose is now inside its parent's body.
        result.abstentions.push({
          file: file.path,
          target: targetOf(heading, index),
          reason:
            `Sections of ${file.path} become entities at depth ${role.sectionDepth}; this heading is ` +
            `depth ${heading.depth}. Its prose stays with the section that contains it.`,
        });
        return;
      }
      const section = sectionTextOf(file, index);
      if (!isSubstantial(section)) {
        const weight = proseWeight(section);
        result.abstentions.push({
          file: file.path,
          target: targetOf(heading, index),
          reason:
            `Section has ${weight.lines} prose line(s) and ${weight.words} word(s); the threshold is ` +
            `${SUBSTANTIAL_SECTION_LINES} lines and ${SUBSTANTIAL_SECTION_WORDS} words. Section 13.2 ` +
            "says not to create an entity for every paragraph.",
        });
        return;
      }
      result.candidates.push({
        file: file.path,
        target: targetOf(heading, index),
        type: sectionType,
        title: heading.title,
        rule: role.rule,
      });
    });
  }

  if (role.fileType !== null) {
    const name = fileTitleOf(file);
    if (name === null) {
      result.abstentions.push({
        file: file.path,
        target: { at: "file" },
        reason:
          "A file-level entity's title comes from the frontmatter `name` or the document's first " +
          "heading, and this file has neither. Inventing one would put a fact in the scaffold that " +
          "nobody wrote.",
      });
    } else if (file.parsed.frontmatter === null) {
      result.abstentions.push({
        file: file.path,
        target: { at: "file" },
        reason:
          "A file-level entity's metadata is the frontmatter `mex:` key, and this file has no " +
          "frontmatter block. Creating one would insert bytes above prose that has no metadata to " +
          "carry, which migration does not do unaided.",
      });
    } else {
      result.candidates.push({
        file: file.path,
        target: { at: "file" },
        type: role.fileType,
        title: name,
        rule: role.rule,
      });
    }
  }

  return result;
}

/** The title a file-level entity takes: frontmatter `name`, else the first heading. */
export function fileTitleOf(file: InventoryFile): string | null {
  const frontmatter = file.parsed.frontmatter;
  if (frontmatter !== null && frontmatter.keys.includes("name")) {
    const match = /^name:\s*(.+?)\s*$/m.exec(file.text.slice(frontmatter.range.start, frontmatter.range.end));
    if (match !== undefined && match !== null) {
      const value = match[1]?.replace(/^["']|["']$/g, "") ?? "";
      // An explicitly null `name` is not a title. YAML distinguishes a missing
      // key from one set to `null` and the second is nearly always a mistake
      // (finding 11); taking it literally would title an entity "null".
      if (value !== "" && value !== "null" && value !== "~") return value;
    }
  }
  const first = file.headings[0];
  return first === undefined ? null : first.title;
}

/**
 * The order candidates in one file must be adopted in.
 *
 * **Descending by heading offset, with the file-level entity last.** Measured,
 * not reasoned about: inserting a metadata block above a heading truncates the
 * body of whichever entity currently contains that heading, because a body runs
 * to the start of the next entity's metadata. P5's `verifyPlan` refuses a plan
 * that changes an entity the operation did not name, so
 *
 * - adopting a `###` before its containing `##` is fine — the `##` is not yet
 *   an entity, so there is nothing to shorten;
 * - adopting the `##` first and then the `###` inside it is refused;
 * - adding the file-level entity first and then any block entity is refused,
 *   because the file-level body ends at the first block entity's metadata.
 *
 * Same-depth siblings are unaffected either way (a body already stops at the
 * next heading of equal depth), but ordering them consistently costs nothing
 * and keeps the rule to one sentence.
 */
export function orderForAdoption(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    if (a.target.at === "file") return 1;
    if (b.target.at === "file") return -1;
    return b.target.start - a.target.start;
  });
}
