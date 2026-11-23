import { openRecord } from "../record/index.js";
import { recordBuildUsage, type BuildUsageKind, type BuildUsageResult } from "../record/build-usage.js";
import type { GraphCandidateUsage } from "./candidate-protocol.js";
import type { ProcessUsage } from "./process-stats.js";
import type { GraphLocation } from "./storage.js";

export function startGraphUsage() {
  return { startedAt: performance.now(), cpu: process.cpuUsage(), rss: process.memoryUsage.rss() };
}

/** One row per operation, including all engine attempts and the Node writers. */
export function logGraphUsage(
  location: GraphLocation,
  kind: BuildUsageKind,
  meter: ReturnType<typeof startGraphUsage>,
  engine: ProcessUsage,
  candidate: GraphCandidateUsage | undefined,
  files: number,
  result: BuildUsageResult,
): void {
  try {
    const cpu = process.cpuUsage(meter.cpu);
    const serverRssMb = Math.max(engine.peakRssMb, candidate?.enginePeakRssMb ?? 0);
    const writer = openRecord({ busyTimeoutMs: 1000 });
    try {
      recordBuildUsage(writer.db, {
        projectId: location.projectId, checkout: location.root, kind, files, result,
        wallMs: performance.now() - meter.startedAt,
        cpuMs: (cpu.user + cpu.system) / 1000 + engine.cpuMs + (candidate?.cpuMs ?? 0),
        peakRssMb: Math.max(meter.rss, process.memoryUsage.rss()) / 1024 ** 2
          + Math.max(candidate?.peakRssMb ?? 0, engine.peakRssMb),
        ...(serverRssMb > 0 ? { serverRssMb } : {}),
      });
    } finally { writer.close(); }
  } catch { /* The usage log never prevents maintenance. */ }
}
