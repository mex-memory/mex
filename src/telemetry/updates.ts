/** A bounded daily update check, invoked only by the bare interactive `mex` entry. */
import { request } from "node:https";
import { Resolver } from "node:dns";
import { isDevRepo, readGlobalConfig, setGlobalConfigKey } from "../global-config.js";
import { VERSION } from "../version.js";
import { isCI } from "./policy.js";
import { utcDay } from "./store.js";

export const UPDATE_TIMEOUT_MS = 1500;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*))?$/;
export function newerVersion(candidate: string, current: string): boolean {
  const next = semver.exec(candidate), old = semver.exec(current);
  if (!next || !old || candidate.length > 80 || current.length > 80) return false;
  for (let i = 1; i <= 3; i++) { if (Number(next[i]) !== Number(old[i])) return Number(next[i]) > Number(old[i]); }
  if (!next[4]) return !!old[4];
  if (!old[4]) return false;
  const a = next[4].split("."), b = old[4].split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined) return false;
    if (b[i] === undefined) return true;
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i]);
    if (an && bn) return Number(a[i]) > Number(b[i]);
    if (an !== bn) return !an;
    return a[i] > b[i];
  }
  return false;
}

function publishedVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const resolver = new Resolver({ timeout: UPDATE_TIMEOUT_MS, tries: 1 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (version?: string): void => {
      if (done) return; done = true;
      if (timer) clearTimeout(timer);
      resolver.cancel(); req.destroy(); resolve(version);
    };
    const req = request("https://registry.npmjs.org/mex-agent/latest", { agent: false, method: "GET", lookup: (host, _options, callback) => {
      resolver.resolve4(host, (error, addresses) => callback(error, addresses?.[0] ?? "", 4));
    } }, (response) => {
      if (response.statusCode !== 200) { response.destroy(); finish(); return; }
      let body = "", bytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16384) { response.destroy(); finish(); return; }
        body += chunk;
      });
      response.on("end", () => { try { const version: unknown = JSON.parse(body).version; finish(typeof version === "string" && semver.test(version) && version.length <= 80 ? version : undefined); } catch { finish(); } });
      response.on("error", () => finish()); response.on("aborted", () => finish());
    });
    req.on("error", () => finish());
    timer = setTimeout(() => finish(), UPDATE_TIMEOUT_MS);
    req.end();
  });
}

export async function showUpdateNotice(options: { now?: number; readVersion?: () => Promise<string | undefined>; write?: (line: string) => void } = {}): Promise<boolean> {
  if (!process.stderr.isTTY || process.env.MEX_OFFLINE === "1" || process.env.MEX_BACKGROUND === "1" || process.env.CLAUDECODE
    || process.env.CODEX_THREAD_ID || isCI() || isDevRepo()) return false;
  const day = utcDay(options.now);
  if (readGlobalConfig().updateCheckedDay === day) return false;
  try {
    setGlobalConfigKey("updateCheckedDay", day);
    const latest = await (options.readVersion ?? publishedVersion)();
    if (!latest || !newerVersion(latest, VERSION)) return false;
    (options.write ?? ((line) => process.stderr.write(line)))(`MEX ${latest} is available (installed ${VERSION}). Update: npm install -g mex-agent\n`);
    return true;
  } catch { return false; }
}
