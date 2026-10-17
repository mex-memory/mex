/**
 * Minimum Node.js release, matching `engines.node` in package.json. npm only
 * warns when engines are unmet, so the CLI checks this itself at startup (#275)
 * instead of failing later inside the code graph.
 */
export const MINIMUM_NODE_VERSION = "22.5";

/**
 * Return the message to print when `version` (as in `process.versions.node`)
 * is older than {@link MINIMUM_NODE_VERSION}, or null when it is supported.
 */
export function unsupportedNodeMessage(version: string): string | null {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [requiredMajor = 0, requiredMinor = 0] = MINIMUM_NODE_VERSION.split(".").map(Number);
  if (major > requiredMajor || (major === requiredMajor && minor >= requiredMinor)) return null;
  return [
    `mex requires Node.js ${MINIMUM_NODE_VERSION} or newer. You are running Node.js ${version}.`,
    "Upgrade Node.js (download it from https://nodejs.org, or run `nvm install 22` if you use nvm), then run mex again.",
  ].join("\n");
}
