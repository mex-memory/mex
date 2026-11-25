export function SetupText({ text }: { text: string }) {
  return text.split(/(`[^`\n]+`)/u).map((part, index) => index % 2 ? <code key={index}>{part.slice(1, -1)}</code> : part);
}
