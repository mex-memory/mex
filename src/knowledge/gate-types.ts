import type { RecordWriter } from "../record/index.js";
import type { KnowledgeOptions } from "./context.js";
import type { EntryCheck, KnowledgeEntry } from "./entry.js";
import type { ProducerId } from "./producers.js";
import type { Verdict } from "./check.js";

type Entry = KnowledgeEntry["mex"];
type CheckInput<T extends EntryCheck> = T extends EntryCheck ? Pick<T, "kind" | "role" | "target"> & { saw?: T["saw"] } : never;
export type ProposedCheck = CheckInput<Exclude<EntryCheck, { kind: "legacy-grounding" }>>;

export interface Proposal {
  producer: ProducerId;
  id?: string;
  key?: string;
  kind: Exclude<Entry["kind"], "hint">;
  text: string;
  oneLine?: string;
  aliases?: Entry["aliases"];
  asks?: Entry["asks"];
  source: Pick<Entry["source"], "type" | "ref" | "quote"> & { text?: string };
  evidence?: Array<string | number>;
  evidenceClass?: Entry["evidence"];
  anchors?: { scope?: string[]; when?: Entry["when"]; symbols?: Array<{ file: string; symbol: string }> };
  checks?: ProposedCheck[];
  model: NonNullable<Entry["source"]["model"]> | "none";
  label?: string;
  replaces?: string;
  lasts?: unknown;
}

export type DropReason = "invalid" | "inactive-producer" | "secret" | "undefined-command" | "no-anchor"
  | "quote-not-found" | "forgotten" | "duplicate-entry" | "duplicate-rule-line" | "check-fails" | "checks-unavailable";
export type Dropped = { status: "dropped"; reason: DropReason; detail?: string };
export type Accepted = { status: "accepted"; entryId: string; change: "new" | "updated" | "unchanged";
  sanitized?: Array<"text" | "oneLine" | "checks" | "quote"> };
export type Conflict = { status: "review"; reason: "contradiction"; conflictsWith: string[]; reviewId: string };
export type GateResult = Accepted | Dropped | Conflict;

export interface AcceptedEntry extends Accepted { entry: KnowledgeEntry; }
export interface Sweep {
  producer: ProducerId;
  /** Omit to sweep the entire producer. Omitted proposals are protected if the scan was incomplete. */
  includes?: (entry: KnowledgeEntry) => boolean;
  /** A verified team retirement also suppresses resurrection of that claim. */
  tombstone?: { reason: string; by: string };
}
export type Observation = { check: EntryCheck } | { reason: string };
export type ObserveChecks = (checks: ProposedCheck[], tree: string) => Observation[] | undefined;

export interface GateContext extends KnowledgeOptions {
  now?: Date;
  checkTree?: string;
  /** Temporary file index for a pinned check tree, separate from the live project's index. */
  checkIndex?: { projectId: string; recordDirectory: string };
  sweep?: Sweep;
  validate?: (writer: RecordWriter) => void;
  onAccepted?: (writer: RecordWriter, accepted: AcceptedEntry[], results: readonly GateResult[]) => void;
  observeChecks?: ObserveChecks;
  observeVerdicts?: (checkout: string) => ReadonlyMap<string, Verdict>;
  /** Called with the number of malformed team and hint files left out of the comparison. */
  onSkipped?: (invalid: { team: number; hint: number }) => void;
}
