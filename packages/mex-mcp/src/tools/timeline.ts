import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findConfig, findNotes, noteProblem, EVENT_KINDS } from "mex-agent";

export function registerTimelineTool(server: McpServer) {
  server.tool("mex_timeline", "Search historical notes by literal message, exact recorded files, kind and time. Reads at most 8 MiB / 10,000 records per source; reports incomplete history and omitted results. Notes are historical contributions, not verified current knowledge.", {
    projectRoot: z.string().optional(), kind: z.enum(EVENT_KINDS).optional(),
    since: z.string().max(64).optional(), query: z.string().max(256).optional(),
    files: z.array(z.string().max(1024)).max(16).optional(), limit: z.number().int().min(1).max(200).default(20),
  }, async ({ projectRoot, kind, since, query, files, limit }) => {
    try {
      const result = findNotes(findConfig(projectRoot ?? process.cwd()), { kind, since, query, files, limit });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ schemaVersion: 1, ok: false, problem: noteProblem(error) }) }] };
    }
  });
}
