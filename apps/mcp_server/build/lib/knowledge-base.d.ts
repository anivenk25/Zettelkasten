import { RecordMetadata } from "@pinecone-database/pinecone";
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
export declare class KnowledgeBase {
    private neo4jDriver;
    private pineconeClient;
    private pineconeIndex;
    private openai;
    constructor();
    private initPineconeClient;
    private initDatabase;
    private generateEmbedding;
    storeMessage(userId: string, sessionId: string, messageContent: string, role: string | undefined, metadata: RecordMetadata): Promise<string>;
    getMsgContext(userId: string, queryText: string, topK?: number): Promise<ContextResult>;
    getSessionHistory(sessionId: string): Promise<any[]>;
    close(): Promise<void>;
}
