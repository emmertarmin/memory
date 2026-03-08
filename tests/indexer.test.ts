import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs/promises";
import * as path from "path";
import {
  getTestDb,
  setupTestDataDir,
  cleanupTestDataDir,
  cleanupTestDb,
  createTestFile,
  TEST_CONFIG_PATH,
} from "./setup";

// Import the modules we want to test
import { chunkText, createPreview } from "../src/chunker";

// Helper to load test config
async function loadTestConfig() {
  const content = await fs.readFile(TEST_CONFIG_PATH, "utf-8");
  return JSON.parse(content);
}

describe("Indexer Workflow", () => {
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

    db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id)`);
  });

  afterAll(async () => {
    db.close();
    await cleanupTestDb();
    await cleanupTestDataDir();
  });

  it("should compute consistent SHA-256 hash", async () => {
    const content = "Test content for hashing";
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const hash1 = hasher.digest("hex");

    const hasher2 = new Bun.CryptoHasher("sha256");
    hasher2.update(content);
    const hash2 = hasher2.digest("hex");

    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 hex is 64 chars
  });

  it("should produce different hashes for different content", async () => {
    const hasher1 = new Bun.CryptoHasher("sha256");
    hasher1.update("Content A");
    const hash1 = hasher1.digest("hex");

    const hasher2 = new Bun.CryptoHasher("sha256");
    hasher2.update("Content B");
    const hash2 = hasher2.digest("hex");

    expect(hash1).not.toBe(hash2);
  });

  it("should read file and chunk content correctly", async () => {
    const content = `# Title

This is paragraph one.
This is paragraph two.

## Section 2

More content here.
Even more content.`.repeat(20); // Make it long enough to chunk

    const filePath = await createTestFile("test-article.md", content);

    // Read back
    const file = Bun.file(filePath);
    const readContent = await file.text();

    expect(readContent).toBe(content);

    // Chunk it
    const chunks = chunkText(readContent);
    expect(chunks.length).toBeGreaterThan(0);

    // Each chunk should have proper line tracking
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });

  it("should store file with hash and retrieve by path", async () => {
    const content = "Sample markdown content\nWith multiple lines\nFor testing";
    const filePath = await createTestFile("hash-test.md", content);

    // Compute hash
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const hash = hasher.digest("hex");

    // Get file stats
    const stats = await fs.stat(filePath);
    const lastModified = Math.floor(stats.mtimeMs / 1000);
    const lines = content.split("\n").length;

    // Insert into DB
    const insert = db.query(`
      INSERT INTO files (path, content_hash, last_modified, total_lines)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        content_hash = excluded.content_hash,
        last_modified = excluded.last_modified,
        total_lines = excluded.total_lines,
        indexed_at = unixepoch()
      RETURNING id
    `);

    const result = insert.get(filePath, hash, lastModified, lines) as { id: number };
    expect(result.id).toBeGreaterThan(0);

    // Retrieve by path
    const select = db.query("SELECT * FROM files WHERE path = ?");
    const file = select.get(filePath) as {
      path: string;
      content_hash: string;
      total_lines: number;
    };

    expect(file.path).toBe(filePath);
    expect(file.content_hash).toBe(hash);
    expect(file.total_lines).toBe(lines);
  });

  it("should store chunks associated with file", async () => {
    const content = `# Title\n\n`.repeat(100); // Long content to produce multiple chunks
    const filePath = await createTestFile("multi-chunk.md", content);

    // Create file record
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const hash = hasher.digest("hex");
    const stats = await fs.stat(filePath);
    const lastModified = Math.floor(stats.mtimeMs / 1000);
    const lines = content.split("\n").length;

    const fileInsert = db.query(`
      INSERT INTO files (path, content_hash, last_modified, total_lines)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `);
    const file = fileInsert.get(filePath, hash, lastModified, lines) as { id: number };

    // Chunk and store
    const chunks = chunkText(content, { targetTokens: 100, overlapTokens: 10 });

    const chunkInsert = db.query(`
      INSERT INTO chunks (file_id, start_line, end_line, token_count, content_preview, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const chunk of chunks) {
      chunkInsert.run(
        file.id,
        chunk.startLine,
        chunk.endLine,
        chunk.tokenCount,
        createPreview(chunk.content),
        null,
      );
    }

    // Retrieve chunks
    const chunkSelect = db.query("SELECT * FROM chunks WHERE file_id = ? ORDER BY start_line");
    const storedChunks = chunkSelect.all(file.id) as Array<{
      file_id: number;
      start_line: number;
      end_line: number;
      token_count: number;
    }>;

    expect(storedChunks.length).toBe(chunks.length);

    for (let i = 0; i < storedChunks.length; i++) {
      expect(storedChunks[i].file_id).toBe(file.id);
      expect(storedChunks[i].start_line).toBe(chunks[i].startLine);
      expect(storedChunks[i].end_line).toBe(chunks[i].endLine);
    }
  });

  it("should detect unchanged files by hash and skip reindexing", async () => {
    const content = "Content that won't change";
    const filePath = await createTestFile("unchanged.md", content);

    // First index
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const hash = hasher.digest("hex");

    const stats = await fs.stat(filePath);
    const lastModified = Math.floor(stats.mtimeMs / 1000);
    const lines = content.split("\n").length;

    const insert = db.query(`
      INSERT INTO files (path, content_hash, last_modified, total_lines)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `);
    insert.get(filePath, hash, lastModified, lines) as { id: number };

    // Try to "reindex" - simulate checking hash
    const checkFile = db.query("SELECT content_hash FROM files WHERE path = ?").get(filePath) as {
      content_hash: string;
    };

    // Check if hash matches
    const needsReindex = checkFile.content_hash !== hash;
    expect(needsReindex).toBe(false); // Should NOT need reindex
  });

  it("should force reindex when --force flag is set", async () => {
    // Even if hash matches, force should trigger reindex
    const content = "Force test content";
    const filePath = await createTestFile("force-test.md", content);

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const hash = hasher.digest("hex");

    const stats = await fs.stat(filePath);
    const lastModified = Math.floor(stats.mtimeMs / 1000);
    const lines = content.split("\n").length;

    const insert = db.query(`
      INSERT INTO files (path, content_hash, last_modified, total_lines)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `);
    const file = insert.get(filePath, hash, lastModified, lines) as { id: number };

    // Add some chunks
    const chunkInsert = db.query(`
      INSERT INTO chunks (file_id, start_line, end_line, token_count, content_preview, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    chunkInsert.run(file.id, 1, 1, 10, "old preview", null);

    // Count chunks before force
    const countBefore = db
      .query("SELECT COUNT(*) as count FROM chunks WHERE file_id = ?")
      .get(file.id) as { count: number };
    expect(countBefore.count).toBe(1);

    // Simulate force: delete chunks and reinsert
    db.run("DELETE FROM chunks WHERE file_id = ?", [file.id]);

    // Re-chunk and insert
    const newChunks = chunkText(content);
    for (const chunk of newChunks) {
      chunkInsert.run(
        file.id,
        chunk.startLine,
        chunk.endLine,
        chunk.tokenCount,
        createPreview(chunk.content),
        null,
      );
    }

    const countAfter = db
      .query("SELECT COUNT(*) as count FROM chunks WHERE file_id = ?")
      .get(file.id) as { count: number };
    // After force reindex, we should have the correct number of chunks
    expect(countAfter.count).toBe(newChunks.length);
  });
});

