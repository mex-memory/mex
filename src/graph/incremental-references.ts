import type { FileRecord, ImportBindingRecord, UnresolvedRefRecord } from "./db/store.js";
import type { GraphEdge, ReferenceKind } from "./types.js";

interface ReferenceFile {
  record: FileRecord;
  nodes: Array<{ id: string }>;
  edges: GraphEdge[];
  references: UnresolvedRefRecord[];
  imports: ImportBindingRecord[];
}
/** Cached compiler captures can resolve declarations outside the indexed corpus. */
export function normalizeIncrementalReferences(files: readonly ReferenceFile[]): void {
  const ids = new Set(files.flatMap((file) => file.nodes.map((node) => node.id)));
  for (const file of files) {
    let dropped = 0;
    file.edges = file.edges.filter((edge) => {
      if (ids.has(edge.source) && ids.has(edge.target)) return true;
      dropped++;
      if (ids.has(edge.source)) file.references.push({
        fromNodeId: edge.source, referenceName: String(edge.metadata?.targetName ?? edge.target),
        referenceKind: edge.kind as ReferenceKind, filePath: file.record.path,
        language: file.record.language, line: edge.line, column: edge.column,
        status: "unresolved", candidates: [], confidence: 0,
        resolver: "incremental-corpus", metadata: { reason: "target outside indexed corpus" },
      });
      return false;
    });
    file.references = file.references.filter((ref) => {
      if (!ids.has(ref.fromNodeId)) { dropped++; return false; }
      if (ref.targetId && !ids.has(ref.targetId)) {
        dropped++;
        ref.targetId = undefined;
        ref.status = "unresolved";
        ref.confidence = 0;
      }
      if (ref.candidates) ref.candidates = ref.candidates.filter((id) => ids.has(id));
      return true;
    });
    for (const binding of file.imports) {
      if (binding.targetId && !ids.has(binding.targetId)) { binding.targetId = undefined; dropped++; }
    }
    if (dropped > 0) file.record.errors = [...(file.record.errors ?? []), {
      type: "INCREMENTAL_REFERENCE_OUTSIDE_CORPUS", count: dropped,
      message: "References without indexed endpoints were dropped or demoted to unresolved.",
    }];
  }
}

