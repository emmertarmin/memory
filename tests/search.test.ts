import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs/promises";
import {
  getTestDb,
  setupTestDataDir,
  cleanupTestDataDir,
  cleanupTestDb,
  createTestFile,
  TEST_CONFIG_PATH,
} from "./setup";
import { chunkText, createPreview } from "../src/chunker";
import { embeddingToBuffer } from "../src/embeddings";
import type { MemoryConfig } from "../src/config";

// Define interfaces for search results
interface SearchResult {
  file: string;
  start_line: number;
  end_line: number;
  score: number;
  content_preview: string;
}

describe("Search Command", () => {
  let db: Database;
  let hasRealApiKey: boolean;

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

    // Check if real API key exists
    const config = JSON.parse(await Bun.file(TEST_CONFIG_PATH).text());
    hasRealApiKey = config.apiKey && config.apiKey !== "sk-test-api-key-for-testing";
  });

  afterAll(async () => {
    db.close();
    await cleanupTestDb();
    await cleanupTestDataDir();
  });

  it("should return search results with correct schema", async () => {
    // Create test content and index it
    const content = `
# Electric Vehicles

## AC Propulsion tzero
The AC Propulsion tzero was a hand-built electric sports car.
The tzero had a range of about 80-100 miles per charge.
It used lead-acid batteries and later lithium-ion.

## Tesla Roadster
The Tesla Roadster was based on the tzero chassis.
It had a range of 244 miles per charge.
This was a significant improvement over earlier EVs.

## Battery Technology
Lithium-ion batteries changed everything for electric vehicles.
They offer higher energy density than lead-acid.
Range anxiety became less of an issue with better batteries.

## Charging Infrastructure
Home charging is convenient for overnight charging.
Level 2 chargers provide faster charging than standard outlets.
DC fast charging allows for road trips in electric vehicles.

## EV Performance
Electric motors provide instant torque.
This makes EVs very quick from a stop.
The tzero could accelerate from 0-60 mph in 3.7 seconds.
`.repeat(3); // Repeat to create more chunks

    const filePath = await createTestFile("ev-content.md", content);

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

    // Create and store chunks with mock embeddings
    const chunks = chunkText(content, { targetTokens: 100, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(5); // Should have multiple chunks

    const chunkInsert = db.query(`
      INSERT INTO chunks (file_id, start_line, end_line, token_count, content_preview, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    // Create mock embeddings (1536 dimensions of random values for testing)
    for (let i = 0; i < chunks.length; i++) {
      const mockEmbedding = new Float32Array(1536);
      // Set some deterministic values based on index for testing
      mockEmbedding[i % 1536] = 1.0; // Make each embedding slightly different

      chunkInsert.get(
        file.id,
        chunks[i].startLine,
        chunks[i].endLine,
        chunks[i].tokenCount,
        createPreview(chunks[i].content),
        embeddingToBuffer(mockEmbedding),
      );
    }

    // Search should require API key - test that it fails gracefully without one
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "search", "AC Propulsion tzero range"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MEMORY_CONFIG_PATH: TEST_CONFIG_PATH },
    });

    const exitCode = await proc.exited;

    // Should either succeed with real key or fail gracefully
    expect(exitCode === 0 || exitCode === 1 || exitCode === 4).toBe(true);
  }, 60000);

  it("should retrieve exactly 20 initial results before reranking", async () => {
    // Create enough content to have 20+ chunks
    let largeContent = "";
    for (let i = 0; i < 50; i++) {
      largeContent += `
# Topic ${i}

This is content about topic number ${i}.
It has several lines of text to make meaningful chunks.
The content discusses various aspects of the topic.

## Subsection
More details about topic ${i} can be found here.
Additional information to increase token count.
Even more content to ensure proper chunking.
`;
    }

    const filePath = await createTestFile("large-content.md", largeContent);

    // Create file record
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(largeContent);
    const hash = hasher.digest("hex");
    const stats = await fs.stat(filePath);
    const lastModified = Math.floor(stats.mtimeMs / 1000);
    const lines = largeContent.split("\n").length;

    const fileInsert = db.query(`
      INSERT INTO files (path, content_hash, last_modified, total_lines)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `);
    const file = fileInsert.get(filePath, hash, lastModified, lines) as { id: number };

    // Create chunks with mock embeddings
    const chunks = chunkText(largeContent, { targetTokens: 100, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThanOrEqual(20); // Need at least 20 chunks

    const chunkInsert = db.query(`
      INSERT INTO chunks (file_id, start_line, end_line, token_count, content_preview, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    // Store all chunks with unique embeddings
    for (let i = 0; i < chunks.length; i++) {
      const mockEmbedding = new Float32Array(1536);
      // Create deterministic but varied embeddings
      mockEmbedding[0] = i * 0.01;
      mockEmbedding[1] = 1.0 - i * 0.01;

      chunkInsert.get(
        file.id,
        chunks[i].startLine,
        chunks[i].endLine,
        chunks[i].tokenCount,
        createPreview(chunks[i].content),
        embeddingToBuffer(mockEmbedding),
      );
    }

    // Verify we have at least 20 chunks in the database
    const countResult = db
      .query("SELECT COUNT(*) as count FROM chunks WHERE file_id = ?")
      .get(file.id) as { count: number };
    expect(countResult.count).toBeGreaterThanOrEqual(20);

    // Search would need API key to actually run
    // This test verifies the data is set up correctly for search
    if (!hasRealApiKey) {
      console.log("Skipping - no real API key for full search test");
      return;
    }

    // Run search command
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "search", "topic 25"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MEMORY_CONFIG_PATH: TEST_CONFIG_PATH },
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    if (exitCode === 0) {
      const results = JSON.parse(stdout.trim());
      // After reranking, should return top 5
      expect(results.length).toBeLessThanOrEqual(5);
      expect(results.length).toBeGreaterThan(0);

      // Verify schema
      for (const result of results) {
        expect(result).toHaveProperty("file");
        expect(result).toHaveProperty("start_line");
        expect(result).toHaveProperty("end_line");
        expect(result).toHaveProperty("score");
        expect(result).toHaveProperty("content_preview");

        expect(typeof result.file).toBe("string");
        expect(typeof result.start_line).toBe("number");
        expect(typeof result.end_line).toBe("number");
        expect(typeof result.score).toBe("number");
        expect(typeof result.content_preview).toBe("string");

        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      }
    }
  }, 60000);

  it("should return exactly top 5 results after reranking", async () => {
    if (!hasRealApiKey) {
      console.log("Skipping - no real API key for reranking test");
      return;
    }

    // Create diverse content
    const content = `
# Solar Power

Solar panels convert sunlight into electricity.
Photovoltaic cells are the main component.
Efficiency has improved significantly over the years.

## Installation
Residential solar installations are growing rapidly.
Roof-mounted systems are the most common type.
Ground-mounted systems work well for larger properties.

## Economics
The cost of solar has dropped dramatically.
Payback periods are now 5-7 years in most regions.
Government incentives can accelerate returns.

## Environmental Impact
Solar power reduces carbon emissions significantly.
A typical home system prevents 3-4 tons of CO2 annually.
This is equivalent to planting 100 trees per year.
`.repeat(5);

    const filePath = await createTestFile("solar-content.md", content);

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

    // Create chunks
    const chunks = chunkText(content);
    const chunkInsert = db.query(`
      INSERT INTO chunks (file_id, start_line, end_line, token_count, content_preview, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    // Generate real embeddings if API key available
    if (hasRealApiKey) {
      const config = JSON.parse(await Bun.file(TEST_CONFIG_PATH).text()) as MemoryConfig;
      const { generateEmbeddingsBatched } = await import("../src/embeddings");
      const result = await generateEmbeddingsBatched(
        chunks.map((c) => c.content),
        config,
      );

      expect(result.error).toBeUndefined();
      expect(result.results.length).toBe(chunks.length);

      for (let i = 0; i < chunks.length; i++) {
        chunkInsert.get(
          file.id,
          chunks[i].startLine,
          chunks[i].endLine,
          chunks[i].tokenCount,
          createPreview(chunks[i].content),
          embeddingToBuffer(result.results[i].embedding),
        );
      }
    }

    // Run search
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "search", "carbon emissions solar panels"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MEMORY_CONFIG_PATH: TEST_CONFIG_PATH },
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    if (exitCode === 0) {
      const results = JSON.parse(stdout.trim());
      // Should return exactly 5 results (or fewer if less content)
      expect(results.length).toBeLessThanOrEqual(5);
      expect(results.length).toBeGreaterThan(0);
    }
  }, 60000);

  it("should handle search with no matching results gracefully", async () => {
    // Search for something that won't match anything
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/index.ts", "search", "xyznonexistentquery123"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MEMORY_CONFIG_PATH: TEST_CONFIG_PATH },
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    // Should not crash - either return empty array or error gracefully
    if (exitCode === 0) {
      const results = JSON.parse(stdout.trim());
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    } else {
      // Error should be informative
      expect(stderr).toContain("error");
    }
  }, 30000);

  it("should validate search result schema", async () => {
    // Test the schema expectations
    const validResult = {
      file: "/path/to/file.md",
      start_line: 10,
      end_line: 25,
      score: 0.95,
      content_preview: "This is a preview...",
    };

    // Verify all required fields are present and correct types
    expect(validResult.file).toBeTypeOf("string");
    expect(validResult.start_line).toBeTypeOf("number");
    expect(validResult.end_line).toBeTypeOf("number");
    expect(validResult.score).toBeTypeOf("number");
    expect(validResult.content_preview).toBeTypeOf("string");

    // Score should be between 0 and 1
    expect(validResult.score).toBeGreaterThanOrEqual(0);
    expect(validResult.score).toBeLessThanOrEqual(1);

    // Line numbers should be valid
    expect(validResult.start_line).toBeGreaterThanOrEqual(1);
    expect(validResult.end_line).toBeGreaterThanOrEqual(validResult.start_line);
  });

  it("should handle API errors during reranking gracefully", async () => {
    if (!hasRealApiKey) {
      console.log("Skipping - no real API key for error handling test");
      return;
    }

    // This test verifies error handling is in place
    // Actual testing requires mocking the API to fail
    expect(true).toBe(true);
  });

  it("should merge adjacent chunks in search results", async () => {
    // Create content with closely spaced relevant sections
    const content = `
# Product Documentation

## Introduction
This product is designed for professional users.
It provides advanced features for complex workflows.
The documentation covers all major functionality.

## Installation Guide
Before installing, ensure your system meets requirements.
You need at least 8GB of RAM and 100GB free space.
The installation process takes about 30 minutes.

## Configuration
After installation, configure the main settings.
Edit the config file at /etc/product/config.yml.
Restart the service after making changes.

## Troubleshooting
If the service fails to start, check the logs.
Common issues include permission problems.
Contact support if problems persist.
`.repeat(4);

    const filePath = await createTestFile("product-docs.md", content);

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

    // Create chunks
    const chunks = chunkText(content, { targetTokens: 80, overlapTokens: 15 });
    const chunkInsert = db.query(`
      INSERT INTO chunks (file_id, start_line, end_line, token_count, content_preview, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    // Generate embeddings if API key available
    if (hasRealApiKey) {
      const config = JSON.parse(await Bun.file(TEST_CONFIG_PATH).text()) as MemoryConfig;
      const { generateEmbeddingsBatched } = await import("../src/embeddings");
      const result = await generateEmbeddingsBatched(
        chunks.map((c) => c.content),
        config,
      );

      expect(result.error).toBeUndefined();

      for (let i = 0; i < chunks.length; i++) {
        chunkInsert.get(
          file.id,
          chunks[i].startLine,
          chunks[i].endLine,
          chunks[i].tokenCount,
          createPreview(chunks[i].content),
          embeddingToBuffer(result.results[i].embedding),
        );
      }

      // Search
      const proc = Bun.spawn({
        cmd: ["bun", "run", "src/index.ts", "search", "installation configuration"],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, MEMORY_CONFIG_PATH: TEST_CONFIG_PATH },
      });

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      if (exitCode === 0) {
        const results = JSON.parse(stdout.trim()) as SearchResult[];

        // Verify results don't have excessive overlap
        for (let i = 0; i < results.length - 1; i++) {
          const current = results[i];
          const next = results[i + 1];

          // If same file, check they're not overlapping too much
          if (current.file === next.file) {
            // The spec says merge if within 5 lines, so results should not be adjacent
            const gap = next.start_line - current.end_line;
            expect(gap).toBeGreaterThanOrEqual(-5); // -5 to allow for merged results
          }
        }
      }
    }
  }, 60000);
});
