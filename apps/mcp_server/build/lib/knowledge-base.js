import { config } from "dotenv";
import * as neo4j from "neo4j-driver";
import { Pinecone } from "@pinecone-database/pinecone";
import { OpenAI } from "openai";
import { v4 as uuidv4 } from "uuid";
config();
// Configuration
const PINECONE_API_KEY = process.env.PINECONE_API_KEY || "";
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || "chat-context";
const NEO4J_URI = process.env.NEO4J_URI || "";
const NEO4J_USER = process.env.NEO4J_USER || "";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-ada-002"; // OpenAI embedding model
const VECTOR_DIMENSION = process.env.VECTOR_DIMENSION || 1536; // Dimension for Ada embeddings
export class KnowledgeBase {
    neo4jDriver;
    pineconeClient;
    //@ts-ignore
    pineconeIndex;
    openai;
    constructor() {
        this.openai = new OpenAI({ apiKey: OPENAI_API_KEY });
        this.neo4jDriver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
        this.pineconeClient = new Pinecone({
            apiKey: PINECONE_API_KEY,
        });
        this.initPineconeClient();
    }
    async initPineconeClient() {
        try {
            const indexesList = await this.pineconeClient.listIndexes();
            if (!indexesList.indexes?.find((im) => im.name == PINECONE_INDEX_NAME)) {
                await this.pineconeClient.createIndex({
                    name: PINECONE_INDEX_NAME,
                    metric: "cosine",
                    dimension: parseInt(VECTOR_DIMENSION.toString()),
                    spec: {
                        serverless: {
                            cloud: "aws",
                            region: "us-east-1",
                        },
                    },
                });
            }
            else {
            }
            this.pineconeIndex = this.pineconeClient.Index(PINECONE_INDEX_NAME);
            await this.initDatabase();
        }
        catch (error) {
            throw error;
        }
    }
    async initDatabase() {
        const session = this.neo4jDriver.session();
        try {
            await session.run(`
        CREATE CONSTRAINT user_id IF NOT EXISTS 
        FOR (u:User) REQUIRE u.user_id IS UNIQUE
      `);
            await session.run(`
        CREATE CONSTRAINT session_id IF NOT EXISTS 
        FOR (s:Session) REQUIRE s.session_id IS UNIQUE
      `);
            await session.run(`
        CREATE CONSTRAINT message_id IF NOT EXISTS 
        FOR (m:Message) REQUIRE m.message_id IS UNIQUE
      `);
            await session.run(`
        CREATE INDEX message_vector_id IF NOT EXISTS 
        FOR (m:Message) ON (m.vector_id)
      `);
        }
        catch (error) {
            throw error;
        }
        finally {
            await session.close();
        }
    }
    async generateEmbedding(text) {
        try {
            const response = await this.openai.embeddings.create({
                model: EMBEDDING_MODEL,
                input: text,
            });
            return response.data[0].embedding;
        }
        catch (error) {
            throw error;
        }
    }
    async storeMessage(userId, sessionId, messageContent, role = "user", metadata) {
        const messageId = uuidv4();
        const vectorId = `vec_${messageId}`;
        const timestamp = Date.now();
        try {
            const embedding = await this.generateEmbedding(messageContent);
            await this.pineconeIndex.namespace(userId).upsert([
                {
                    id: vectorId,
                    values: embedding,
                    metadata: {
                        user_id: userId,
                        session_id: sessionId,
                        message_id: messageId,
                        role,
                        timestamp,
                        ...metadata,
                    },
                },
            ]);
            const session = this.neo4jDriver.session();
            try {
                await session.run(`
          MERGE (u:User {user_id: $userId})
          MERGE (s:Session {session_id: $sessionId})
          CREATE (m:Message {
            message_id: $messageId,
            content: $content,
            vector_id: $vectorId,
            role: $role,
            timestamp: $timestamp,
            metadata: $metadataJson
          })
          MERGE (u)-[:PARTICIPATED_IN]->(s)
          MERGE (m)-[:PART_OF]->(s)
          MERGE (u)-[:AUTHORED]->(m)
        `, {
                    userId,
                    sessionId,
                    messageId,
                    content: messageContent,
                    vectorId,
                    role,
                    timestamp,
                    metadataJson: JSON.stringify(metadata),
                });
            }
            catch (error) {
                throw error;
            }
            finally {
                await session.close();
            }
            return messageId;
        }
        catch (error) {
            throw error;
        }
    }
    async getMsgContext(userId, queryText, topK = 5) {
        try {
            const queryEmbedding = await this.generateEmbedding(queryText);
            const queryResponse = await this.pineconeIndex.namespace(userId).query({
                vector: queryEmbedding,
                topK,
                includeMetadata: true,
                filter: { user_id: userId },
            });
            const matches = queryResponse.matches || [];
            if (matches.length === 0) {
                return { messages: [], relatedSessions: [] };
            }
            const vectorIds = matches.map((match) => match.id);
            const session = this.neo4jDriver.session();
            try {
                const result = await session.run(`
          MATCH (m:Message)
          WHERE m.vector_id IN $vectorIds
          MATCH (m)-[:PART_OF]->(s:Session)
          WITH s, m
          ORDER BY m.timestamp
          WITH s, collect(m) as sessionMessages
          MATCH (contextMsg:Message)-[:PART_OF]->(s)
          WITH s.session_id as sessionId, contextMsg
          ORDER BY contextMsg.timestamp
          RETURN sessionId, collect({
            content: contextMsg.content,
            role: contextMsg.role,
            timestamp: contextMsg.timestamp,
            metadata: contextMsg.metadata
          }) as contextMessages
        `, { vectorIds });
                const sessionMessages = {};
                const sessions = [];
                result.records.forEach((record) => {
                    const sessionId = record.get("sessionId");
                    const messages = record.get("contextMessages");
                    sessionMessages[sessionId] = messages;
                    sessions.push(sessionId);
                });
                const allContextMessages = matches.flatMap((match) => {
                    const sessionId = match.metadata?.session_id;
                    return sessionMessages[sessionId?.toString() || ""]?.map((msg) => ({
                        ...msg,
                        session_id: sessionId,
                        metadata: msg.metadata ? JSON.parse(msg.metadata) : undefined,
                    }));
                });
                return {
                    messages: allContextMessages,
                    relatedSessions: [...new Set(sessions)],
                };
            }
            catch (error) {
                throw error;
            }
            finally {
                await session.close();
            }
        }
        catch (error) {
            throw error;
        }
    }
    async getSessionHistory(sessionId) {
        const session = this.neo4jDriver.session();
        try {
            const result = await session.run(`
        MATCH (m:Message)-[:PART_OF]->(:Session {session_id: $sessionId})
        RETURN m.content as content, m.role as role, m.timestamp as timestamp,
               m.metadata as metadata
        ORDER BY m.timestamp
      `, { sessionId });
            const messages = result.records.map((record) => ({
                content: record.get("content"),
                role: record.get("role"),
                timestamp: record.get("timestamp"),
                metadata: record.get("metadata")
                    ? JSON.parse(record.get("metadata"))
                    : {},
            }));
            return messages;
        }
        catch (error) {
            throw error;
        }
        finally {
            await session.close();
        }
    }
    async close() {
        await this.neo4jDriver.close();
    }
}
