import type { MemoryConfig } from "./config.js";
import { findSimilarChunks, getChunkContent, type SearchResult } from "./db.js";
import { generateEmbeddings } from "./embeddings.js";

export interface RerankedResult extends SearchResult {
  rerankScore: number;
  originalScore: number;
}

/**
 * Rerank search results using an LLM to better match query intent
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

  const reranked: RerankedResult[] = [];

  // Process in parallel with limited concurrency
  const maxConcurrent = 30;
  const batchSize = Math.min(results.length, maxConcurrent);

  // Create batches
  const batches: SearchResult[][] = [];
  for (let i = 0; i < results.length; i += batchSize) {
    batches.push(results.slice(i, i + batchSize));
  }

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
            rerankScore: result.score * 100, // Use original similarity score
            originalScore: result.score,
          };
        }

        // Call LLM to rerank
        const score = await getRerankScore(query, content, config);

        return {
          ...result,
          rerankScore: score,
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
 * Get rerank score from LLM (0-100)
 */
async function getRerankScore(
  query: string,
  content: string,
  config: MemoryConfig,
): Promise<number> {
  // Use chat completions API for reranking
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.rerankModel,
      messages: [
        {
          role: "system",
          content:
            "You are a relevance scorer. Rate how well the document answers the query. Respond with ONLY a number from 0-100.",
        },
        {
          role: "user",
          content: `Query: "${query}"\n\nDocument: "${content.slice(0, 1000)}"\n\nRate relevance (0-100):`,
        },
      ],
      temperature: 0,
      max_tokens: 10,
    }),
  });

  if (!response.ok) {
    throw new Error(`Reranking API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{
      message: {
        content: string;
      };
    }>;
  };

  const content_response = data.choices[0]?.message?.content?.trim() || "50";

  // Extract numeric score
  const match = content_response.match(/(\d+)/);
  if (match) {
    const score = parseInt(match[1], 10);
    return Math.max(0, Math.min(100, score)); // Clamp to 0-100
  }

  return 50; // Default middle score if parsing fails
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
