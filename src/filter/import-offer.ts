import { createInterface } from "node:readline";
import { openRecord, openRecordReadOnly } from "../record/index.js";
import { ensureBackground, markPending, queueJob } from "../record/background.js";
import { checkoutOn } from "../controls/index.js";
import { importLearningOn, sessionLearningAvailable, SESSION_LEARN_KIND, SESSION_LEARNING_UNAVAILABLE, sessionRunner,
  setSessionRunner, type SessionRunner, type SessionRunnerMode } from "../knowledge/session-learning.js";
import { previewImport, importsEnabled } from "../learn-deeper/session-import.js";
import { reviewWindow } from "../learn-deeper/plan.js";
import { SESSION_API_DAILY_UNITS, SESSION_API_KEY, SESSION_API_RATES, sessionApiKey } from "../model-runner/session-api-policy.js";
import { ackKey } from "./input.js";
import { importSession, SessionImportPlan } from "./import-data.js";

type Prompt = (question: string) => Promise<string | undefined>;
type Display = { write: (line: string) => void; interactive: boolean; ask?: Prompt };
type ImportOffer = Display & { root: string; projectId: string; dryRun?: boolean; now?: number; wake?: boolean };
const estimate = (sessions: number) => ({ input: sessions * 8_000 + 25_000, output: sessions * 800 + 2200 });
const dollars = (input: number, output: number) => ((input * SESSION_API_RATES.input + output * SESSION_API_RATES.output) / 1e9).toFixed(2);
const units = (n: number) => n.toLocaleString("en-US");
const dayUse = estimate(8);
const apiCap = (SESSION_API_DAILY_UNITS / 1e9).toFixed(2);

function askTerminal(question: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    reader.once("close", () => resolve(undefined));
    reader.question(question, answer => { resolve(answer); reader.close(); });
  });
}

/** The prompt always shows the same workload for the three choices. Enter leaves the setting alone. */
export async function offerSessionRunner({ write, interactive, ask = askTerminal }: Display): Promise<SessionRunner | undefined> {
  if (!sessionLearningAvailable()) throw new Error(SESSION_LEARNING_UNAVAILABLE);
  write("Choose how MEX learns from your sessions. Daily example uses eight sessions and one checked writing pass.");
  write(`1. Agent CLI · estimated ${units(dayUse.input + dayUse.output)} tokens/day in that example. Uses the CLI's configured account and the 3% automatic allowance.`);
  write(`2. OpenAI API key · estimated $${dollars(dayUse.input, dayUse.output)}/day in that example, with a $${apiCap} daily MEX allowance at reference rates. OpenAI bills your key separately.`);
  write("3. No AI · 0 model tokens/day. Explicit notes and exact host-memory matches stay local.");
  if (!interactive) { write("Run `mex learn --runner` in your terminal to choose. No runner setting was changed."); return; }
  const answer = (await ask("Choose [1/2/3], or press Enter to keep your choice: "))?.trim();
  const choices: Record<string, SessionRunnerMode> = { "1": "cli", "2": "api", "3": "none" };
  const mode = answer && /^[123]$/u.test(answer) ? choices[answer] : undefined;
  if (!mode) return;
  const writer = openRecord({ create: true });
  try {
    const saved = setSessionRunner(writer, mode);
    // Waiting jobs may resume with a new preference even after the worker idled out.
    markPending(writer);
    write(`Session learning runner set to ${mode === "cli" ? "agent CLI" : mode === "api" ? "OpenAI API" : "no AI"}. Change it with \`mex learn --runner\`.`);
    if (mode === "api") {
      if (sessionApiKey() && process.env.MEX_SETUP_BACKGROUND_AGENTS !== "0")
        ensureBackground({ home: writer.location.home, refreshEnvironment: true });
      else write(`Set ${SESSION_API_KEY} in your terminal and choose the API runner there to load the key into the MEX worker.`);
    }
    return saved;
  } finally { writer.close(); }
}

