import { execFile } from "node:child_process";
import { nativeBinary, type NativeReport } from "../knowledge/check.js";
import { CheckSchema, type EntryCheck } from "../knowledge/entry.js";

/** Background checks yield to the lease heartbeat; hooks never wait for these. */
export async function nativeRequest(request: Record<string, unknown>): Promise<unknown> {
  const binary = nativeBinary();
  if (!binary) throw new Error("The judge needs the installed check evaluator.");
  return new Promise((resolve, reject) => {
    const child = execFile(binary, ["--check-run"], {
      encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, MEX_BACKGROUND: "1" },
    }, (error, stdout) => {
      try {
        const result = JSON.parse(stdout) as { ok?: boolean };
        if (error || result.ok !== true) throw new Error();
        resolve(result);
      } catch { reject(new Error("The judge's check evaluator could not answer.")); }
    });
    child.stdin?.on("error", () => { /* execFile reports the failed child */ });
    child.stdin?.end(JSON.stringify(request));
  });
}

export async function evaluate(request: Record<string, unknown>): Promise<NativeReport> {
  const result = await nativeRequest({ ...request, action: "evaluate", store: false }) as NativeReport;
  if (!Array.isArray(result.items) && result.items !== null) throw new Error("Invalid judge check report.");
  return result;
}

/** The model proposes targets; only the evaluator can mint current baselines. */
export async function recordChecks(request: Record<string, unknown>, items: unknown[]): Promise<EntryCheck[] | undefined> {
  const result = await nativeRequest({ ...request, action: "record-batch", items }) as { results?: Array<{ ok: boolean; check?: unknown }> };
  if (result.results?.length !== items.length) return undefined;
  const checks: EntryCheck[] = [];
  for (const item of result.results) {
    const parsed = CheckSchema.safeParse(item.check);
    if (!item.ok || !parsed.success) return undefined;
    checks.push(parsed.data);
  }
  return checks;
}
