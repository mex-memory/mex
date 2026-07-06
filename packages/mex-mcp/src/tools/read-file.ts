import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findConfig } from "mex-agent";

export function registerReadFileTool(server: McpServer) {
  server.tool(
    "mex_read_file",
    "Read a file from the mex scaffold directory (.mex/). Path is relative to .mex/ (e.g. 'AGENTS.md', 'context/stack.md').",
    {
      projectRoot: z
        .string()
        .optional()
        .describe("Absolute path to the project root. Defaults to cwd."),
      file: z
        .string()
        .describe("Path to the scaffold file relative to .mex/ (e.g. 'AGENTS.md', 'context/stack.md')."),
    },
    async ({ projectRoot, file }) => {
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
      const base = resolve(config.scaffoldRoot);
      const fullPath = resolve(base, file);
      if (fullPath !== base && !fullPath.startsWith(base + sep)) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "Path escapes scaffold root", file }) },
          ],
        };
      }
      if (!existsSync(fullPath)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `File not found: ${file}`,
                scaffoldRoot: config.scaffoldRoot,
              }),
            },
          ],
        };
      }
      const content = readFileSync(fullPath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    }
  );
}
