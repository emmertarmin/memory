export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

// Simple token estimation: ~4 characters per token
// This is a rough estimate that works well enough for chunking purposes
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ChunkerConfig {
  targetTokens: number; // default: 400
  overlapTokens: number; // default: 50
  lineBoundary: boolean; // default: true
}

const DEFAULT_CONFIG: ChunkerConfig = {
  targetTokens: 400,
  overlapTokens: 50,
  lineBoundary: true,
};

/**
 * Chunk text into semantically coherent pieces.
 *
 * Strategy:
 * 1. Split into lines
 * 2. Accumulate lines until we approach target token count
 * 3. Respect line boundaries (don't split mid-line)
 * 4. Add overlap from previous chunk to preserve context
 */
export function chunkText(text: string, config: Partial<ChunkerConfig> = {}): Chunk[] {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const { targetTokens, overlapTokens } = fullConfig;

  const lines = text.split("\n");
  const chunks: Chunk[] = [];

  let currentChunkLines: string[] = [];
  let currentChunkStartLine = 1;
  let currentTokenCount = 0;
  let overlapLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = estimateTokens(line + "\n");

    // Check if adding this line would exceed target
    if (currentTokenCount + lineTokens > targetTokens && currentChunkLines.length > 0) {
      // Finalize current chunk
      const chunkContent = currentChunkLines.join("\n");
      chunks.push({
        content: chunkContent,
        startLine: currentChunkStartLine,
        endLine: i, // current index is the line we didn't include
        tokenCount: currentTokenCount,
      });

      // Prepare overlap for next chunk
      // Work backwards to collect ~overlapTokens worth of lines
      overlapLines = [];
      let overlapTokenCount = 0;
      for (let j = currentChunkLines.length - 1; j >= 0; j--) {
        const overlapLine = currentChunkLines[j];
        const overlapLineTokens = estimateTokens(overlapLine + "\n");
        if (overlapTokenCount + overlapLineTokens > overlapTokens) {
          break;
        }
        overlapLines.unshift(overlapLine);
        overlapTokenCount += overlapLineTokens;
      }

      // Start new chunk with overlap
      currentChunkLines = [...overlapLines];
      currentChunkStartLine = i + 1 - overlapLines.length;
      currentTokenCount = overlapTokenCount;
    }

    currentChunkLines.push(line);
    currentTokenCount += lineTokens;
  }

  // Don't forget the last chunk
  if (currentChunkLines.length > 0) {
    chunks.push({
      content: currentChunkLines.join("\n"),
      startLine: currentChunkStartLine,
      endLine: lines.length,
      tokenCount: currentTokenCount,
    });
  }

  return chunks;
}

/**
 * Create a preview of chunk content (first 200 chars)
 */
export function createPreview(content: string, maxLength: number = 200): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength) + "...";
}
