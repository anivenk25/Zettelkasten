import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KnowledgeBase } from "./lib/knowledge-base";
import { z } from "zod";

const knowledgeBase = new KnowledgeBase();

const server = new McpServer({
  name: "chat_server",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

server.tool(
  "get_msg_context",
  "Says hello to user",
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.info("MCP server running on stdio...");
}

main().catch((err) => {
  console.error(`MCP server crashed with: ${err}`);
  process.exit(1);
});
