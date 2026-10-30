/** Parse bounded JSON with line/block comments and trailing commas, without a compiler. */
export function parseJsonc(text: string): unknown {
  if (text.length > 1_048_576) throw new RangeError("JSONC input exceeds 1 MiB");
  const chars = [...text];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "/" && chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n" && chars[i] !== "\r") chars[i++] = " ";
    } else if (char === "/" && chars[i + 1] === "*") {
      chars[i++] = " ";
      chars[i++] = " ";
      while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) {
        chars[i++] = " ";
      }
      if (i >= chars.length) throw new SyntaxError("Unterminated JSONC comment");
      chars[i++] = " ";
      chars[i] = " ";
    }
  }

  // Comments are now whitespace. A second string-aware pass removes only
  // commas after a value, leaving missing values (such as [1,,]) invalid.
  let previous = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "," && previous && !"[{:,".includes(previous)) {
      let next = i + 1;
      while (next < chars.length && /[ \t\r\n]/.test(chars[next])) next++;
      if (chars[next] === "]" || chars[next] === "}") chars[i] = " ";
    }
    if (!/[ \t\r\n]/.test(char)) previous = char;
  }
  return JSON.parse(chars.join(""));
}
