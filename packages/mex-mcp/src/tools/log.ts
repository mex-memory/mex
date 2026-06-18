import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findConfig, appendEvent, readEvents, EVENT_KINDS } from "mex-agent";
import type { EventKind } from "mex-agent";

export function registerLogTool(server: McpServer) {
  server.tool(
    "mex_log",
    `Append an agent event to the mex log, or read recent events. Valid kinds: ${EVENT_KINDS.join(", ")}.`,
    {
      projectRoot: z
        .string()
        .optional()
        .describe("Absolute path to the project root. Defaults to cwd."),
      action: z.enum(["read", "write"]).default("read"),
      kind: z
        .string()
        .optional()
        .describe(`Event kind for write (one of: ${EVENT_KINDS.join(", ")}).`),
      summary: z.string().optional().describe("Human-readable event summary for write."),
      limit: z.number().int().positive().optional().default(20),
    },
    async ({ projectRoot, action, kind, summary, limit }) => {
      const root = projectRoot ?? process.cwd();
      const config = await findConfig(root);
      if (!config) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "No mex config found", projectRoot: root }),
            },
          ],
        };
      }
      if (action === "write") {
        if (!kind || !summary) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: "kind and summary are required for write" }) },
            ],
          };
        }
        await appendEvent(config, { kind: kind as EventKind, summary });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, kind, summary }) }] };
      }
      const events = await readEvents(config, { limit });
      return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
    }
  );
}
