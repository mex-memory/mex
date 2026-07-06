import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findConfig, appendEvent, readEvents, EVENT_KINDS } from "mex-agent";

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
        .enum(EVENT_KINDS)
        .optional()
        .describe(`Event kind for write (one of: ${EVENT_KINDS.join(", ")}).`),
      summary: z.string().optional().describe("Human-readable event summary for write."),
      limit: z.number().int().positive().optional().default(20),
    },
    async ({ projectRoot, action, kind, summary, limit }) => {
      const root = projectRoot ?? process.cwd();
      let config;
      try {
        config = findConfig(root);
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: (e as Error).message, projectRoot: root }),
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
        const entry = appendEvent(config, summary, { kind });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, kind: entry.kind, summary }) }] };
      }
      const events = readEvents(config).slice(-limit);
      return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
    }
  );
}