export function sessionImportDue({ root, projectId }: { root: string; projectId: string }): boolean {
  const reader = openRecordReadOnly();
  try {
    const row = reader?.checkout(root);
    return !!reader && !!row && row.project_id === projectId && checkoutOn(row) && importLearningOn(reader)
      && importsEnabled(reader, projectId) && !reader.get("SELECT 1 FROM jobs WHERE project_id=? AND kind=?", projectId, SESSION_LEARN_KIND);
  } finally { reader?.close(); }
}

/** Preview uses bounded local reads. Only an affirmative answer writes the pinned plan. */
export async function offerSessionImport({ root, projectId, write, interactive, ask = askTerminal, dryRun, now = Date.now(), wake = true }: ImportOffer): Promise<void> {
  const reader = openRecordReadOnly();
  if (!reader) return;
  const window = reviewWindow(new Date(now));
  let preview: ReturnType<typeof previewImport>, runner: SessionRunner | undefined;
  try {
    const checkout = reader.checkout(root);
    if (!checkout || checkout.project_id !== projectId || !checkoutOn(checkout) || process.env.MEX_OFF === "1" || reader.setting("global", "enabled") === "false"
      || !importLearningOn(reader) || !importsEnabled(reader, projectId)) { write("Past-session learning is off here."); return; }
    preview = previewImport({ checkout: root, project: projectId, window, store: reader, now, sessionLearning: true });
    preview.files = preview.files.filter(file => !reader.setting(projectId, ackKey(importSession(file))));
    runner = sessionRunner(reader);
  } finally { reader.close(); }
  const sessions = preview.files.length;
  const messages = preview.files.reduce((n, file) => n + file.messages, 0);
  write(`Past-session preview found ${sessions} ${sessions === 1 ? "session" : "sessions"} and ${messages} eligible ${messages === 1 ? "prompt" : "prompts"} for this checkout.`);
  preview.gaps.forEach(write);
  if (dryRun || !sessions || !interactive) {
    write(dryRun ? "Preview only · $0." : sessions ? "Run `mex learn --sessions` in your terminal to approve the import." : "There are no eligible sessions to import.");
    return;
  }
  runner ??= await offerSessionRunner({ write, interactive, ask });
  if (!runner) return;
  const quote = estimate(sessions);
  const tokens = runner.mode === "none" ? 0 : quote.input + quote.output;
  write(runner.mode === "none" ? "Expected model use for the import is zero."
    : runner.mode === "api" ? `Estimated API use is $${dollars(quote.input, quote.output)} for this import, with the $${apiCap} daily MEX allowance. A retry can add tokens.`
    : `Estimated CLI use is ${units(tokens)} tokens for this import, within the automatic allowance. A retry can add tokens.`);
  const at = (await ask("Import exactly these past sessions? [y/N] "))?.trim();
  if (!at || !/^y(?:es)?$/iu.test(at)) return;
  const plan = SessionImportPlan.parse({ checkout: root, window, mode: runner.mode, files: preview.files, gaps: preview.gaps.slice(0, 16) });
  const writer = openRecord();
  try {
    const checkout = writer.checkout(root);
    if (!checkout || checkout.project_id !== projectId || !checkoutOn(checkout) || writer.setting("global", "enabled") === "false"
      || !importLearningOn(writer) || !importsEnabled(writer, projectId) || sessionRunner(writer)?.revision !== runner.revision) {
      throw new Error("The checkout or runner changed. Review a new past-session preview.");
    }
    const result = queueJob(writer, { kind: SESSION_LEARN_KIND, projectId, params: plan, tokensEstimate: tokens });
    if (wake) ensureBackground({ home: writer.location.home });
    write(result.existing ? "A past-session import is already queued here. See `mex jobs`." : "Past-session import approved. See `mex jobs` for progress.");
  } finally { writer.close(); }
}
