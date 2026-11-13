/**
 * Scope globs for index reads, the same dialect in Go (native/index/glob.go):
 * paths are relative to the checkout and `/`-separated; the glob is anchored
 * at the checkout root. A `**` segment matches any number of folders, `*`
 * anything within one segment, `?` one character within a segment, and
 * `{a,b}` either alternative (inside one segment, no nesting). A trailing `/`
 * means everything below. Every other character matches itself.
 */

export function normalizeGlob(glob: string): string {
  let value = glob.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (value === "") value = "**";
  if (value.endsWith("/")) value += "**";
  return value;
}

export function globToRegExp(glob: string): RegExp {
  const segments = normalizeGlob(glob).split("/").filter((segment, index, all) => !(segment === "**" && all[index - 1] === "**"));
  let out = "";
  let needSlash = false;
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      if (last) out += index === 0 ? ".*" : "(?:/.*)?";
      else { out += index === 0 ? "(?:.*/)?" : "/(?:.*/)?"; needSlash = false; }
      return;
    }
    if (needSlash) out += "/";
    out += segmentSource(segment);
    needSlash = true;
  });
  return new RegExp(`^${out}$`);
}

function segmentSource(segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;
    if (char === "*") { out += "[^/]*"; continue; }
    if (char === "?") { out += "[^/]"; continue; }
    if (char === "{") {
      const close = segment.indexOf("}", i);
      if (close > i) {
        out += `(?:${segment.slice(i + 1, close).split(",").map(segmentSource).join("|")})`;
        i = close;
        continue;
      }
    }
    out += /[.+^$()|[\]\\{}]/.test(char) ? `\\${char}` : char;
  }
  return out;
}

/** The literal text every match starts with, used for a range scan before the regular expression. */
export function globPrefix(glob: string): string {
  const value = normalizeGlob(glob);
  const wildcard = value.search(/[*?{]/);
  return wildcard < 0 ? value : value.slice(0, wildcard);
}
