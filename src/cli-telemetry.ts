import type { Command } from "commander";
import { TELEMETRY_COMMANDS, type TelemetryAttributes, type TelemetryEventName, type TelemetryProjectContext } from "./telemetry/schema.js";

/** Only names registered by Commander enter telemetry; argument values never do. */
export function telemetryCommandPath(command: Command): string {
  const parts: string[] = [];
  for (let node: Command | null = command; node?.parent; node = node.parent) parts.unshift(node.name());
  return parts.join(".") || "mex";
}

/** Match the command's project selection; option values never enter events. */
export function telemetryProjectLocation(command: Command, cwd = process.cwd()): { root: string; discovery: "git-root" | "exact" } {
  const path = telemetryCommandPath(command);
  if (["graph", "graph.status", "graph.refresh", "graph.rebuild", "graph.repair"].includes(path)) {
    const root = command.opts().root ?? (path === "graph" ? undefined : command.parent?.opts().root);
    return { root: typeof root === "string" ? root : cwd, discovery: "exact" };
  }
  return { root: cwd, discovery: "git-root" };
}

export function isTelemetryExemptCommand(commandName: string, parentName?: string, fullPath?: string): boolean {
  const path = fullPath ?? (parentName && parentName !== "mex" ? `${parentName}.${commandName}` : commandName);
  return path === "mex" || !(TELEMETRY_COMMANDS as readonly string[]).includes(path);
}

function telemetryStage(command: Command, path: string): TelemetryAttributes["stage"] {
  const options = command.opts();
  if (path === "relay.draft.save" && options.from !== undefined) return "direct";
  if (command.options.some((option) => option.attributeName() === "apply")) {
    return options.apply === undefined ? "preview" : "apply";
  }
  return options.dryRun === true ? "preview" : "direct";
}

/** One active invocation, completed once even when the action throws. */
export function createCliTelemetry(
  capture: (name: TelemetryEventName, attributes: TelemetryAttributes) => void,
  flush: () => Promise<void>,
  now: () => number = () => performance.now(),
  readProjectContext?: (command: Command) => TelemetryProjectContext,
) {
  let active: {
    command: string; stage: TelemetryAttributes["stage"]; started: number;
    context: TelemetryProjectContext; refreshContext?: () => TelemetryProjectContext;
  } | undefined;
  return {
    start(command: Command): void {
      try {
        const path = telemetryCommandPath(command);
        if (path === "setup" && !command.opts().cli && !command.opts().dryRun) return;
        if (isTelemetryExemptCommand(command.name(), command.parent?.name(), path)) return;
        const context = (): TelemetryProjectContext => {
          try { return readProjectContext?.(command) ?? {}; } catch { return {}; }
        };
        active = {
          command: path, stage: telemetryStage(command, path), started: now(), context: context(),
          // Setup/init may create the first identity and tool selection after
          // preAction. Ordinary commands reuse one snapshot for both events.
          ...(["setup", "init"].includes(path) ? { refreshContext: context } : {}),
        };
        capture("cli.command_started", { ...active.context, command: active.command, stage: active.stage });
      } catch { /* Telemetry cannot change command behavior. */ }
    },
    async finish(exitCode: string | number | null | undefined): Promise<void> {
      const invocation = active;
      active = undefined;
      if (!invocation) return;
      try {
        capture("cli.command_completed", {
          ...(invocation.refreshContext?.() ?? invocation.context),
          command: invocation.command,
          stage: invocation.stage,
          outcome: exitCode == null || Number(exitCode) === 0 ? "success" : "failure",
          duration_ms: Math.min(86_400_000, Math.max(0, Math.floor(now() - invocation.started))),
        });
        await flush();
      } catch { /* Preserve the command's result and output if telemetry fails. */ }
    },
  };
}
