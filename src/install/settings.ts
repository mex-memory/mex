import { isAbsolute, join } from "node:path";

export type Agent = "claude-code" | "codex" | "copilot";
type ObjectValue = Record<string, unknown>;
export function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Keep these native events aligned with the two shim profiles. Register all
// supported events now: changing a command definition would require new trust.
export const EVENTS: Record<Agent, readonly string[]> = {
  "claude-code": ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "PreCompact", "PostCompact", "SubagentStart", "Stop", "SessionEnd", "InstructionsLoaded"],
  codex: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "SubagentStart", "Stop", "SessionEnd"],
  // Keep aligned with native/internal/adapter/copilot. Copilot denies a tool
  // call whose hook crashes, so these are registered only after a self-test.
  copilot: ["sessionStart", "userPromptSubmitted", "preToolUse", "postToolUse", "postToolUseFailure", "preCompact", "subagentStart", "agentStop", "sessionEnd"],
};
/** The program each agent installs on PATH. */
export const AGENT_COMMANDS: Record<Agent, string> = { "claude-code": "claude", codex: "codex", copilot: "copilot" };
/** Agents where a failing hook stops the agent, so MEX self-tests before registering. */
export const FAILURE_BLOCKS: ReadonlySet<Agent> = new Set(["copilot"]);
export const CODEX_TRUST_NOTICE = "In Codex, review and trust MEX's hooks once: /hooks in the CLI, or Review hooks beside the message box in the app. Until then Codex skips them.";

const SETTINGS: Record<Agent, { variable: string; directory: string; file: string }> = {
  "claude-code": { variable: "CLAUDE_CONFIG_DIR", directory: ".claude", file: "settings.json" },
  codex: { variable: "CODEX_HOME", directory: ".codex", file: "hooks.json" },
  copilot: { variable: "COPILOT_HOME", directory: ".copilot", file: "hooks.json" },
};

export function agentSettingsPath(agent: Agent, user: string, env: NodeJS.ProcessEnv): string {
  const { variable, directory, file } = SETTINGS[agent];
  const override = env[variable]?.trim();
  if (override && !isAbsolute(override)) throw new Error(variable + " must name an absolute user configuration directory.");
  return join(override || join(user, directory), file);
}

export function agentSettings(user: string, env: NodeJS.ProcessEnv): Record<Agent, string> {
  return {
    "claude-code": agentSettingsPath("claude-code", user, env),
    codex: agentSettingsPath("codex", user, env),
    copilot: agentSettingsPath("copilot", user, env),
  };
}

export function parseSettings(bytes: Buffer | null): ObjectValue {
  const text = bytes?.toString("utf8").replace(/^\uFEFF/, "") ?? "{}";
  const result: unknown = JSON.parse(text);
  if (!object(result) || (result.hooks !== undefined && !object(result.hooks))) throw new Error("Expected a settings object with a hooks object.");
  if (result.hooks && Object.values(result.hooks).some(groups => !Array.isArray(groups))) throw new Error("Expected hook event arrays.");
  return result;
}

/** The prototype stamped its commands; never classify somebody else's hook by a word in its name. */
export function isLegacyHandler(handler: unknown): boolean {
  return object(handler) && typeof handler.command === "string" && /(?:^|\s)--mex-managed(?:\s|$)/.test(handler.command);
}

export function removeHandlers(settings: ObjectValue, owned: (handler: unknown) => boolean): boolean {
  if (!object(settings.hooks)) return false;
  let changed = false;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const remaining: unknown[] = [];
    for (const group of groups as unknown[]) {
      // Copilot lists handlers directly under each event, without groups.
      if (object(group) && !Array.isArray(group.hooks) && owned(group)) { changed = true; continue; }
      if (!object(group) || !Array.isArray(group.hooks)) { remaining.push(group); continue; }
      const handlers = group.hooks.filter(handler => !owned(handler));
      if (handlers.length === group.hooks.length) remaining.push(group);
      else { changed = true; if (handlers.length) remaining.push({ ...group, hooks: handlers }); }
    }
    if (remaining.length) settings.hooks[event] = remaining;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return changed;
}

