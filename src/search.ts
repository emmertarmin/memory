import type { MemoryConfig } from "./config.js";
import { getActiveProvider } from "./config.js";
import { findSimilarChunks, getChunkContent, type SearchResult } from "./db.js";
import { generateEmbeddings } from "./embeddings.js";

export interface RerankedResult extends SearchResult {
  rerankScore: number;
  originalScore: number;
}

/**
 * Rerank search results using the configured provider's LLM
 * Returns results scored from 0-100, normalized to 0-1
 */
export async function rerankResults(
  query: string,
  results: SearchResult[],
  config: MemoryConfig,
): Promise<RerankedResult[]> {
  if (results.length === 0) {
    return [];
  }

  const { provider, error } = getActiveProvider(config);

  if (!provider || error) {
    // Fall back to original scores if no provider available
    return results.map((result) => ({
      ...result,
      rerankScore: result.score * 100,
      originalScore: result.score,
    }));
  }

  // Get max concurrent from provider config or default
  const maxConcurrent =
    (config.providers[0] as { rerankMaxConcurrent?: number }).rerankMaxConcurrent || 30;
  const batchSize = Math.min(results.length, maxConcurrent);

  // Create batches
  const batches: SearchResult[][] = [];
  for (let i = 0; i < results.length; i += batchSize) {
    batches.push(results.slice(i, i + batchSize));
  }

  const reranked: RerankedResult[] = [];

  for (const batch of batches) {
    // Process batch in parallel
    const batchPromises = batch.map(async (result) => {
      try {
        // Fetch full content for reranking context
        const content = await getChunkContent(result.filePath, result.startLine, result.endLine);

        if (!content) {
          // Fall back to preview if full content unavailable
          return {
            ...result,
            rerankScore: result.score * 100,
            originalScore: result.score,
          };
        }

        // Call provider to rerank
        const rerankResult = await provider.rerank({ query, content });

        return {
          ...result,
          rerankScore: rerankResult.error ? result.score * 100 : rerankResult.score,
          originalScore: result.score,
        };
      } catch (error) {
        // On error, fall back to original score
        return {
          ...result,
          rerankScore: result.score * 100,
          originalScore: result.score,
        };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    reranked.push(...batchResults);
  }

  // Sort by rerank score (descending)
  reranked.sort((a, b) => b.rerankScore - a.rerankScore);

  return reranked;
}

/**
 * Merge adjacent/overlapping results from the same file
 */
export function mergeAdjacentResults(results: RerankedResult[]): RerankedResult[] {
  if (results.length === 0) {
    return [];
  }

  // Sort by file path, then start line
  const sorted = [...results].sort((a, b) => {
    if (a.filePath !== b.filePath) {
      return a.filePath.localeCompare(b.filePath);
    }
    return a.startLine - b.startLine;
  });

  const merged: RerankedResult[] = [];
  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];

    // Check if results should merge (same file, within 5 lines)
    if (current.filePath === next.filePath && next.startLine <= current.endLine + 5) {
      // Merge: extend end line, keep higher score
      current = {
        ...current,
        endLine: Math.max(current.endLine, next.endLine),
        rerankScore: Math.max(current.rerankScore, next.rerankScore),
        contentPreview: current.contentPreview
          ? `${current.contentPreview}...${next.contentPreview || ""}`
          : next.contentPreview,
      };
    } else {
      // No overlap, push current and start new
      merged.push(current);
      current = next;
    }
  }

  // Don't forget the last one
  merged.push(current);

  return merged;
}

/**
 * Execute full search pipeline: embed query, find similar chunks, rerank, merge, return top N
 */
export async function executeSearch(
  query: string,
  config: MemoryConfig,
  options: {
    topK?: number;
    finalK?: number;
    noRerank?: boolean;
  } = {},
): Promise<
  Array<{
    file: string;
    start_line: number;
    end_line: number;
    score: number;
    content_preview: string;
  }>
> {
  const { topK = 20, finalK = 5, noRerank = false } = options;

  // 1. Generate embedding for query
  const embeddingResult = await generateEmbeddings([query], config);

  if (embeddingResult.error) {
    throw new Error(`Embedding error: ${embeddingResult.error}`);
  }

  if (embeddingResult.results.length === 0) {
    return [];
  }

  const queryEmbedding = embeddingResult.results[0].embedding;

  // 2. Find top-k similar chunks
  const similarChunks = findSimilarChunks(queryEmbedding, topK);

  if (similarChunks.length === 0) {
    return [];
  }

  // 3. Rerank if enabled
  let results: RerankedResult[];
  if (noRerank) {
    // Skip reranking, convert similarity scores to 0-100 scale
    results = similarChunks.map((chunk) => ({
      ...chunk,
      rerankScore: chunk.score * 100,
      originalScore: chunk.score,
    }));
  } else {
    results = await rerankResults(query, similarChunks, config);
  }

  // 4. Merge adjacent results
  const merged = mergeAdjacentResults(results);

  // 5. Return top finalK results
  const finalResults = merged.slice(0, finalK);

  // 6. Format output
  return finalResults.map((result) => ({
    file: result.filePath,
    start_line: result.startLine,
    end_line: result.endLine,
    score: result.rerankScore / 100, // Normalize to 0-1
    content_preview: result.contentPreview || "",
  }));
}
