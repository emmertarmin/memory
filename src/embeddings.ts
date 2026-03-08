import type { MemoryConfig } from "./config.js";

export interface EmbeddingResult {
  index: number;
  embedding: Float32Array;
  dimensions: number;
}

export interface BatchEmbeddingResult {
  results: EmbeddingResult[];
  error?: string;
}

/**
 * Generate embeddings for a batch of texts using OpenAI API
 */
export async function generateEmbeddings(
  texts: string[],
  config: MemoryConfig,
): Promise<BatchEmbeddingResult> {
  if (!config.apiKey || config.apiKey.trim() === "") {
    return {
      results: [],
      error: "OpenAI API key is not configured",
    };
  }

  // Clean and validate texts
  const validTexts = texts.map((t) => t.trim()).filter((t) => t.length > 0);

  if (validTexts.length === 0) {
    return {
      results: [],
      error: "No valid texts to embed",
    };
  }

  // Infer dimensions from model name
  const dimensions = config.embeddingModel.includes("large")
    ? 3072
    : config.embeddingModel.includes("small")
      ? 1536
      : 1536;

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: validTexts,
        model: config.embeddingModel,
        dimensions: dimensions,
        encoding_format: "float",
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      const errorMessage =
        errorData.error?.message || `API request failed with status ${response.status}`;
      return {
        results: [],
        error: errorMessage,
      };
    }

    const data = (await response.json()) as {
      data: Array<{
        embedding: number[];
        index: number;
        object: string;
      }>;
      model: string;
      usage: {
        prompt_tokens: number;
        total_tokens: number;
      };
    };

    const results: EmbeddingResult[] = data.data.map((item) => ({
      index: item.index,
      embedding: new Float32Array(item.embedding),
      dimensions: item.embedding.length,
    }));

    // Sort by original index to maintain order
    results.sort((a, b) => a.index - b.index);

    return { results };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      results: [],
      error: `Failed to generate embeddings: ${errorMessage}`,
    };
  }
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
  const batchSize = 100; // Hardcoded batch size
  const results: EmbeddingResult[] = [];
  const total = texts.length;

  // Process in batches
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResult = await generateEmbeddings(batch, config);

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
