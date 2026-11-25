export function timestampNs(value: string): bigint | undefined {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  const fraction = (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/u)?.[1] ?? "").padEnd(9, "0").slice(3, 9);
  return BigInt(milliseconds) * 1_000_000n + BigInt(fraction || "0");
}
