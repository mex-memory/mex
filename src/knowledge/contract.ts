/** Small command-registration contract; importing help must not load the codec or store. */
export const ENTRY_KINDS = ["recipe", "rule", "decision", "pitfall", "procedure", "fact", "hint"] as const;
export const KNOWLEDGE_LIMITS = Object.freeze({
  entryBytes: 64 * 1024, textCharacters: 8192, oneLineCharacters: 1024,
  entries: 10_000, scanBytes: 8 * 1024 * 1024, results: 100, queryCharacters: 256,
});
export class KnowledgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "KnowledgeError"; }
}
