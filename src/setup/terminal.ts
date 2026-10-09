import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AI_TOOLS, type AiTool } from "../types.js";
import { loadConfiguredAiTools } from "../config.js";
import { isCliAvailable } from "../cli-tools.js";
import {
  ensureToolAnchors, findSetupProjectRoot, installSetupAgentAssets, isScaffoldPopulated,
  type SetupRunOptions, type SetupRunResult,
} from "./index.js";
import { createSetupScaffold, resolveSetupMode, setupTemplatesDirectory, throwIfSetupAborted } from "./phases.js";
import { runHeadlessSetup, type HeadlessSetupResult } from "./headless.js";
import { SetupError } from "./errors.js";
import { classifySetupAgentAssetsError } from "./agent-errors.js";
import { selectSetupAgent } from "./population.js";
import { formatSetupGraphActivity, setupGraphActivity } from "./graph-progress.js";
import type { TerminalSetupAction, TerminalSetupView } from "./terminal-ui.js";

const CONTINUE = "Run `mex setup` to continue. Existing authored files are preserved.";

/** The terminal owns presentation and interaction; all writes use the shared setup engine. */
export async function runTerminalSetup(options: SetupRunOptions): Promise<SetupRunResult> {
  const projectRoot = findSetupProjectRoot();
  const mexDir = resolve(projectRoot, ".mex");
  const mode = resolveSetupMode(mexDir, options.mode);
  const selectedTools = [...new Set(options.tools ?? loadConfiguredAiTools(mexDir))];
  if (options.dryRun) return previewSetup(projectRoot, mode, selectedTools, options.tools !== undefined);
  const interactive = Boolean(stdin.isTTY && stdout.isTTY && !options.yes && !process.env.CI && process.env.TERM !== "dumb");
  const abort = new AbortController();
  let cancelCode = 130;
  let cancellationDetail = "";
  let nativeSession = false;
  let notifyCancel = () => {};
  const cancel = (code = 130) => {
    cancelCode = code;
    abort.abort();
    notifyCancel();
  };
  // In a native session Ctrl+C belongs to the agent. SIGTERM still stops the owned run.
  const interrupt = () => { if (!nativeSession) cancel(); };
  const terminate = () => cancel(143);
  const endInput = () => { if (!nativeSession) cancel(); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  if (interactive) stdin.on("end", endInput);
  try {
    if (!interactive) {
      console.log(`MEX setup · ${basename(projectRoot)} · ${mode}`);
      let lastGraphPhase = "";
      let lastGraphLogAt = 0;
      const result = await runHeadlessSetup({
        projectRoot, mode, tools: selectedTools, confirmPopulation: true, signal: abort.signal,
        onProgress: update => console.log(`${update.label}${update.detail ? ` — ${update.detail}` : ""}`),
        onMessage: message => console.log(message),
        onGraphProgress: progress => {
          const now = Date.now();
          if (progress.phase !== lastGraphPhase || now - lastGraphLogAt >= 1000
            || (progress.total !== undefined && progress.completed === progress.total)) {
            console.log(formatSetupGraphActivity(progress));
            lastGraphPhase = progress.phase;
            lastGraphLogAt = now;
          }
        },
      });
      for (const note of result.anchorNotes) console.log(`Action needed: ${note}`);
      if (!result.ready) {
        console.log(`\nSetup paused: scaffold population is still required.\n${CONTINUE}`);
        if (result.prompt) console.log(`\nPopulation prompt:\n\n${result.prompt}`);
        return { outcome: "paused", exitCode: 2, message: "Scaffold population is still required." };
      }
      console.log(result.message);
      console.log("Run `mex setup --browser` to open the setup completion page.");
      return { outcome: "complete", exitCode: 0, message: result.message };
    }

    const { createTerminalSetupUI } = await import("./terminal-ui.js");
    let view: TerminalSetupView = {
      projectName: basename(projectRoot), mode, screen: "configure", startedAt: Date.now(),
      completedSteps: [], detail: "Highlight a tool and press Enter to select it and begin. Space optionally selects additional tools.",
      initialTool: selectedTools[0] ?? (options.tools?.length === 0 ? "continue" : undefined),
      tools: (Object.keys(AI_TOOLS) as AiTool[]).map(id => ({
        id, name: AI_TOOLS[id].name, selected: selectedTools.includes(id),
        cliAvailable: AI_TOOLS[id].cli !== null && isCliAvailable(AI_TOOLS[id].cli!),
      })),
    };
    let pending: ((action: TerminalSetupAction) => void) | undefined;
    const update = (changes: Partial<TerminalSetupView>) => {
      view = { ...view, ...changes };
      ui.update(view);
    };
    const ui = createTerminalSetupUI(view, action => {
      if (action.type === "cancel") { cancel(); return; }
      if (action.type === "toggle" && view.screen === "configure") {
        update({ tools: view.tools.map(tool => tool.id === action.tool ? { ...tool, selected: !tool.selected } : tool) });
        return;
      }
      pending?.(action);
    });
    const choose = (): Promise<TerminalSetupAction> => {
      if (abort.signal.aborted) return Promise.resolve({ type: "cancel" });
      return new Promise(resolve => {
        pending = action => { pending = undefined; resolve(action); };
      });
    };
    notifyCancel = () => {
      update({ stopping: true, detail: "Stopping setup safely. Waiting for the active operation to settle…" });
      pending?.({ type: "cancel" });
    };
    let outcome: SetupRunResult | undefined;
    let validated: HeadlessSetupResult | undefined;
    let anchorNotes: readonly string[] = [];
    let populationFailure: string | undefined;
    try {
      const action = await choose();
      if (action.type !== "start") throwIfSetupAborted(abort.signal);
      const focusedTool = action.type === "start" ? action.tool : undefined;
      if (focusedTool) {
        update({ tools: view.tools.map(tool => tool.id === focusedTool ? { ...tool, selected: true } : tool) });
      }
      const chosen = new Set(view.tools.filter(tool => tool.selected).map(tool => tool.id));
      // Enter explicitly chooses the preferred tool. Other selected integrations
      // retain their saved order; the Continue row uses that order unchanged.
      const tools = [...new Set([
        ...(focusedTool ? [focusedTool] : []),
        ...selectedTools.filter(tool => chosen.has(tool)),
        ...chosen,
      ])];
      while (!outcome) {
        try {
          if (!validated) {
            update({ screen: "progress", activeStep: undefined, completedSteps: [], error: undefined, stopping: false,
              phaseStartedAt: Date.now(), lastActivityAt: Date.now(), progress: undefined });
            const result = await runHeadlessSetup({
              projectRoot, mode, tools, signal: abort.signal,
              onProgress: progress => update({
                activeStep: progress.step,
                completedSteps: view.activeStep ? [...new Set([...view.completedSteps, view.activeStep])] : view.completedSteps,
                detail: progress.detail ?? progress.label,
                phaseStartedAt: Date.now(),
                lastActivityAt: Date.now(),
                progress: undefined,
              }),
              onMessage: detail => update({ detail, lastActivityAt: Date.now() }),
              onGraphProgress: progress => {
                const activity = setupGraphActivity(progress);
                update({ detail: activity.detail, progress: activity.progress, lastActivityAt: Date.now() });
              },
              onAnchorNotes: notes => { anchorNotes = notes; },
              populate: async input => {
                let tool = selectSetupAgent(input.selectedTools);
                let first = true;
                let detail = tool
                  ? `Opening ${AI_TOOLS[tool].name} with your setup instructions. Exit the agent session to return to MEX.`
                  : "No selected Claude Code or Codex CLI is available. Use the manual prompt, then check again.";
                while (!abort.signal.aborted) {
                  tool = selectSetupAgent(input.selectedTools);
                  update({ screen: "population", detail, populationAgent: tool ? AI_TOOLS[tool].name : null });
                  const action = first && tool ? { type: "agent" as const } : await choose();
                  first = false;
                  if (action.type === "cancel") throwIfSetupAborted(abort.signal);
                  if (action.type === "exit") return { tool, completed: false };
                  if (action.type === "agent" && tool) {
                    const { launchInteractiveSetupPopulation } = await import("./interactive-population.js");
                    await ui.suspend();
                    nativeSession = true;
                    let launched;
                    try {
                      console.log(`\nOpening ${AI_TOOLS[tool].name} with your setup instructions. Exit the agent session to return to MEX.\n`);
                      launched = await launchInteractiveSetupPopulation(input);
                    }
                    finally { nativeSession = false; ui.resume(view); }
                    if (abort.signal.aborted) cancellationDetail = launched.message ?? "";
                    throwIfSetupAborted(abort.signal);
                    populationFailure = launched.status === "failed" ? launched.message ?? "The agent failed." : undefined;
                    if (launched.status === "exited" && isScaffoldPopulated(mexDir)) {
                      update({ screen: "progress" });
                      return { tool: launched.tool, completed: true };
                    }
                    detail = launched.status === "exited"
                      ? "The agent exited, but required scaffold placeholders remain. Reopen the session or finish manually."
                      : launched.message ?? `The agent ${launched.status === "cancelled" ? "was interrupted" : "failed"}. Reopen it or use the manual prompt.`;
                  } else if (action.type === "prompt") {
                    await ui.suspend();
                    // Ink releases its stdin reference on unmount. Readline alone
                    // does not restore it, so keep the process alive for this question.
                    stdin.ref();
                    let rl: ReturnType<typeof createInterface> | undefined;
                    const closeInput = () => cancel();
                    try {
                      console.log(`\nCopy this prompt into your AI tool:\n\n${input.prompt}\n`);
                      rl = createInterface({ input: stdin, output: stdout });
                      rl.once("SIGINT", closeInput);
                      rl.once("close", closeInput);
                      await rl.question("Press Enter to return to MEX…", { signal: abort.signal });
                    }
                    finally {
                      rl?.off("SIGINT", closeInput);
                      rl?.off("close", closeInput);
                      rl?.close();
                      ui.resume(view);
                    }
                  } else if (action.type === "check") {
                    if (isScaffoldPopulated(mexDir)) {
                      update({ screen: "progress" });
                      return { tool, completed: true };
                    }
                    detail = "Required scaffold placeholders remain. Finish population, then choose Check again.";
                  }
                }
                throwIfSetupAborted(abort.signal);
                return { tool, completed: false };
              },
            });
            if (!result.ready) {
              outcome = { outcome: populationFailure ? "failed" : "paused", exitCode: populationFailure ? 1 : 2,
                message: `${populationFailure ? `Setup failed: ${populationFailure}` : "Setup paused at population."} ${CONTINUE}` };
              continue;
            }
            validated = result;
          }
          throwIfSetupAborted(abort.signal);
          update({ screen: "progress", completedSteps: view.activeStep ? [...new Set([...view.completedSteps, view.activeStep])] : view.completedSteps,
            activeStep: undefined, phaseStartedAt: Date.now(), lastActivityAt: Date.now(), progress: undefined,
            detail: "Opening the setup completion page…", error: undefined });
          const { runSetupHubCommand } = await import("../hub/command.js");
          let listening = false;
          await runSetupHubCommand({
            projectRoot, initialMode: mode, port: options.port, openBrowser: options.openBrowser !== false,
            signal: abort.signal,
            onListening: ({ bootstrapUrl }) => { listening = true; update({ screen: "hub", hubUrl: bootstrapUrl,
              detail: mode === "code-repo"
                ? "Continue in your browser to review the setup commit, finish optional details, and open Hub."
                : "Agent memory is ready. Finish the optional details in your browser." }); },
            onMessage: detail => update({ detail }),
          });
          if (!listening) throwIfSetupAborted(abort.signal);
          outcome = { outcome: "complete", exitCode: 0, message: `${validated.message} Hub stopped. Run \`mex setup\` to reopen the completion page.` };
        } catch (error) {
          if (abort.signal.aborted) throw error;
          const detail = error instanceof SetupError ? error.userMessage : error instanceof Error ? error.message : String(error);
          const rawDiagnostic = error instanceof Error && error.message !== detail ? error.message : undefined;
          const diagnostic = rawDiagnostic ? `\nDiagnostics: ${rawDiagnostic}` : "";
          const recovery = `${validated ? "Setup is ready; the Hub could not start." : "Setup could not finish."} Resolve the problem and retry.`;
          update({ screen: "error", error: detail, detail: rawDiagnostic ? `${rawDiagnostic}\n${recovery}` : recovery, stopping: false });
          const action = await choose();
          throwIfSetupAborted(abort.signal);
          if (action.type !== "retry") outcome = { outcome: "failed", exitCode: 1, message: `${detail}${diagnostic}\n${CONTINUE}` };
        }
      }
    } finally {
      notifyCancel = () => {};
      await ui.close();
      for (const note of anchorNotes) console.log(`Action needed: ${note}`);
    }
    console.log(outcome.message);
    return outcome;
  } catch (error) {
    if (abort.signal.aborted) {
      const message = `Setup cancelled. ${cancellationDetail ? `${cancellationDetail} ` : ""}${CONTINUE}`;
      console.log(message);
      return { outcome: "cancelled", exitCode: cancelCode, message };
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    stdin.removeListener("end", endInput);
  }
}

function previewSetup(projectRoot: string, mode: "code-repo" | "agent-memory", tools: AiTool[], explicit: boolean): SetupRunResult {
  console.log(`MEX setup · DRY RUN · ${mode === "agent-memory" ? "agent-memory workspace" : basename(projectRoot)}`);
  console.log("No files will be created or modified.");
  if (mode === "code-repo" && !existsSync(resolve(projectRoot, ".git"))) {
    throw new SetupError("No Git repository found. Run `git init` first, then rerun setup.");
  }
  console.log(`Using ${explicit ? "requested" : "configured"} AI tools: ${tools.map(tool => AI_TOOLS[tool].name).join(", ") || "none"}`);
  createSetupScaffold({ projectRoot, mode, dryRun: true,
    onIgnore: message => console.log(message),
    onFile: (file, action) => console.log(`${action === "skip" ? "Keep" : "Would create"} .mex/${file}`),
  });
  ensureToolAnchors(projectRoot, setupTemplatesDirectory(), tools, true);
  try {
    const assets = installSetupAgentAssets({ projectRoot, selectedTools: tools, dryRun: true, checkIgnored: mode === "code-repo" });
    for (const action of assets?.actions ?? []) console.log(action.message);
    for (const warning of assets?.warnings ?? []) console.log(warning.message);
    if (assets?.conflicted) throw new SetupError("Official MEX agent assets have conflicts. Review `mex skills sync --dry-run` before applying setup.");
  } catch (error) { throw classifySetupAgentAssetsError(error) ?? error; }
  console.log("Would verify or assign the project identity.");
  if (mode === "code-repo") console.log("Would build the code graph before population.");
  console.log(isScaffoldPopulated(resolve(projectRoot, ".mex"))
    ? "Would preserve and verify the populated scaffold."
    : "Would populate the scaffold with a selected agent or the manual prompt.");
  if (mode === "code-repo") console.log("Would capture grounding, migrate and index Wiki, then validate the result.");
  console.log("Interactive setup would then open the Hub completion page.");
  const message = "Dry run complete. Population and validation were not run.";
  console.log(message);
  return { outcome: "dry-run", exitCode: 0, message };
}