export interface HookCommand { path: string; args: string[]; }
const quoteSh = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const quotePowerShell = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The same keys first, in their old order; new ones after. */
function inOrder(value: ObjectValue, keys: readonly string[]): ObjectValue {
  const out: ObjectValue = {};
  for (const key of keys) if (Object.hasOwn(value, key)) out[key] = value[key];
  for (const [key, item] of Object.entries(value)) if (!Object.hasOwn(out, key)) out[key] = item;
  return out;
}

/** Settings compared as Claude Code and Codex read them: key order and the order of groups under one event don't matter. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sameSettings(a: ObjectValue, b: ObjectValue): boolean {
  const { hooks: aHooks, ...aRest } = a, { hooks: bHooks, ...bRest } = b;
  const events = (hooks: unknown) => object(hooks)
    ? `{${Object.keys(hooks).sort().map(event => `${JSON.stringify(event)}:${Array.isArray(hooks[event]) ? (hooks[event] as unknown[]).map(canonical).sort().join(",") : canonical(hooks[event])}`).join(",")}}`
    : canonical(hooks);
  return canonical(aRest) === canonical(bRest) && events(aHooks) === events(bHooks);
}

function ownedHandler(ownedCommands: readonly HookCommand[]): (handler: unknown) => boolean {
  return handler => isLegacyHandler(handler) || (object(handler) && ownedCommands.some(owned => {
    const args = handler.args;
    const shellPrefix = [owned.path, ...owned.args].map(quoteSh).join(" ");
    const windowsPrefix = `& ${[owned.path, ...owned.args].map(quotePowerShell).join(" ")}`;
    return (handler.command === owned.path && (owned.args.length === 0 || (Array.isArray(args) && owned.args.every((arg, i) => args[i] === arg))))
      || (typeof handler.command === "string" && handler.command.startsWith(`${shellPrefix} `))
      || (typeof handler.commandWindows === "string" && handler.commandWindows.startsWith(`${windowsPrefix} `))
      || (typeof handler.bash === "string" && handler.bash.startsWith(`${shellPrefix} `))
      || (typeof handler.powershell === "string" && handler.powershell.startsWith(`${windowsPrefix} `));
  }));
}

/** Inspect only MEX's definitions, including flat Copilot events and nested matcher groups. */
export function ownedHookGroups(settings: ObjectValue, commands: readonly HookCommand[]): Record<string, unknown[]> {
  const owns = ownedHandler(commands);
  const groups: Record<string, unknown[]> = Object.create(null);
  if (!object(settings.hooks)) return groups;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    const matches = (entries as unknown[]).flatMap(entry => {
      if (!object(entry)) return [];
      if (!Array.isArray(entry.hooks)) return owns(entry) ? [entry] : [];
      const hooks = entry.hooks.filter(owns);
      return hooks.length ? [{ ...entry, hooks }] : [];
    });
    if (matches.length) groups[event] = matches;
  }
  return groups;
}

/** Compare hook definitions without depending on JSON property order or unrelated handlers. */
export function registeredHookEvents(settings: ObjectValue, agent: Agent, command: HookCommand, platform: NodeJS.Platform): Set<string> {
  const expected = ownedHookGroups(parseSettings(installSettings(null, agent, command, platform)), [command]);
  const actual = ownedHookGroups(settings, [command]);
  return new Set(EVENTS[agent].filter(event => {
    const desired = expected[event][0];
    return (actual[event] ?? []).some(group => {
      if (agent === "copilot") return settings.version === 1 && canonical(group) === canonical(desired);
      if (!object(group) || !Array.isArray(group.hooks) || (group.matcher !== undefined && group.matcher !== "")) return false;
      return group.hooks.some(handler => canonical(handler) === canonical((desired as { hooks: unknown[] }).hooks[0]));
    });
  }));
}

/** Removes MEX's handlers only, e.g. when a Copilot self-test fails after an earlier install. */
export function withoutSettings(bytes: Buffer | null, ownedCommands: readonly HookCommand[]): Buffer | null {
  if (bytes === null) return null;
  const settings = parseSettings(bytes);
  return removeHandlers(settings, ownedHandler(ownedCommands)) ? Buffer.from(`${JSON.stringify(settings, null, 2)}\n`) : bytes;
}

