/** A bounded daily update check, invoked only by the bare interactive `mex` entry. */
import { request } from "node:https";
import { isAgentCaller } from "../repo-start/caller.js";
import { Resolver } from "node:dns";
import { isDevRepo, readGlobalConfig, setGlobalConfigKey } from "../global-config.js";
import { VERSION } from "../version.js";
import { isCI } from "./policy.js";
import { utcDay } from "./store.js";
import { isVersion, newerVersion } from "../version-order.js";
export { newerVersion } from "../version-order.js";

export const UPDATE_TIMEOUT_MS = 1500;

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
      response.on("end", () => { try { const version: unknown = JSON.parse(body).version; finish(typeof version === "string" && isVersion(version) ? version : undefined); } catch { finish(); } });
      response.on("error", () => finish()); response.on("aborted", () => finish());
    });
    req.on("error", () => finish());
    timer = setTimeout(() => finish(), UPDATE_TIMEOUT_MS);
    req.end();
  });
}

export async function showUpdateNotice(options: { now?: number; readVersion?: () => Promise<string | undefined>; write?: (line: string) => void } = {}): Promise<boolean> {
  if (!process.stderr.isTTY || process.env.MEX_OFFLINE === "1" || process.env.MEX_BACKGROUND === "1" || isAgentCaller()
    || isCI() || isDevRepo()) return false;
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
