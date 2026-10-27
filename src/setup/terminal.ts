import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { AI_TOOLS, type AiTool } from "../types.js";
import { BACKGROUND_AGENT_CLIS, isBackgroundAgentTool } from "../agent-command.js";
import { loadConfiguredAiTools, loadConfiguredSetupMode } from "../config.js";
import { isCliAvailable } from "../cli-tools.js";
import {
  ensureToolAnchors, findSetupProjectRoot, installSetupAgentAssets, isScaffoldPopulated, setupCommitCheckpointCommands,
  type SetupRunOptions, type SetupRunResult,
} from "./index.js";
import {
  createSetupScaffold, requireSetupGitRepository, resolveSetupMode, setupTemplatesDirectory, throwIfSetupAborted,
} from "./phases.js";
import { assessSetupHealth, describeSetupHealth } from "./health.js";
import { runHeadlessSetup, type HeadlessSetupResult } from "./headless.js";
import { SetupError } from "./errors.js";
import { classifySetupAgentAssetsError } from "./agent-errors.js";
import { selectSetupAgent } from "./population.js";
import { formatSetupGraphActivity, setupGraphActivity } from "./graph-progress.js";
import type { TerminalSetupAction, TerminalSetupView } from "./terminal-ui.js";
import { appendTerminalSetupEvent } from "./terminal-events.js";
import { SETUP_HANDOFF_PROMPT, describeUnfinishedSetup } from "./unfinished.js";
import { waitForTerminalReturn } from "./terminal-return.js";
import { assertSetupAvailable } from "./setup-lock.js";

const CONTINUE = "Run `mex setup` to continue. Existing authored files are preserved.";
const AGENT_CONTINUE = "\nYou are the population agent. Follow the prompt below in this session.\n"
  + "When done, run `mex setup` again to finalize. Existing authored files are preserved.\n"
  + "Do not commit until setup reports complete (`mex setup` exits with code 0).";