export function installSettings(bytes: Buffer | null, agent: Agent, command: HookCommand, platform: NodeJS.Platform, ownedCommands: readonly HookCommand[] = [command]): Buffer {
  const original = parseSettings(bytes);
  // Copilot's hook file names its format version first.
  const addVersion = agent === "copilot" && original.version === undefined;
  let settings = addVersion ? { version: 1, ...parseSettings(bytes) } : parseSettings(bytes);
  const keys = [...(addVersion ? ["version"] : []), ...Object.keys(original)];
  const events = object(original.hooks) ? Object.keys(original.hooks) : [];
  // Only replace handlers targeting this install's fixed command, or carrying
  // the old explicit ownership flag. Mixed matcher groups retain other hooks.
  removeHandlers(settings, ownedHandler(ownedCommands));
  const hooks = object(settings.hooks) ? settings.hooks : {};
  settings.hooks = hooks;
  for (const event of EVENTS[agent]) {
    const args = [...command.args, agent, event];
    const shell = [command.path, ...args].map(quoteSh).join(" ");
    const powershell = `& ${[command.path, ...args].map(quotePowerShell).join(" ")}`;
    if (agent === "copilot") {
      // Flat handlers; bash and powershell are both given so one file works on every OS.
      hooks[event] = [...(hooks[event] as unknown[] | undefined ?? []),
        { type: "command", bash: shell, powershell, timeoutSec: event === "sessionEnd" ? 5 : 10 }];
      continue;
    }
    const handler = agent === "claude-code"
      ? { type: "command", command: command.path, args, timeout: event === "SessionEnd" ? 1 : 10, onFailure: "continue" }
      : { type: "command", command: shell,
        ...(platform === "win32" ? { commandWindows: powershell } : {}),
        timeout: event === "SessionEnd" ? 3 : 10 };
    hooks[event] = [...(hooks[event] as unknown[] | undefined ?? []), { hooks: [handler] }];
  }
  // A repeated install doesn't touch the file, whitespace, BOM and CRLF
  // included; a real change keeps the person's key and event order.
  if (bytes !== null && sameSettings(settings, original)) return bytes;
  settings = inOrder(settings, keys);
  settings.hooks = inOrder(hooks, events);
  return Buffer.from(`${JSON.stringify(settings, null, 2)}\n`);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Reverse only our delta when another program edited settings after install. */
export function undoSettings(current: Buffer, before: Buffer | null, after: Buffer): Buffer {
  const undo = (now: unknown, old: unknown, installed: unknown): unknown => {
    if (same(old, installed)) return now;
    if (same(now, installed)) return old;
    if (Array.isArray(now) && Array.isArray(installed) && (old === undefined || Array.isArray(old))) {
      const original = (old ?? []) as unknown[];
      const added = installed.filter(value => !original.some(item => same(item, value)));
      // A modified MEX handler is no longer an exact owned delta: retain the
      // runtime and ask for manual recovery instead of stranding that hook.
      if (added.some(value => !now.some(item => same(item, value)))) throw new Error("An installed hook was edited; review it before uninstalling.");
      const result = now.filter(value => !added.some(item => same(item, value)));
      for (const value of original.filter(value => !installed.some(item => same(item, value)))) {
        if (!result.some(item => same(item, value))) result.push(value);
      }
      return result.length || old !== undefined ? result : undefined;
    }
    if (object(now) && object(installed) && (old === undefined || object(old))) {
      const original = old ?? {};
      const result = { ...now };
      for (const key of new Set([...Object.keys(original), ...Object.keys(installed)])) {
        const value = undo(now[key], original[key], installed[key]);
        if (value === undefined) delete result[key]; else result[key] = value;
      }
      return Object.keys(result).length || old !== undefined ? result : undefined;
    }
    throw new Error("An installed setting was edited; review it before uninstalling.");
  };
  const result = undo(parseSettings(current), before === null ? {} : parseSettings(before), parseSettings(after));
  return Buffer.from(`${JSON.stringify(result ?? {}, null, 2)}\n`);
}
