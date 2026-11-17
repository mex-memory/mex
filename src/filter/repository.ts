import { execFile } from "node:child_process";
import { readSource } from "../judge/evidence.js";
import type { RecordWriter } from "../record/index.js";
import { backgroundEnvironment } from "./environment.js";
export interface RepositoryPolicy { visibility: "private" | "public" | "unknown"; authorized: boolean; }
function command(root: string, executable: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => execFile(executable, args, { cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 64 << 10, windowsHide: true, env: backgroundEnvironment() }, (error, stdout) => resolve(error ? undefined : stdout)));
}
/** Background-only lookup. Unknown visibility/authority never grants publication. */
export async function repositoryPolicy(root: string): Promise<RepositoryPolicy> {
  const remote = (await command(root, "git", ["remote", "get-url", "origin"]))?.trim();
  const repository = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(remote ?? "")?.[1];
  if (!repository) return { visibility: "unknown", authorized: false };
  const target = `https://github.com/${repository}`;
  let visibility: RepositoryPolicy["visibility"] = "unknown", authorized = false;
  try {
    const value = JSON.parse(await command(root, "gh", ["repo", "view", target, "--json", "isPrivate,viewerPermission"]) ?? "null");
    visibility = value?.isPrivate === true ? "private" : value?.isPrivate === false ? "public" : "unknown";
    authorized = ["WRITE", "MAINTAIN", "ADMIN"].includes(value?.viewerPermission);
  } catch { /* permission or visibility remains unknown */ }
  if (!authorized) try {
    const pulls = JSON.parse(await command(root, "gh", ["pr", "list", "-R", target, "--author", "@me", "--state", "merged", "--limit", "1", "--json", "number"]) ?? "null");
    authorized = Array.isArray(pulls) && pulls.some(p => Number.isSafeInteger(p.number) && p.number > 0);
  } catch { /* no proved authority */ }
  return { visibility, authorized };
}
export function sharingEnabled(writer: Pick<RecordWriter, "project">, project: string, root: string): boolean {
  try {
    const value = JSON.parse(readSource(root, ".mex/config.json") ?? "null");
    if (value?.knowledge?.shared === false) return false;
    return writer.project(project)?.shared === 1 || value?.knowledge?.version === 1 && value.knowledge.shared === true;
  } catch { return false; }
}
