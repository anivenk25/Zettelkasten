# Zettelkasten - MCP Server for Chatbot Applications

Zettelkasten is an MCP (Message Control Protocol) server designed for chatbot applications. This repository provides two implementations of an MCP server:

1. **Stdio Transport**
2. **Server-Sent Events (SSE) Transport**

## Features

- **Hybrid Data Storage:** Combines a **vector database (Pinecone)** and a **graph database (Neo4j)** for efficient storage and retrieval of cross-session chat context.
- **Multi-Protocol Support:** Offers both Stdio and SSE transports to integrate seamlessly with various clients.
- **Scalability:** Designed to handle large-scale chatbot interactions with contextual memory persistence.

---

## Getting Started

### Prerequisites

Ensure you have the following installed on your system:

- **Node.js** (Latest LTS version recommended)
- **pnpm** (Package manager)
- **Neo4j Database** running locally or remotely
- **Pinecone Vector Database** account
- **OpenAI API Key**

### Environment Variables

Create a `.env` file in the `/apps/mcp-server` directory and include the following environment variables:

```
PINECONE_API_KEY=
PINECONE_INDEX_NAME=
NEO4J_URI=
NEO4J_USER=
NEO4J_PASSWORD=
OPENAI_API_KEY=
EMBEDDING_MODEL=text-embedding-ada-002
VECTOR_DIMENSION=1536
```

> **Note:** Do not share or commit your API keys.

---

## Running Zettelkasten Locally

### 1. Stdio Transport

To set up and run the MCP server using stdio transport:

```sh
cd apps/mcp-server
pnpm install
pnpm build
```

If you are integrating with Claude, update `claude_desktop_config.json`:

```json
"mcpServers": {
  "zettelkasten": {
    "command": "node",
    "args": [
      "<absolute-path-to>/apps/mcp-server/build/zettelkasten-local.js"
    ],
    "env": {
      "PINECONE_API_KEY": "",
      "PINECONE_INDEX_NAME": "",
      "NEO4J_URI": "",
      "NEO4J_USER": "",
      "NEO4J_PASSWORD": "",
      "OPENAI_API_KEY": ""
    }
  }
}
```

### 2. SSE Transport

To run the MCP server using SSE transport:

1. First, create a `.env` file in the `/apps/mcp-server` directory with the following environment variables:

```
PINECONE_API_KEY=
PINECONE_INDEX_NAME=
NEO4J_URI=
NEO4J_USER=
NEO4J_PASSWORD=
OPENAI_API_KEY=
EMBEDDING_MODEL=text-embedding-ada-002
VECTOR_DIMENSION=1536
```

2. Then, install dependencies and start the server:

```sh
cd apps/mcp-server
pnpm install
pnpm start
```

This starts the MCP server at `http://localhost:3001`. To use the server in an application like **Cursor**, configure it as follows:

```json
"mcpServers": {
  "server-name": {
    "url": "http://localhost:3001/sse"
  }
}
```

---

## Why Zettelkasten?

Zettelkasten leverages a **hybrid approach** by combining:

- **Vector databases (Pinecone)** for **semantic search** and similarity-based context retrieval.
- **Graph databases (Neo4j)** for **relationship-based storage**, ensuring chat context is efficiently structured and retrievable across sessions.

This combination provides **fast, context-aware chatbot interactions**, making it ideal for AI-driven conversational agents.

---

## Contributing

Contributions are welcome! Feel free to submit issues and pull requests to improve the project.

---

## License

This project is licensed under the MIT License.

---

## Contact

For any inquiries or support, please create an issue in the repository.

Happy Coding! 🚀
