import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findConfig, readEvents } from "mex-agent";

export function registerTimelineTool(server: McpServer) {
  server.tool(
    "mex_timeline",
    "Read the mex event timeline, optionally filtered by kind or date range. Good for understanding what an agent did and when.",
    {
      projectRoot: z
        .string()
        .optional()
        .describe("Absolute path to the project root. Defaults to cwd."),
      kind: z
        .string()
        .optional()
        .describe("Filter by event kind (e.g. 'session_start', 'checkpoint', 'note')."),
      since: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp — return only events at or after this time."),
      limit: z.number().int().positive().optional().default(50),
    },
    async ({ projectRoot, kind, since, limit }) => {
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
      let events = readEvents(config);
      if (kind) events = events.filter((e) => e.kind === kind);
      if (since) {
        const sinceMs = new Date(since).getTime();
        events = events.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
      }
      events = events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return {
        content: [{ type: "text", text: JSON.stringify(events.slice(0, limit), null, 2) }],
      };
    }
  );
}
