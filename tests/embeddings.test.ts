import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  generateEmbeddings,
  generateEmbeddingsBatched,
  embeddingToBuffer,
  bufferToEmbedding,
  validateEmbedding,
  cosineSimilarity,
} from "../src/embeddings";
import { setupTestDataDir, cleanupTestDataDir, TEST_CONFIG_PATH } from "./setup";
import * as fs from "fs/promises";

// Load test config to get the API key
async function loadTestConfig() {
  const content = await fs.readFile(TEST_CONFIG_PATH, "utf-8");
  return JSON.parse(content);
}

describe("Embeddings Generation", () => {
  beforeAll(async () => {
    await setupTestDataDir();
  });

  afterAll(async () => {
    await cleanupTestDataDir();
  });

  it("should fail gracefully with invalid API key", async () => {
    const result = await generateEmbeddings(["test text"], {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      api_key: "invalid-key",
      batch_size: 100,
    });

    expect(result.error).toBeDefined();
    expect(result.results.length).toBe(0);
  });

  it("should fail gracefully with empty API key", async () => {
    const result = await generateEmbeddings(["test text"], {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      api_key: "",
      batch_size: 100,
    });

    expect(result.error).toBe("OpenAI API key is not configured");
    expect(result.results.length).toBe(0);
  });

  it("should fail gracefully with empty texts", async () => {
    const config = await loadTestConfig();
    const result = await generateEmbeddings([], config.embedding);

    expect(result.error).toBe("No valid texts to embed");
    expect(result.results.length).toBe(0);
  });

  it("should generate embeddings with real API when key is available", async () => {
    // This test uses the real API key from the environment/config
    // It will be skipped if no valid API key is available
    const config = await loadTestConfig();
    
    // Check if we're using a real API key (not the test key)
    if (!config.embedding.api_key || config.embedding.api_key === "sk-test-api-key-for-testing") {
      console.log("Skipping real API test - using test API key");
      return;
    }

    const result = await generateEmbeddings(["Hello world", "This is a test"], config.embedding);

    expect(result.error).toBeUndefined();
    expect(result.results.length).toBe(2);
    expect(result.results[0].embedding.length).toBe(config.embedding.dimensions || 1536);
    expect(result.results[1].embedding.length).toBe(config.embedding.dimensions || 1536);
  }, 10000); // 10 second timeout for API call

  it("should batch process multiple texts", async () => {
    const config = await loadTestConfig();
    
    // Check if we're using a real API key
    if (!config.embedding.api_key || config.embedding.api_key === "sk-test-api-key-for-testing") {
      console.log("Skipping batch test - using test API key");
      return;
    }

    const texts = Array(10).fill("Test text for batching");
    const result = await generateEmbeddingsBatched(texts, config.embedding);

    expect(result.error).toBeUndefined();
    expect(result.results.length).toBe(10);
  }, 15000); // 15 second timeout
});

describe("Embedding Utilities", () => {
  it("should convert Float32Array to Buffer and back", () => {
    const original = new Float32Array([1.5, 2.5, 3.5, 4.5, 5.5]);
    const buffer = embeddingToBuffer(original);

    expect(buffer.length).toBe(20); // 5 floats * 4 bytes each

    const reconstructed = bufferToEmbedding(buffer);
    expect(reconstructed.length).toBe(5);
    
    for (let i = 0; i < original.length; i++) {
      expect(reconstructed[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("should validate embedding dimensions correctly", () => {
    const embedding = new Float32Array(1536);
    
    const validResult = validateEmbedding(embedding, 1536);
    expect(validResult.valid).toBe(true);

    const invalidResult = validateEmbedding(embedding, 768);
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.error).toContain("Expected 768");
  });

  it("should calculate cosine similarity correctly", () => {
    // Identical vectors should have similarity 1
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);

    // Orthogonal vectors should have similarity 0
    const c = new Float32Array([1, 0, 0]);
    const d = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(c, d)).toBeCloseTo(0, 5);

    // Opposite vectors should have similarity -1
    const e = new Float32Array([1, 0, 0]);
    const f = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(e, f)).toBeCloseTo(-1, 5);
  });

  it("should throw on dimension mismatch in cosine similarity", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2]);

    expect(() => cosineSimilarity(a, b)).toThrow("Dimension mismatch");
  });
});

describe("Embedding Storage Integration", () => {
  it("should store and retrieve embedding from buffer", () => {
    // Create a mock 1536-dimension embedding
    const embedding = new Float32Array(1536);
    for (let i = 0; i < 1536; i++) {
      embedding[i] = Math.random() * 2 - 1;
    }

    const buffer = embeddingToBuffer(embedding);
    expect(buffer.length).toBe(1536 * 4); // 1536 floats * 4 bytes each

    const reconstructed = bufferToEmbedding(buffer);
    expect(reconstructed.length).toBe(1536);

    // Values should be preserved
    for (let i = 0; i < 10; i++) {
      expect(reconstructed[i]).toBeCloseTo(embedding[i], 5);
    }
  });
});