/** The terminal owns presentation and interaction; all writes use the shared setup engine. */
export async function runTerminalSetup(options: SetupRunOptions): Promise<SetupRunResult> {
  const projectRoot = findSetupProjectRoot();
  const mexDir = resolve(projectRoot, ".mex");
  const mode = resolveSetupMode(mexDir, options.mode);
  const selectedTools = [...new Set(options.tools ?? loadConfiguredAiTools(mexDir))];
  if (options.dryRun) return previewSetup(projectRoot, mode, selectedTools, options.tools !== undefined);
  // Before the tool picker: a choice the engine would then refuse is wasted (#287).
  requireSetupGitRepository(projectRoot, mode);
  assertSetupAvailable(mexDir);
  const hasTerminal = Boolean(stdin.isTTY && stdout.isTTY);
  const interactive = hasTerminal && !options.yes && !process.env.CI && process.env.TERM !== "dumb";
  // Status first (#284): a rerun over an existing scaffold reports instead of
  // redoing work, unless --force asks for the full flow or the person asks for
  // a different mode or tool set, which only the flow can apply.
  const health = !options.force && existsSync(resolve(mexDir, "ROUTER.md"))
    && mode === loadConfiguredSetupMode(mexDir)
    && (options.tools === undefined || sameTools(options.tools, loadConfiguredAiTools(mexDir)))
    ? await assessSetupHealth(projectRoot)
    : undefined;
  if (health?.healthy) {
    console.log(describeSetupHealth(health));
    return { outcome: "complete", exitCode: 0, message: health.summary };
  }
  if (health?.needsCommitOnly && !interactive) {
    const message = "MEX is prepared here but the setup is not committed yet. Run `mex setup --browser` to review and commit it.";
    console.log([message, ...health.notes].join("\n"));
    return { outcome: "complete", exitCode: 0, message };
  }
  if (health && health.missing.length > 0 && !interactive) {
    console.log(`Setup will finish what is missing:\n${health.missing.map(item => `- ${item}`).join("\n")}`);
  }
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
      const unfinished = describeUnfinishedSetup(projectRoot);
      if (unfinished) console.log(hasTerminal ? unfinished.line
        : `MEX setup ${unfinished.done}/${unfinished.total}, not finished. To continue, run \`mex setup next --start\` in this session and do what it prints.`);
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
        const handoff = result.prompt === SETUP_HANDOFF_PROMPT;
        console.log("\nSetup paused: scaffold population is still required.");
        if (hasTerminal) console.log(handoff ? result.message : CONTINUE);
        else if (handoff) console.log("You are the population agent. Run `mex setup next --start` in this session and do exactly what it prints.\n"
          + "Repeat until it prints that setup is complete. Existing authored files are preserved.\n"
          + "Do not commit until setup reports complete.");
        else {
          console.log(result.message);
          console.log(result.prompt ? AGENT_CONTINUE
            : "Run `mex setup` again to continue. Existing authored files are preserved.\nDo not commit until setup reports complete (`mex setup` exits with code 0).");
        }
        if (result.prompt) console.log(`\nPopulation prompt${handoff && hasTerminal ? " (paste it into your agent)" : ""}:\n\n${result.prompt}`);
        return { outcome: "paused", exitCode: 2, message: "Scaffold population is still required." };
      }
      console.log(result.message);
      console.log("Run `mex setup --browser` to open the setup completion page.");
      return { outcome: "complete", exitCode: 0, message: result.message };
    }

    const { createTerminalSetupUI } = await import("./terminal-ui.js");
    const unfinishedAtStart = describeUnfinishedSetup(projectRoot);
    let view: TerminalSetupView = {
      projectName: basename(projectRoot), mode, screen: "configure", startedAt: Date.now(),
      completedSteps: [], detail: `${unfinishedAtStart ? `${unfinishedAtStart.line} ` : ""}Highlight a tool and press Enter to select it and begin. Space optionally selects additional tools.`,
      initialTool: selectedTools[0] ?? (options.tools?.length === 0 ? "continue" : undefined),
      tools: (Object.keys(AI_TOOLS) as AiTool[]).map(id => ({
        id, name: AI_TOOLS[id].name, selected: selectedTools.includes(id),
        cliAvailable: isBackgroundAgentTool(id) && isCliAvailable(BACKGROUND_AGENT_CLIS[id]),
      })),
    };
    let pending: ((action: TerminalSetupAction) => void) | undefined;
    const update = (changes: Partial<TerminalSetupView>) => {
      view = { ...view, ...changes,
        events: changes.detail ? appendTerminalSetupEvent(view.events ?? [], changes.detail) : view.events };
      ui.update(view);
    };
    const ui = createTerminalSetupUI(view, action => {
      if (action.type === "cancel") { cancel(); return; }
      if (action.type === "toggle" && view.screen === "configure") {
        update({ tools: view.tools.map(tool => tool.id === action.tool ? { ...tool, selected: !tool.selected } : tool) });
        return;
      }
      if (action.type === "link" && view.hubUrl) {
        // Suspend only after Ink's input handler returns. Unmounting inside it
        // leaves Ink's read loop to start a cooked read that steals the Enter.
        queueMicrotask(() => void showHubLink());
        return;
      }
      pending?.(action);
    });
    // Setup can finish in the browser while the link is shown; closing releases the wait.
    let linkWait: AbortController | undefined;
    const showHubLink = async () => {
      const release = new AbortController();
      linkWait = release;
      try {
        await ui.suspend();
        // Outside the frame, terminal wrapping adds no border characters to a copy.
        console.log(`\nHub link (keep it private):\n${view.hubUrl}\n`);
        if (await pressEnterToReturn(AbortSignal.any([abort.signal, release.signal])) === "cancel"
          && !abort.signal.aborted && !release.signal.aborted) cancel();
      } catch (error) {
        if (!abort.signal.aborted) update({ detail: error instanceof Error ? error.message : "Could not show the Hub link." });
      } finally {
        if (linkWait === release) linkWait = undefined;
        ui.resume(view);
      }
    };
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
    // Prepared but uncommitted: skip the picker and the engine and go straight
    // to the reviewed commit on the completion page (#284).
    let validated: HeadlessSetupResult | undefined = health?.needsCommitOnly ? {
      mode, stage: "ready", populated: true, ready: true, selectedTools, prompt: null,
      populationTool: null, populationCompleted: true,
      commitCommands: setupCommitCheckpointCommands(selectedTools), anchorNotes: [],
      message: "Graph and Wiki are ready. Review and commit the canonical MEX setup.",
    } : undefined;
    let anchorNotes: readonly string[] = [];
    let populationFailure: string | undefined;
    try {
      const action: TerminalSetupAction = validated ? { type: "start" } : await choose();
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
                  completedSteps: view.activeStep && view.activeStep !== progress.step ? [...new Set([...view.completedSteps, view.activeStep])] : view.completedSteps,
                detail: progress.detail ?? progress.label,
                  phaseStartedAt: view.activeStep === progress.step ? view.phaseStartedAt : Date.now(),
                lastActivityAt: Date.now(),
                progress: undefined,
              }),
              onMessage: detail => update({ detail, lastActivityAt: Date.now() }),
              onGraphProgress: progress => {
                const activity = setupGraphActivity(progress);
                update({ detail: activity.detail, progress: activity.progress, lastActivityAt: Date.now() });
              },
                onPopulationCoverage: coverage => update({ concurrentPopulation: `${coverage.done}/${coverage.total} subsystems done, ${coverage.skipped} skipped`, lastActivityAt: Date.now() }),
                onAnchorNotes: notes => { anchorNotes = notes; },
              populate: async input => {
                let tool = selectSetupAgent(input.selectedTools);
                let first = true;
                let detail = tool
                  ? `Opening ${AI_TOOLS[tool].name} with your setup instructions. Exit the agent session to return to MEX.`
                  : "No agent CLI MEX can launch is available. Choose the prompt and paste it into your agent: it runs `mex setup next --start` first, then follows the printed commands.";
                while (!abort.signal.aborted) {
                  tool = selectSetupAgent(input.selectedTools);
                  update({ screen: "population", detail, populationAgent: tool ? AI_TOOLS[tool].name : null });
                  const action = first && tool ? { type: "agent" as const } : await choose();
                  first = false;
                  if (action.type === "cancel") throwIfSetupAborted(abort.signal);
                  if (action.type === "exit") {
                    populationFailure = undefined;
                    return { tool, completed: false };
                  }
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
                    try {
                      // One short prompt drives `mex setup next`, one task at a time, until setup is complete.
                      console.log(`\nCopy this prompt into your AI tool:\n\n${SETUP_HANDOFF_PROMPT}\n`);
                      if (await pressEnterToReturn(abort.signal) === "cancel" && !abort.signal.aborted) cancel();
                    }
                    finally {
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
                message: `${populationFailure ? `Setup failed: ${populationFailure}` : `Setup paused at population. ${result.message}`} ${describeUnfinishedSetup(projectRoot)?.line ? `${describeUnfinishedSetup(projectRoot)!.line} ` : ""}${CONTINUE}` };
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
          const { projectSetupStatus } = await import("../hub/setup/readiness.js");
          const finished = await projectSetupStatus(projectRoot);
          const message = finished.mode === "agent-memory" || finished.ready
            ? `Setup complete. Hub stopped.${validated.coverageNotice ? ` ${validated.coverageNotice}` : ""}${validated.groundingNotice ? ` ${validated.groundingNotice}` : ""} Run \`mex hub\` to open Hub again.`
            : `${validated.message} Hub stopped. Run \`mex setup --browser\` to reopen the completion page.`;
          outcome = { outcome: "complete", exitCode: 0, message };
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
      linkWait?.abort();
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

function pressEnterToReturn(signal: AbortSignal): Promise<"return" | "cancel"> {
  stdout.write("Press Enter to return to MEX…");
  return waitForTerminalReturn(signal);
}

/** An explicit tool choice equal to the saved one changes nothing for a rerun. */
function sameTools(requested: readonly AiTool[], configured: readonly AiTool[]): boolean {
  const wanted = new Set(requested);
  return wanted.size === new Set(configured).size && configured.every(tool => wanted.has(tool));
}

function previewSetup(projectRoot: string, mode: "code-repo" | "agent-memory", tools: AiTool[], explicit: boolean): SetupRunResult {
  console.log(`MEX setup · DRY RUN · ${mode === "agent-memory" ? "agent-memory workspace" : basename(projectRoot)}`);
  console.log("No files will be created or modified.");
  requireSetupGitRepository(projectRoot, mode);
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
  if (mode === "code-repo") console.log("Would build the code graph; background subsystem sessions can run alongside it, applying after it is ready.");
  console.log(isScaffoldPopulated(resolve(projectRoot, ".mex"))
    ? "Would preserve and verify the populated scaffold."
    : "Would populate the scaffold with a selected agent or the manual prompt.");
  if (mode === "code-repo") console.log("Would capture grounding, give remaining files their Wiki ids, link and index the Wiki, then validate the result.");
  console.log("Interactive setup would then open the Hub completion page.");
  const message = "Dry run complete. Population and validation were not run.";
  console.log(message);
  return { outcome: "dry-run", exitCode: 0, message };
}
