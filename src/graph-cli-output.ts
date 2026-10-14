/** Only the executable owns process exit status; reusable graph readers do not. */
export function createGraphCliWriter(
  write: (line: string) => void = console.log,
  fail: () => void = () => { process.exitCode = 1; },
): (line: string) => void {
  return (line) => {
    // Preserve every JSONL record byte-for-byte, including errors.
    const record: unknown = JSON.parse(line);
    if (record !== null && typeof record === "object" && "type" in record && record.type === "error") fail();
    write(line);
  };
}
