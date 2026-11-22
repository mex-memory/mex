import { createHash, randomBytes } from "node:crypto";

export const PRODUCER_IDS = ["note", "setup-recipe", "setup-question", "code-facts", "fail-pass", "learn-deeper", "judge",
  "session-import", "session-ongoing"] as const;
export type ProducerId = typeof PRODUCER_IDS[number];
type EvidenceClass = "person" | "docs" | "review" | "ci" | "mined" | "observed";

export interface Producer {
  id: ProducerId;
  name: string;
  active: boolean;
  personAuthored: boolean;
  namespace: { prefix: string; hexCharacters: number };
  evidence: EvidenceClass;
  requiresAnchor: boolean;
  /** Entries of these kinds with this evidence may use scope `**` with no anchor. */
  repoWide?: { kinds: readonly string[]; evidence: readonly EvidenceClass[] };
  variesEvidence?: boolean;
}

const definitions: Readonly<Record<ProducerId, Omit<Producer, "id">>> = {
  note: { name: "Notes", active: true, personAuthored: true, namespace: { prefix: "mx_", hexCharacters: 24 }, evidence: "person", requiresAnchor: false },
  "setup-recipe": { name: "Setup recipes", active: true, personAuthored: false, namespace: { prefix: "mx_setup", hexCharacters: 24 }, evidence: "docs", requiresAnchor: true },
  "setup-question": { name: "Setup questions", active: true, personAuthored: true, namespace: { prefix: "mx_answer", hexCharacters: 32 }, evidence: "person", requiresAnchor: true },
  "code-facts": { name: "Code facts", active: true, personAuthored: false, namespace: { prefix: "mx_fact", hexCharacters: 32 }, evidence: "mined", requiresAnchor: true },
  "fail-pass": { name: "Fail-to-pass capture", active: true, personAuthored: false, namespace: { prefix: "mx_fix", hexCharacters: 32 }, evidence: "observed", requiresAnchor: true },
  "learn-deeper": { name: "Learn deeper", active: true, personAuthored: false, namespace: { prefix: "mx_deep", hexCharacters: 32 }, evidence: "review", requiresAnchor: true, variesEvidence: true,
    // A rule taken from a teammate's doc or review is delivered like a person's note: in the start brief and recall.
    repoWide: { kinds: ["rule", "decision", "procedure"], evidence: ["docs", "review"] } },
  judge: { name: "Judge", active: true, personAuthored: false, namespace: { prefix: "mx_judge", hexCharacters: 32 }, evidence: "observed", requiresAnchor: true, variesEvidence: true },
  "session-import": { name: "Past sessions", active: false, personAuthored: false, namespace: { prefix: "mx_import", hexCharacters: 32 }, evidence: "observed", requiresAnchor: true },
  "session-ongoing": { name: "Session learning", active: false, personAuthored: false, namespace: { prefix: "mx_session", hexCharacters: 32 }, evidence: "observed", requiresAnchor: true },
};

export function producer(id: ProducerId): Producer {
  const value = definitions[id];
  return { id, ...value, namespace: { ...value.namespace } };
}

/** Whether an entry of this kind and evidence class needs a code anchor (a narrower scope, `when:`, a symbol or a command). */
export function anchorRequired(id: ProducerId, kind: string, evidence: string): boolean {
  const { requiresAnchor, repoWide } = definitions[id];
  return requiresAnchor && !(repoWide && repoWide.kinds.includes(kind) && (repoWide.evidence as readonly string[]).includes(evidence));
}

export function listProducers(): Producer[] { return PRODUCER_IDS.map(producer); }

export function ownsEntryId(id: string, { namespace }: Producer): boolean {
  return new RegExp(`^${namespace.prefix}[a-f0-9]{${namespace.hexCharacters}}$`, "u").test(id);
}

export function producerEntryId(id: ProducerId, key?: string): string {
  const { prefix, hexCharacters } = definitions[id].namespace;
  const hex = key === undefined ? randomBytes(hexCharacters / 2).toString("hex") : createHash("sha256").update(key).digest("hex").slice(0, hexCharacters);
  return prefix + hex;
}

export function entryProducer({ id, source }: { id: string; source: { type: string; ref: string; producer?: ProducerId } }): ProducerId | "unknown" {
  if (source.producer) return source.producer;
  if (ownsEntryId(id, producer("setup-recipe"))) return "setup-recipe";
  if (ownsEntryId(id, producer("learn-deeper"))) return "learn-deeper";
  return source.type === "person" && /^mex note(?: |$)/u.test(source.ref) ? "note" : "unknown";
}
