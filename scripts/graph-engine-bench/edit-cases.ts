// Synthetic edits touch only disposable benchmark checkouts.
export const benchmarkFiles = {
  hono: "src/hono-base.ts",
  flask: "src/flask/app.py",
  ripgrep: "crates/core/main.rs",
  nest: "packages/core/nest-factory.ts",
  novu: "apps/api/src/app.module.ts",
} as const;

export function commentFor(file: string): string {
  return file.endsWith(".py") ? "# warm edit\n" : "// warm edit\n";
}

export function insertCall(file: string, source: string): string {
  const insertions: Record<string, [RegExp, string]> = {
    [benchmarkFiles.hono]: [/^  constructor\(options: HonoOptions<E> = \{\}\) \{\r?$/m, "    this.getPath();"],
    [benchmarkFiles.flask]: [/^    def dispatch_request\(self\) -> ft.ResponseReturnValue:\r?$/m, "        self.ensure_sync(self.dispatch_request)"],
    [benchmarkFiles.ripgrep]: [/^fn main\(\) -> ExitCode \{\r?$/m, "    eprint_nothing_searched();"],
    [benchmarkFiles.nest]: [/^  private handleInitializationError\(err: unknown\) \{\r?$/m, "    this.setAbortOnError();"],
    [benchmarkFiles.novu]: [/^const enterpriseImports = .* => \{\r?$/m, "  isClerkEnabled();"],
  };
  const insertion = insertions[file];
  if (!insertion) throw new Error(`No function-body edit defined for ${file}`);
  const [anchor, call] = insertion;
  return replaceOnce(source, anchor, header => `${header}\n${call}`);
}

const exportMarker = "mexWarmExport";
export function changeExport(file: string, source: string): string {
  if (file.endsWith(".py")) {
    const declaration = `\ndef ${exportMarker}():\n    return 73\n`;
    return source.includes(declaration) ? source.replace(declaration, "") : source + declaration;
  }
  const language = file.endsWith(".rs") ? "rust" : "typescript";
  const declaration = language === "rust"
    ? `\npub fn ${exportMarker}() -> u32 { 73 }\n`
    : `\nexport function ${exportMarker}() { return 73 }\n`;
  return source.includes(declaration) ? source.replace(declaration, "") : source + declaration;
}

function replaceOnce(source: string, anchor: RegExp, replace: (match: string) => string): string {
  if (!anchor.test(source)) throw new Error(`Function anchor did not match: ${anchor}`);
  return source.replace(anchor, replace);
}
