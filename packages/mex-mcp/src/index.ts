import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCheckTool } from "./tools/check.js";
import { registerLogTool } from "./tools/log.js";
import { registerTimelineTool } from "./tools/timeline.js";
import { registerHeartbeatTool } from "./tools/heartbeat.js";
import { registerReadFileTool } from "./tools/read-file.js";

const server = new McpServer({
  name: "mex-mcp",
  version: "0.1.0",
});

registerCheckTool(server);
registerLogTool(server);
registerTimelineTool(server);
registerHeartbeatTool(server);
registerReadFileTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);
