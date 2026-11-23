/** The JSON in a model's reply. Some put it in a code fence or between sentences, though asked for JSON only. */
export function replyJson(text: string): unknown {
  const parse = (json: string) => { try { return JSON.parse(json) as unknown; } catch { return undefined; } };
  const whole = parse(text.trim());
  if (whole !== undefined) return whole;
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  return start < 0 || end < start ? undefined : parse(text.slice(start, end + 1));
}
