/** Canonical Log notes are opaque authored content, owned by the note writer. */
export function isLogOwnedPath(path: string): boolean {
  return /^events\/notes(?:\/|$)/.test(path.replace(/\\/g, "/").toLowerCase());
}
