import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({
    name: "chat_server",
    version: "1.0.0",
    capabilities: {
        resources: {},
        tools: {},
    },
});
server.tool("say_hello", "Says hello to user", { name: z.string().describe("Give the name of the user") }, async ({ name }) => {
    const proper_name = name.charAt(0).toLowerCase();
    return {
        content: [
            {
                type: "text",
                text: proper_name,
            },
        ],
    };
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.info("MCP server running on stdio...");
}
main().catch((err) => {
    console.error(`MCP server crashed with: ${err}`);
    process.exit(1);
});
