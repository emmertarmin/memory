import { Database } from "bun:sqlite";
import * as path from "path";
import { mkdir } from "fs/promises";
import { DATA_DIR } from "./config.js";

// Ensure data directory exists
const dbPath = path.join(DATA_DIR, "index.sqlite");
await mkdir(DATA_DIR, { recursive: true });

export const db = new Database(dbPath);

// Enable WAL mode for concurrent reads during indexing
db.run("PRAGMA journal_mode = WAL");

// Enable foreign key constraints
db.run("PRAGMA foreign_keys = ON");

// Initialize schema
export function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      content_hash TEXT NOT NULL,
      last_modified INTEGER NOT NULL,
      total_lines INTEGER NOT NULL,
      indexed_at INTEGER DEFAULT (unixepoch())
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      embedding BLOB,
      content_preview TEXT
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id)
  `);
}

export interface FileRecord {
  id: number;
  path: string;
  content_hash: string;
  last_modified: number;
  total_lines: number;
  indexed_at: number;
}

export interface ChunkRecord {
  id: number;
  file_id: number;
  start_line: number;
  end_line: number;
  token_count: number;
  embedding: Buffer | null;
  content_preview: string | null;
}

// Get file by path
export function getFileByPath(filePath: string): FileRecord | null {
  const stmt = db.query("SELECT * FROM files WHERE path = ?");
  return stmt.get(filePath) as FileRecord | null;
}

// Get all files from the database
export function getAllFiles(): FileRecord[] {
  const stmt = db.query("SELECT * FROM files");
  return stmt.all() as FileRecord[];
}

// Delete a file and its associated chunks (cascades via FK)
export function deleteFile(fileId: number): void {
  const stmt = db.query("DELETE FROM files WHERE id = ?");
  stmt.run(fileId);
}

// Count chunks for a file
export function countChunksForFile(fileId: number): number {
  const stmt = db.query("SELECT COUNT(*) as count FROM chunks WHERE file_id = ?");
  const result = stmt.get(fileId) as { count: number };
  return result.count;
}

// Insert or replace file record
export function upsertFile(
  filePath: string,
  contentHash: string,
  lastModified: number,
  totalLines: number,
): number {
  const stmt = db.query(`
    INSERT INTO files (path, content_hash, last_modified, total_lines)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      content_hash = excluded.content_hash,
      last_modified = excluded.last_modified,
      total_lines = excluded.total_lines,
      indexed_at = unixepoch()
    RETURNING id
  `);
  const result = stmt.get(filePath, contentHash, lastModified, totalLines) as { id: number };
  return result.id;
}

// Delete all chunks for a file
export function deleteChunksForFile(fileId: number): void {
  const stmt = db.query("DELETE FROM chunks WHERE file_id = ?");
  stmt.run(fileId);
}

// Insert a chunk
export function insertChunk(
  fileId: number,
  startLine: number,
  endLine: number,
  tokenCount: number,
  contentPreview: string,
  embedding: Buffer | null = null,
): void {
  const stmt = db.query(`
    INSERT INTO chunks (file_id, start_line, end_line, token_count, content_preview, embedding)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(fileId, startLine, endLine, tokenCount, contentPreview, embedding);
}

// Update a chunk's embedding
export function updateChunkEmbedding(chunkId: number, embedding: Buffer): void {
  const stmt = db.query(`
    UPDATE chunks 
    SET embedding = ? 
    WHERE id = ?
  `);
  stmt.run(embedding, chunkId);
}

// Get a chunk by ID
export function getChunkById(chunkId: number): ChunkRecord | null {
  const stmt = db.query("SELECT * FROM chunks WHERE id = ?");
  return stmt.get(chunkId) as ChunkRecord | null;
}

// Get all chunks for a file with their IDs
export function getChunksWithIdsByFileId(fileId: number): Array<ChunkRecord & { id: number }> {
  const stmt = db.query("SELECT * FROM chunks WHERE file_id = ? ORDER BY start_line");
  return stmt.all(fileId) as Array<ChunkRecord & { id: number }>;
}

// Get all chunks with embeddings for vector similarity search
export function getAllChunksWithEmbeddings(): Array<
  ChunkRecord & { id: number; file_path: string }
> {
  const stmt = db.query(`
    SELECT c.*, f.path as file_path 
    FROM chunks c
    JOIN files f ON c.file_id = f.id
    WHERE c.embedding IS NOT NULL
  `);
  return stmt.all() as Array<ChunkRecord & { id: number; file_path: string }>;
}

// Search result interface
export interface SearchResult {
  chunkId: number;
  fileId: number;
  filePath: string;
  startLine: number;
  endLine: number;
  contentPreview: string | null;
  score: number;
}

// Calculate cosine similarity between two Float32Array embeddings
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

// Convert Buffer back to Float32Array
export function bufferToFloat32Array(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}

// Find top-k similar chunks using cosine similarity
export function findSimilarChunks(queryEmbedding: Float32Array, topK: number = 20): SearchResult[] {
  const allChunks = getAllChunksWithEmbeddings();
  const scored: SearchResult[] = [];

  for (const chunk of allChunks) {
    if (!chunk.embedding) continue;

    const chunkEmbedding = bufferToFloat32Array(chunk.embedding as Buffer);
    const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);

    scored.push({
      chunkId: chunk.id,
      fileId: chunk.file_id,
      filePath: chunk.file_path,
      startLine: chunk.start_line,
      endLine: chunk.end_line,
      contentPreview: chunk.content_preview,
      score: similarity,
    });
  }

  // Sort by score descending and return top K
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// Get full chunk content for reranking (fetches from file)
export async function getChunkContent(
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return null;
    }

    const content = await file.text();
    const lines = content.split("\n");

    // Convert to 0-indexed and clamp to bounds
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);

    return lines.slice(start, end).join("\n");
  } catch {
    return null;
  }
}
