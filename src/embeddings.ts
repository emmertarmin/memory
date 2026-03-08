import type { MemoryConfig } from "./config.js";
import { getActiveProvider } from "./config.js";
import type { EmbeddingResult, BatchEmbeddingResult } from "./providers/base.js";
export type { EmbeddingResult, BatchEmbeddingResult };

/**
 * Generate embeddings for a batch of texts using the configured provider
 */
export async function generateEmbeddings(
  texts: string[],
  config: MemoryConfig,
): Promise<BatchEmbeddingResult> {
  const { provider, error } = getActiveProvider(config);
  
  if (!provider || error) {
    return {
      results: [],
      error: error || "No provider configured",
    };
  }

  return await provider.generateEmbeddings(texts);
}

/**
 * Generate embeddings for texts in batches
 * This handles large numbers of chunks efficiently
 */
export async function generateEmbeddingsBatched(
  texts: string[],
  config: MemoryConfig,
  onProgress?: (completed: number, total: number) => void,
): Promise<BatchEmbeddingResult> {
  const { provider, error } = getActiveProvider(config);
  
  if (!provider || error) {
    return {
      results: [],
      error: error || "No provider configured",
    };
  }

  // Use provider's configured batch size or default to 100
  const batchSize = (config.providers[0] as { embeddingBatchSize?: number }).embeddingBatchSize || 100;
  const results: EmbeddingResult[] = [];
  const total = texts.length;

  // Process in batches
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResult = await provider.generateEmbeddings(batch);

    if (batchResult.error) {
      return {
        results,
        error: batchResult.error,
      };
    }

    // Adjust indices to match original positions
    const adjustedResults = batchResult.results.map((r) => ({
      ...r,
      index: i + r.index,
    }));

    results.push(...adjustedResults);

    if (onProgress) {
      onProgress(Math.min(i + batchSize, total), total);
    }
  }

  return { results };
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
 * Get the embedding dimensions from the active provider
 */
export function getEmbeddingDimensions(config: MemoryConfig): number {
  const { provider, error } = getActiveProvider(config);
  
  if (!provider || error) {
    return 1536; // default fallback
  }
  
  return provider.getEmbeddingDimensions();
}
