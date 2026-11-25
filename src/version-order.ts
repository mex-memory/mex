const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*))?$/;
export function isVersion(value: string): boolean {
  return value.length <= 80 && semver.test(value);
}

export function newerVersion(candidate: string, current: string): boolean {
  const next = semver.exec(candidate), old = semver.exec(current);
  if (!next || !old || candidate.length > 80 || current.length > 80) return false;
  for (let i = 1; i <= 3; i++) { if (next[i] !== old[i]) return BigInt(next[i]) > BigInt(old[i]); }
  if (!next[4]) return !!old[4];
  if (!old[4]) return false;
  const a = next[4].split("."), b = old[4].split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined) return false;
    if (b[i] === undefined) return true;
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const left = BigInt(a[i]), right = BigInt(b[i]);
      if (left !== right) return left > right;
      continue;
    }
    if (an !== bn) return !an;
    return a[i] > b[i];
  }
  return false;
}
