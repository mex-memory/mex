import { graphLocation, readGraphPointer } from "./storage.js";

export interface WarmEditResult {
  /** published: a new overlay is live. unchanged: nothing to do. cold: queue a refresh. */
  status: "published" | "unchanged" | "cold";
  reason?: string;
  /** Repository-relative files this edit rewrote, the edited ones first. */
  files: string[];
  /** From the call to the published pointer. */
  ms: number;
  phases: Record<string, number>;
}

export interface WarmGraphCheckout {
  lastEditAt: number;
  edit(paths: readonly string[]): Promise<WarmEditResult>;
  close(): void;
}

/** Open a resident engine for the checkout's published v5 graph. */
export async function openWarmCheckout(root: string): Promise<WarmGraphCheckout> {
  if (process.env.MEX_GRAPH_STORAGE !== "v5") throw new Error("Schema v4 edits use a normal graph refresh.");
  const location = graphLocation(root);
  const pointer = readGraphPointer(location);
  if (pointer) {
    const { NativeWarmCheckout } = await import("./native-warm.js");
    const resident = await NativeWarmCheckout.open(location, pointer);
    if (resident) return resident;
  }
  throw new Error("The checkout has no published schema v5 graph.");
}
