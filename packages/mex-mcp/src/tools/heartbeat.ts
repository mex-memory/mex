import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findConfig, checkHeartbeat } from "mex-agent";

export function registerHeartbeatTool(server: McpServer) {
  server.tool(
    "mex_heartbeat",
    "Check the mex scaffold heartbeat. Returns ok status, stale files with age in days, and memory cleanup status.",
    {
      projectRoot: z
        .string()
        .optional()
        .describe("Absolute path to the project root. Defaults to cwd."),
    },
    async ({ projectRoot }) => {
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
      const result = checkHeartbeat(config, new Date());
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
