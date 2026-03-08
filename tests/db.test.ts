import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { getTestDb, setupTestDataDir, cleanupTestDataDir, cleanupTestDb } from "./setup";

// Import functions to test (we'll import them from the actual module)
// Since db.ts has side effects, we'll test the schema directly

describe("Database Schema", () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDataDir();
    db = getTestDb();
  });

  afterAll(async () => {
    db.close();
    await cleanupTestDb();
    await cleanupTestDataDir();
  });

  it("should create files table with correct schema", () => {
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

    const result = db.query("SELECT sql FROM sqlite_master WHERE name = 'files'").get();
    expect(result).toBeDefined();
  });

  it("should create chunks table with correct schema", () => {
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

    const result = db.query("SELECT sql FROM sqlite_master WHERE name = 'chunks'").get();
    expect(result).toBeDefined();
  });

  it("should insert and retrieve a file record", () => {
    const insert = db.query(`
      INSERT INTO files (path, content_hash, last_modified, total_lines)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `);

    const result = insert.get("/test/file.md", "abc123", 1234567890, 100) as { id: number };
    expect(result.id).toBeGreaterThan(0);

    const select = db.query("SELECT * FROM files WHERE id = ?");
    const file = select.get(result.id) as {
      id: number;
      path: string;
      content_hash: string;
      total_lines: number;
    };

    expect(file.path).toBe("/test/file.md");
    expect(file.content_hash).toBe("abc123");
    expect(file.total_lines).toBe(100);
  });

  it("should insert and retrieve a chunk record", () => {
    const fileInsert = db.query(`
      INSERT INTO files (path, content_hash, last_modified, total_lines)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `);
    const file = fileInsert.get("/test/chunk.md", "def456", 1234567890, 50) as { id: number };

    const chunkInsert = db.query(`
      INSERT INTO chunks (file_id, start_line, end_line, token_count, content_preview, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const result = chunkInsert.get(file.id, 1, 10, 100, "Preview text...", null) as { id: number };
    expect(result.id).toBeGreaterThan(0);

    const select = db.query("SELECT * FROM chunks WHERE id = ?");
    const chunk = select.get(result.id) as {
      file_id: number;
      start_line: number;
      end_line: number;
      token_count: number;
      content_preview: string;
      embedding: null;
    };

    expect(chunk.file_id).toBe(file.id);
    expect(chunk.start_line).toBe(1);
    expect(chunk.end_line).toBe(10);
    expect(chunk.token_count).toBe(100);
    expect(chunk.content_preview).toBe("Preview text...");
    expect(chunk.embedding).toBeNull();
  });

  it("should enforce unique constraint on file paths", () => {
    const insert = db.query(`
      INSERT INTO files (path, content_hash, last_modified, total_lines)
      VALUES (?, ?, ?, ?)
    `);

    insert.run("/test/unique.md", "hash1", 1, 10);

    expect(() => {
      insert.run("/test/unique.md", "hash2", 2, 20);
    }).toThrow();
  });

  it("should cascade delete chunks when file is deleted", () => {
    const fileInsert = db.query(`
      INSERT INTO files (path, content_hash, last_modified, total_lines)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `);
    const file = fileInsert.get("/test/cascade.md", "hash789", 1, 10) as { id: number };

    const chunkInsert = db.query(`
      INSERT INTO chunks (file_id, start_line, end_line, token_count, content_preview)
      VALUES (?, ?, ?, ?, ?)
    `);
    chunkInsert.run(file.id, 1, 5, 50, "content");

    // Count chunks before delete
    const countBefore = db
      .query("SELECT COUNT(*) as count FROM chunks WHERE file_id = ?")
      .get(file.id) as { count: number };
    expect(countBefore.count).toBe(1);

    // Delete file
    db.run("DELETE FROM files WHERE id = ?", [file.id]);

    // Chunks should be deleted (cascade)
    const countAfter = db
      .query("SELECT COUNT(*) as count FROM chunks WHERE file_id = ?")
      .get(file.id) as { count: number };
    expect(countAfter.count).toBe(0);
  });
});

describe("Database Operations - Future Features (TDD)", () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDataDir();
    db = getTestDb();

    // Setup schema
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
  });

  afterAll(async () => {
    db.close();
    await cleanupTestDb();
    await cleanupTestDataDir();
  });

  it("should store embedding as float32 array blob", () => {
    const fileInsert = db.query(`
      INSERT INTO files (path, content_hash, last_modified, total_lines)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `);
    const file = fileInsert.get("/test/embedding.md", "hash", 1, 10) as { id: number };

    // Create a mock embedding (1536 dimensions for text-embedding-3-small)
    const embedding = new Float32Array(1536);
    for (let i = 0; i < 1536; i++) {
      embedding[i] = Math.random() * 2 - 1; // Random values between -1 and 1
    }

    const embeddingBuffer = Buffer.from(embedding.buffer);

    const chunkInsert = db.query(`
      INSERT INTO chunks (file_id, start_line, end_line, token_count, content_preview, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const result = chunkInsert.get(file.id, 1, 5, 100, "preview", embeddingBuffer) as {
      id: number;
    };

    const select = db.query("SELECT embedding FROM chunks WHERE id = ?");
    const chunk = select.get(result.id) as { embedding: Buffer };

    expect(chunk.embedding).toBeDefined();
    expect(chunk.embedding.length).toBe(1536 * 4); // 1536 floats * 4 bytes each

    // Verify we can reconstruct the Float32Array
    const reconstructed = new Float32Array(
      chunk.embedding.buffer,
      chunk.embedding.byteOffset,
      chunk.embedding.byteLength / 4,
    );
    expect(reconstructed.length).toBe(1536);
  });

  it.todo("should support vector similarity search via extension", () => {
    // This will fail until we add sqlite-vec or similar extension
    // SELECT id FROM chunks ORDER BY vec_distance_cosine(embedding, ?) LIMIT 10
    expect(() => {
      db.run("SELECT vec_distance_cosine(embedding, ?) FROM chunks", [Buffer.alloc(0)]);
    }).toThrow();
  });

  it.todo("should support FTS for hybrid search", () => {
    // This will fail until we add FTS5
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content_preview, content=chunks, content_rowid=id)
    `);
  });
});