describe("Indexer - Future Features (TDD)", () => {
  let db: Database;
  let testDir: string;

  beforeAll(async () => {
    testDir = await setupTestDataDir();
    db = getTestDb();

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

  it("should generate embeddings via OpenAI API when key is available", async () => {
    const testConfig = await loadTestConfig();

    // Only test with real API key
    const apiKey = testConfig.providers?.[0]?.apiKey;
    if (!apiKey || apiKey === "sk-test-api-key-for-testing") {
      console.log("Skipping - no real API key available");
      return;
    }

    const content = "Text to embed";
    expect(apiKey).toBeDefined();

    // Call OpenAI API directly
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: content,
        model: testConfig.providers[0].embeddingModel,
      }),
    });

    expect(response.ok).toBe(true);

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    expect(data.data[0].embedding).toBeDefined();
    // Dimensions are inferred from model name (1536 for "small" models)
    expect(data.data[0].embedding.length).toBe(1536);
  }, 10000);

  it("should batch embedding requests for efficiency", async () => {
    const testConfig = await loadTestConfig();

    // Only test with real API key
    const apiKey = testConfig.providers?.[0]?.apiKey;
    if (!apiKey || apiKey === "sk-test-api-key-for-testing") {
      console.log("Skipping - no real API key available");
      return;
    }

    // Create content that will produce multiple chunks
    const content = "# Test\n\n".repeat(200);
    const filePath = await createTestFile("batch-embed.md", content);

    // Get file stats
    const stats = await fs.stat(filePath);
    const lastModified = Math.floor(stats.mtimeMs / 1000);
    const lines = content.split("\n").length;

    // Create file record
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const hash = hasher.digest("hex");

    const fileInsert = db.query(`
      INSERT INTO files (path, content_hash, last_modified, total_lines)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `);
    const file = fileInsert.get(filePath, hash, lastModified, lines) as { id: number };

    // Create chunks
    const chunks = chunkText(content, { targetTokens: 100, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(1); // Should have multiple chunks

    const chunkInsert = db.query(`
      INSERT INTO chunks (file_id, start_line, end_line, token_count, content_preview, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const chunkIds: number[] = [];
    for (const chunk of chunks) {
      const result = chunkInsert.get(
        file.id,
        chunk.startLine,
        chunk.endLine,
        chunk.tokenCount,
        createPreview(chunk.content),
        null,
      ) as { id: number };
      chunkIds.push(result.id);
    }

    // Generate embeddings in batches
    const { generateEmbeddingsBatched, embeddingToBuffer } = await import("../src/embeddings");
    const embeddingResult = await generateEmbeddingsBatched(
      chunks.map((c) => c.content),
      testConfig,
    );

    expect(embeddingResult.error).toBeUndefined();
    expect(embeddingResult.results.length).toBe(chunks.length);

    // Store embeddings
    const updateStmt = db.query(`
      UPDATE chunks SET embedding = ? WHERE id = ?
    `);

    for (const result of embeddingResult.results) {
      const embeddingBuffer = embeddingToBuffer(result.embedding);
      updateStmt.run(embeddingBuffer, chunkIds[result.index]);
    }

    // Verify embeddings were stored
    const selectStmt = db.query(
      "SELECT embedding FROM chunks WHERE file_id = ? AND embedding IS NOT NULL",
    );
    const storedEmbeddings = selectStmt.all(file.id) as Array<{ embedding: Buffer }>;

    expect(storedEmbeddings.length).toBe(chunks.length);

    for (const row of storedEmbeddings) {
      expect(row.embedding).toBeDefined();
      // 1536 dimensions * 4 bytes per float
      expect(row.embedding.length).toBe(1536 * 4);
    }
  }, 30000); // 30 second timeout for API calls

  it("should handle API errors gracefully", async () => {
    const { generateEmbeddings } = await import("../src/embeddings");

    // Test with invalid API key using new config structure
    const result = await generateEmbeddings(["test content"], {
      providers: [
        {
          type: "openai",
          apiKey: "sk-invalid-test-key",
          embeddingModel: "text-embedding-3-small",
          rerankModel: "gpt-5-mini",
        },
      ],
    });

    expect(result.error).toBeDefined();
    expect(result.results.length).toBe(0);
  }, 10000);

  it("should support directory recursion with glob patterns", async () => {
    // Create nested directory structure
    const dir1 = path.join(testDir, "nested");
    const dir2 = path.join(dir1, "deep");
    await fs.mkdir(dir2, { recursive: true });

    // Create markdown files at different levels
    await Bun.write(path.join(dir2, "file1.md"), "# Deep content");
    await Bun.write(path.join(dir1, "file2.md"), "# Shallow content");
    await Bun.write(path.join(testDir, "root.md"), "# Root content");

    // Use Bun's Glob to find all markdown files (like in src/index.ts)
    const glob = new Bun.Glob("**/*.md");
    const files: string[] = [];
    for await (const filePath of glob.scan({
      cwd: testDir,
      absolute: true,
    })) {
      files.push(filePath);
    }

    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.some((f) => f.includes("deep"))).toBe(true);
    expect(files.some((f) => f.includes("nested"))).toBe(true);
  });
});
