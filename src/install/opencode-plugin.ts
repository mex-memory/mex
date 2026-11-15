import type { HookCommand } from "./settings.js";

/** The marker that identifies MEX's plugin file. */
export const OPENCODE_PLUGIN_MARKER = "// MEX hook plugin for OpenCode, written by `mex install`; `mex uninstall` removes it.";

/**
 * OpenCode has no command hooks, so MEX installs one plugin that starts the
 * same `mex-hook` command the other agents run, as `mex-hook opencode <hook>`.
 * The payload is MEX's own (native/internal/adapter/opencode). Every failure
 * is swallowed: only a deliberate deny reply throws, which is how an OpenCode
 * plugin blocks a tool call.
 */
export function opencodePlugin(command: HookCommand): string {
  return `${OPENCODE_PLUGIN_MARKER}
import { spawn } from "node:child_process";

const COMMAND = ${JSON.stringify(command.path)};
const ARGS = ${JSON.stringify(command.args)};
const TIMEOUT_MS = 10000;

function call(hook, payload) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    try {
      const child = spawn(COMMAND, [...ARGS, "opencode", hook], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      let out = "";
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish({}); }, TIMEOUT_MS);
      child.stdout.on("data", (chunk) => { if (out.length < 1 << 20) out += chunk; });
      child.on("error", () => { clearTimeout(timer); finish({}); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return finish({});
        try { const reply = JSON.parse(out); finish(reply && typeof reply === "object" ? reply : {}); } catch { finish({}); }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    } catch { finish({}); }
  });
}

export const MexPlugin = async ({ directory }) => {
  const base = (sessionID) => ({ session_id: typeof sessionID === "string" ? sessionID : "", cwd: directory });
  return {
    event: async ({ event }) => {
      try {
        const type = event && event.type;
        if (type === "session.created") {
          const info = (event.properties && event.properties.info) || {};
          await call(type, { ...base(info.id), parent_session_id: info.parentID || "" });
        } else if (type === "session.compacted" || type === "session.idle") {
          await call(type, base(event.properties && event.properties.sessionID));
        }
      } catch {}
    },
    "tool.execute.before": async (input, output) => {
      let reply = {};
      try { reply = await call("tool.execute.before", { ...base(input.sessionID), tool: input.tool, args: (output && output.args) || {} }); } catch {}
      if (typeof reply.deny === "string" && reply.deny) throw new Error(reply.deny);
    },
    "tool.execute.after": async (input, output) => {
      try {
        const metadata = (output && output.metadata) || {};
        const reply = await call("tool.execute.after", {
          ...base(input.sessionID), tool: input.tool, args: input.args || {},
          output: typeof output.output === "string" ? output.output : "",
          metadata: { exit: typeof metadata.exit === "number" ? metadata.exit : undefined },
        });
        if (typeof reply.output === "string") output.output = reply.output;
        if (typeof reply.append === "string" && reply.append) output.output = \`\${output.output || ""}\\n\\n\${reply.append}\`;
      } catch {}
    },
    "experimental.session.compacting": async (input, output) => {
      try {
        const reply = await call("experimental.session.compacting", base(input.sessionID));
        if (typeof reply.context === "string" && reply.context && Array.isArray(output.context)) output.context.push(reply.context);
      } catch {}
    },
  };
};
`;
}
