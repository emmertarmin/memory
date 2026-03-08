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
