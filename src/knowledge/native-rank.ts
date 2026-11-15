import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mexHomeDir } from "../global-config.js";
import { binaryFileName, findNativeBinary } from "../hooks/shim/binary.js";
import type { KnowledgeEntry } from "./entry.js";
export interface RankHit {
  id: string;
  score: number;
  matched: string[];
  exact: boolean;
}
export function rankBinary(): string | undefined {
  const installed = join(mexHomeDir(), "bin", binaryFileName());
  return process.env.MEX_HOOK_BINARY || (existsSync(installed) ? installed : findNativeBinary() ?? undefined);
}
export function rankNative(query: string, entries: KnowledgeEntry[]): {
  hits?: RankHit[];
  reason?: string;
} {
  const binary = rankBinary();
  if (!binary) {
    return {
      reason: "native-binary-unavailable"
    };
  }
  const result = spawnSync(binary, ["--recall"], {
    input: JSON.stringify({
      query,
      entries: entries.map(e => ({
        ...e.mex,
        text: e.text
      })),
      recall: true
    }),
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      MEX_BACKGROUND: "1"
    }
  });
  if (result.error || result.status !== 0) {
    return {
      reason: "native-ranker-unavailable"
    };
  }
  try {
    const output = JSON.parse(result.stdout);
    const hits: RankHit[] = output.results?.[0]?.selected?.[0] ?? [];
    const ids = new Set(entries.map(e => e.mex.id));
    const invalid = !Array.isArray(hits) || hits.some(r => !ids.has(r.id) || !Number.isFinite(r.score) || r.score < 0 || typeof r.exact !== "boolean" || !Array.isArray(r.matched));
    if (!output.ok || invalid) {
      throw Error();
    }
    return {
      hits
    };
  } catch {
    return {
      reason: "native-ranker-unavailable"
    };
  }
}
