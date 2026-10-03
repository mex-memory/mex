import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findConfig, recordNote, findNotes, getNote, noteProblem, EVENT_KINDS } from "mex-agent";

export function registerLogTool(server: McpServer) {
  server.tool("mex_log", "Save an immutable historical note with a durable-local receipt, search notes, or read an original note by ID. Does not require Graph/Wiki. No keyed retries or attachments yet.", {
    projectRoot: z.string().optional(), action: z.enum(["read", "write", "get"]).default("read"),
    kind: z.enum(EVENT_KINDS).optional(), summary: z.string().optional(), id: z.string().max(80).optional(),
    files: z.array(z.string().max(1024)).max(16).optional(),
    source: z.string().max(1024).optional(), status: z.string().max(1024).optional(), trace: z.string().max(1024).optional(),
    query: z.string().max(256).optional(), since: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(200).default(20),
  }, async ({ projectRoot, action, kind, summary, id, files, source, status, trace, query, since, limit }) => {
    try {
      const config = findConfig(projectRoot ?? process.cwd());
      let data: unknown;
      if (action === "write") {
        if (summary === undefined) return { isError: true, content: [{ type: "text", text: JSON.stringify({ schemaVersion: 1, ok: false, problem: { code: "INVALID_NOTE_INPUT", message: "summary is required for write" } }) }] };
        const receipt = await recordNote(config, { message: summary, kind, files, source, status, trace, originAdapter: "mcp" });
        data = { schemaVersion: 1, ok: true, kind: kind ?? "note", summary, receipt };
      } else if (action === "get") {
        if (!id) return { isError: true, content: [{ type: "text", text: JSON.stringify({ schemaVersion: 1, ok: false, problem: { code: "INVALID_NOTE_INPUT", message: "id is required for get" } }) }] };
        data = { schemaVersion: 1, note: getNote(config, id) };
      } else data = findNotes(config, { kind, files, query, since, limit });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ schemaVersion: 1, ok: false, problem: noteProblem(error) }) }] };
    }
  });
}
