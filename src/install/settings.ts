import { isAbsolute, join } from "node:path";

export type Agent = "claude-code" | "codex";
type ObjectValue = Record<string, unknown>;
export function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Keep these native events aligned with the two shim profiles. Register all
// supported events now: changing a command definition would require new trust.
export const EVENTS: Record<Agent, readonly string[]> = {
  "claude-code": ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "PreCompact", "PostCompact", "SubagentStart", "Stop", "SessionEnd", "InstructionsLoaded"],
  codex: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "SubagentStart", "Stop", "SessionEnd"],
};
export const CODEX_TRUST_NOTICE = "In Codex, review and trust MEX's hooks once: /hooks in the CLI, or Review hooks beside the message box in the app. Until then Codex skips them.";

export function agentSettings(user: string, env: NodeJS.ProcessEnv): Record<Agent, string> {
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (env[key]?.trim() && !isAbsolute(env[key]!.trim())) throw new Error(`${key} must name an absolute user configuration directory.`);
  }
  return {
    "claude-code": join(env.CLAUDE_CONFIG_DIR?.trim() || join(user, ".claude"), "settings.json"),
    codex: join(env.CODEX_HOME?.trim() || join(user, ".codex"), "hooks.json"),
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

export function installSettings(bytes: Buffer | null, agent: Agent, command: HookCommand, platform: NodeJS.Platform, ownedCommands: readonly HookCommand[] = [command]): Buffer {
  let settings = parseSettings(bytes);
  const original = parseSettings(bytes);
  const keys = Object.keys(settings);
  const events = object(settings.hooks) ? Object.keys(settings.hooks) : [];
  // Only replace handlers targeting this install's fixed command, or carrying
  // the old explicit ownership flag. Mixed matcher groups retain other hooks.
  removeHandlers(settings, handler => isLegacyHandler(handler) || (object(handler) && ownedCommands.some(owned => {
    const args = handler.args;
    const shellPrefix = [owned.path, ...owned.args].map(quoteSh).join(" ");
    const windowsPrefix = `& ${[owned.path, ...owned.args].map(quotePowerShell).join(" ")}`;
    return (handler.command === owned.path && (owned.args.length === 0 || (Array.isArray(args) && owned.args.every((arg, i) => args[i] === arg))))
      || (typeof handler.command === "string" && handler.command.startsWith(`${shellPrefix} `))
      || (typeof handler.commandWindows === "string" && handler.commandWindows.startsWith(`${windowsPrefix} `));
  })));
  const hooks = object(settings.hooks) ? settings.hooks : {};
  settings.hooks = hooks;
  for (const event of EVENTS[agent]) {
    const args = [...command.args, agent, event];
    const handler = agent === "claude-code"
      ? { type: "command", command: command.path, args, timeout: event === "SessionEnd" ? 1 : 10, onFailure: "continue" }
      : { type: "command", command: [command.path, ...args].map(quoteSh).join(" "),
        ...(platform === "win32" ? { commandWindows: `& ${[command.path, ...args].map(quotePowerShell).join(" ")}` } : {}),
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
