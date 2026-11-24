/** What the terminal says after a wait or a drop, so a shared copy and a loaded rule file stay visible. */
export function reviewBoundaryNotes(sharedIds: readonly string[], sessionActive: boolean): string[] {
  const lines = [
    sessionActive
      ? "Rule text an agent has already loaded stays until that agent starts again."
      : "Generated rule files are rebuilt when no agent session is running.",
  ];
  if (sharedIds.length) lines.unshift(`Shared copies of ${sharedIds.join(", ")} are separate and stay as the team left them.`);
  return lines;
}
