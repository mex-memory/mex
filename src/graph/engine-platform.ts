const GRAPH_PLATFORMS = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);

export function graphPlatformPackage(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const target = `${platform}-${arch}`;
  return GRAPH_PLATFORMS.has(target) ? `mex-agent-graph-${target}` : undefined;
}
