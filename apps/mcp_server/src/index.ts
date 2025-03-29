import { KnowledgeBase } from "./lib/knowledge-base.js";
import { z } from "zod";
import express, { Express, Request, Response } from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const knowledgeBase = new KnowledgeBase();

const server = new McpServer({
  name: "zettelkasten",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

server.tool(
  "get_msg_context",
  { userId: z.string().describe("User Id"), query: z.string() },
  async ({ userId, query }) => {
    const result = await knowledgeBase.getMsgContext(userId, query);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.messages),
        },
      ],
    };
  },
);

const app: Express = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    credentials: false,
  }),
);

app.get("/", (req: Request, res: Response) => {
  res.json({
    name: "Zettelkasten",
    version: "1.0.0",
    status: "running",
    endpoints: {
      "/": "Server information (this response)",
      "/sse": "Server-Sent Events endpoint for MCP connection",
      "/messages": "POST endpoint for MCP messages",
    },
    tools: [
      { name: "add", description: "Add two numbers together" },
      { name: "search", description: "Search the web using Brave Search API" },
    ],
  });
});
let transport: SSEServerTransport;

app.get("/sse", async (req: Request, res: Response) => {
  transport = new SSEServerTransport("/get-msg-context", res);
  await server.connect(transport);
});
app.post("/get-msg-context", async (req: Request, res: Response) => {
  await transport.handlePostMessage(req, res);
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`MCP SSE Server running on port ${PORT}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write("Fatal error in main():", error);
  process.exit(1);
});
