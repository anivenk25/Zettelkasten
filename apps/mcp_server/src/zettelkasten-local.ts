import { KnowledgeBase } from "./lib/knowledge-base.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write("Fatal error in main():", error);
  process.exit(1);
});
