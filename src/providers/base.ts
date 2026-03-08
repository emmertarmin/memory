/**
 * Base provider interface that all embedding/reranking providers must implement
 */
export interface EmbeddingResult {
  index: number;
  embedding: Float32Array;
  dimensions: number;
}

export interface BatchEmbeddingResult {
  results: EmbeddingResult[];
  error?: string;
}

export interface RerankRequest {
  query: string;
  content: string;
}

export interface RerankResult {
  score: number;
  error?: string;
}

/**
 * Base provider class that all providers extend
 */
export abstract class BaseProvider {
  readonly name: string;
  readonly type: string;

  constructor(name: string, type: string) {
    this.name = name;
    this.type = type;
  }

  /**
   * Generate embeddings for a batch of texts
   */
  abstract generateEmbeddings(texts: string[]): Promise<BatchEmbeddingResult>;

  /**
   * Get rerank score for a query/content pair (0-100)
   */
  abstract rerank(request: RerankRequest): Promise<RerankResult>;

  /**
   * Get the embedding dimensions for this provider's model
   */
  abstract getEmbeddingDimensions(): number;

  /**
   * Get provider-specific configuration schema for documentation
   */
  abstract getConfigSchema(): ProviderConfigSchema;

  /**
   * Validate that this provider is properly configured
   */
  abstract validateConfig(): { valid: boolean; errors: string[] };
}

/**
 * Configuration schema for provider documentation
 */
export interface ProviderConfigSchema {
  type: string;
  description: string;
  required: Array<{
    key: string;
    type: string;
    description: string;
  }>;
  optional: Array<{
    key: string;
    type: string;
    description: string;
    default?: string;
  }>;
}

/**
 * Convert a Float32Array embedding to a Buffer for SQLite storage
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Convert a Buffer back to Float32Array
 */
export function bufferToEmbedding(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Validate that an embedding has the expected dimensions
 */
export function validateEmbedding(
  embedding: Float32Array,
  expectedDimensions: number,
): { valid: boolean; error?: string } {
  if (embedding.length !== expectedDimensions) {
    return {
      valid: false,
      error: `Expected ${expectedDimensions} dimensions, got ${embedding.length}`,
    };
  }
  return { valid: true };
}
