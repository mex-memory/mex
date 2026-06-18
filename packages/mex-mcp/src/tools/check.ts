import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findConfig, runDriftCheck } from "mex-agent";

export function registerCheckTool(server: McpServer) {
  server.tool(
    "mex_check",
    "Run a drift check on the mex scaffold. Returns a DriftReport with a numeric score, issues list, and file count.",
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
      const report = await runDriftCheck(config);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
  );
}
