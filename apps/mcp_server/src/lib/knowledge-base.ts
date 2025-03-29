import { config } from "dotenv";
import * as neo4j from "neo4j-driver";
import { Index, Pinecone, RecordMetadata } from "@pinecone-database/pinecone";
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

// Types
export interface MessageMetadata {
  [key: string]: any;
}

export interface ContextResult {
  messages: Array<{
    content: string;
    role: string;
    session_id: string;
    timestamp: number;
    metadata?: MessageMetadata;
  }>;
  relatedSessions: string[];
}

export class KnowledgeBase {
  private neo4jDriver: neo4j.Driver;
  private pineconeClient: Pinecone;
  //@ts-ignore
  private pineconeIndex: Index;
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    this.neo4jDriver = neo4j.driver(
      NEO4J_URI,
      neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
    );

    this.pineconeClient = new Pinecone({
      apiKey: PINECONE_API_KEY,
    });
    this.initPineconeClient();
  }

  private async initPineconeClient(): Promise<void> {
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
      } else {
      }

      this.pineconeIndex = this.pineconeClient.Index(PINECONE_INDEX_NAME);

      await this.initDatabase();
    } catch (error) {
      throw error;
    }
  }

  private async initDatabase(): Promise<void> {
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
    } catch (error) {
      throw error;
    } finally {
      await session.close();
    }
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
      });
      return response.data[0].embedding;
    } catch (error) {
      throw error;
    }
  }

  public async storeMessage(
    userId: string,
    sessionId: string,
    messageContent: string,
    role: string = "user",
    metadata: RecordMetadata,
  ): Promise<string> {
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
        await session.run(
          `
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
        `,
          {
            userId,
            sessionId,
            messageId,
            content: messageContent,
            vectorId,
            role,
            timestamp,
            metadataJson: JSON.stringify(metadata),
          },
        );
      } catch (error) {
        throw error;
      } finally {
        await session.close();
      }

      return messageId;
    } catch (error) {
      throw error;
    }
  }

  public async getMsgContext(
    userId: string,
    queryText: string,
    topK: number = 5,
  ): Promise<ContextResult> {
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
        const result = await session.run(
          `
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
        `,
          { vectorIds },
        );

        const sessionMessages: { [key: string]: any[] } = {};
        const sessions: string[] = [];

        result.records.forEach((record) => {
          const sessionId = record.get("sessionId");
          const messages = record.get("contextMessages");
          sessionMessages[sessionId] = messages;
          sessions.push(sessionId);
        });

        const allContextMessages = matches.flatMap((match) => {
          const sessionId = match.metadata?.session_id;
          return sessionMessages[sessionId?.toString() || ""]?.map(
            (msg: any) => ({
              ...msg,
              session_id: sessionId,
              metadata: msg.metadata ? JSON.parse(msg.metadata) : undefined,
            }),
          );
        });

        return {
          messages: allContextMessages,
          relatedSessions: [...new Set(sessions)],
        };
      } catch (error) {
        throw error;
      } finally {
        await session.close();
      }
    } catch (error) {
      throw error;
    }
  }

  public async getSessionHistory(sessionId: string): Promise<any[]> {
    const session = this.neo4jDriver.session();
    try {
      const result = await session.run(
        `
        MATCH (m:Message)-[:PART_OF]->(:Session {session_id: $sessionId})
        RETURN m.content as content, m.role as role, m.timestamp as timestamp,
               m.metadata as metadata
        ORDER BY m.timestamp
      `,
        { sessionId },
      );

      const messages = result.records.map((record) => ({
        content: record.get("content"),
        role: record.get("role"),
        timestamp: record.get("timestamp"),
        metadata: record.get("metadata")
          ? JSON.parse(record.get("metadata"))
          : {},
      }));

      return messages;
    } catch (error) {
      throw error;
    } finally {
      await session.close();
    }
  }

  public async close(): Promise<void> {
    await this.neo4jDriver.close();
  }
}
