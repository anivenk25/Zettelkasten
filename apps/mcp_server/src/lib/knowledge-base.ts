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
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-ada-002"; 
const VECTOR_DIMENSION = process.env.VECTOR_DIMENSION || 1536;
const CONTEXT_CACHE_SIZE = parseInt(process.env.CONTEXT_CACHE_SIZE || "100");
const SESSION_CACHE_SIZE = parseInt(process.env.SESSION_CACHE_SIZE || "50");

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

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  lastAccessed: number;
  embedding: number[];
  key: string;
}

class SemanticCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private maxSize: number;
  private openai: OpenAI;
  private cacheHits: number = 0;
  private cacheMisses: number = 0;

  constructor(maxSize: number, openai: OpenAI) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.openai = openai;
  }

  public async get(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastAccessed = Date.now();
      this.cacheHits++;
      return entry.data;
    }
    this.cacheMisses++;
    return null;
  }

  public async set(key: string, data: T, queryText: string): Promise<void> {
    const embedding = await this.generateEmbedding(queryText);
    
    if (this.cache.size >= this.maxSize) {
      await this.evictLeastSimilar(embedding);
    }
    
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      embedding,
      key
    });
  }

  public getStats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.cacheHits + this.cacheMisses;
    const hitRate = total === 0 ? 0 : this.cacheHits / total;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.cache.size,
      hitRate
    };
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
      });
      return response.data[0].embedding;
    } catch (error) {
      console.error("Error generating embedding for cache:", error);
      return new Array(parseInt(VECTOR_DIMENSION.toString())).fill(0);
    }
  }

  private async evictLeastSimilar(newEmbedding: number[]): Promise<void> {
    if (this.cache.size === 0) return;

    const entries = Array.from(this.cache.values());
    let leastSimilarKey = entries[0].key;
    let lowestSimilarity = 1.0;

    for (const entry of entries) {
      const similarity = this.cosineSimilarity(newEmbedding, entry.embedding);
      
      const recencyScore = (Date.now() - entry.lastAccessed) / (24 * 60 * 60 * 1000); // Normalize to days
      const hybridScore = similarity - (recencyScore * 0.2); // Adjust weight as needed
      
      if (hybridScore < lowestSimilarity) {
        lowestSimilarity = hybridScore;
        leastSimilarKey = entry.key;
      }
    }

    this.cache.delete(leastSimilarKey);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    
    if (normA === 0 || normB === 0) {
      return 0;
    }
    
    return dotProduct / (normA * normB);
  }
}

class HybridLRUMRUCache<T> {
  private cache: Map<string, { data: T; timestamp: number; accessCount: number; lastAccessed: number }>;
  private maxSize: number;
  private cacheHits: number = 0;
  private cacheMisses: number = 0;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  public get(key: string): T | null {
    const entry = this.cache.get(key);
    if (entry) {
      // Update access count 
      entry.accessCount++;
      entry.lastAccessed = Date.now();
      this.cacheHits++;
      return entry.data;
    }
    this.cacheMisses++;
    return null;
  }

  public set(key: string, data: T): void {
    if (this.cache.size >= this.maxSize) {
      this.evict();
    }
    
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      accessCount: 1,
      lastAccessed: Date.now()
    });
  }

  public getStats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.cacheHits + this.cacheMisses;
    const hitRate = total === 0 ? 0 : this.cacheHits / total;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.cache.size,
      hitRate
    };
  }

  private evict(): void {
    if (this.cache.size === 0) return;

    const entries = Array.from(this.cache.entries());
    
    entries.sort((a, b) => {
      const aEntry = a[1];
      const bEntry = b[1];
      
      const aRecency = Date.now() - aEntry.lastAccessed;
      const bRecency = Date.now() - bEntry.lastAccessed;
      
      // Normalize recency (newer is better, so inverse)
      const maxRecency = Math.max(aRecency, bRecency);
      const normalizedARecency = 1 - (aRecency / maxRecency);
      const normalizedBRecency = 1 - (bRecency / maxRecency);
      
      // Normalize frequency (more accesses is better)
      const maxFreq = Math.max(aEntry.accessCount, bEntry.accessCount);
      const normalizedAFreq = aEntry.accessCount / maxFreq;
      const normalizedBFreq = bEntry.accessCount / maxFreq;
      
      const aScore = (normalizedAFreq * 0.6) + (normalizedARecency * 0.4);
      const bScore = (normalizedBFreq * 0.6) + (normalizedBRecency * 0.4);
      
      return aScore - bScore;
    });
    
    // Remove lowest hybrid score
    this.cache.delete(entries[0][0]);
  }
}

export class KnowledgeBase {
  private neo4jDriver: neo4j.Driver;
  private pineconeClient: Pinecone;
  //@ts-ignore
  private pineconeIndex: Index;
  private openai: OpenAI;
  private contextCache: SemanticCache<ContextResult>;
  private sessionCache: HybridLRUMRUCache<any[]>;

  constructor() {
    this.openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    this.neo4jDriver = neo4j.driver(
      NEO4J_URI,
      neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
    );

    this.pineconeClient = new Pinecone({
      apiKey: PINECONE_API_KEY,
    });
    
    this.contextCache = new SemanticCache<ContextResult>(CONTEXT_CACHE_SIZE, this.openai);
    this.sessionCache = new HybridLRUMRUCache<any[]>(SESSION_CACHE_SIZE);
    
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
        
        this.sessionCache.set(sessionId, []);
        
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
      const cacheKey = `context_${userId}_${this.hashString(queryText)}_${topK}`;
      
      const cachedResult = await this.contextCache.get(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }

      const queryEmbedding = await this.generateEmbedding(queryText);

      const queryResponse = await this.pineconeIndex.namespace(userId).query({
        vector: queryEmbedding,
        topK,
        includeMetadata: true,
        filter: { user_id: userId },
      });

      const matches = queryResponse.matches || [];

      if (matches.length === 0) {
        const emptyResult = { messages: [], relatedSessions: [] };
        await this.contextCache.set(cacheKey, emptyResult, queryText);
        return emptyResult;
      }

      const vectorIds = matches.map((match) => match.id);

      const session = this.neo4jDriver.session();
      try {
        const neo4jResult = await session.run(
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

        neo4jResult.records.forEach((record) => {
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

        const contextResult = {
          messages: allContextMessages,
          relatedSessions: [...new Set(sessions)],
        };
        
        await this.contextCache.set(cacheKey, contextResult, queryText);
        
        return contextResult;
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
    try {
      const cachedResult = this.sessionCache.get(sessionId);
      if (cachedResult) {
        return cachedResult;
      }
      
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
        
        this.sessionCache.set(sessionId, messages);
        
        return messages;
      } catch (error) {
        throw error;
      } finally {
        await session.close();
      }
    } catch (error) {
      throw error;
    }
  }
  
  public getCacheStats(): { 
    contextCache: { hits: number; misses: number; size: number; hitRate: number };
    sessionCache: { hits: number; misses: number; size: number; hitRate: number };
  } {
    return {
      contextCache: this.contextCache.getStats(),
      sessionCache: this.sessionCache.getStats()
    };
  }
  
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;     }
    return hash.toString(16); 
  }

  public async close(): Promise<void> {
    await this.neo4jDriver.close();
  }
}
