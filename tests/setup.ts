import { Database } from "bun:sqlite";
import * as path from "path";
import * as os from "os";
import { mkdir, rm, unlink, writeFile } from "fs/promises";

// Use a temporary database for tests
export const TEST_DB_PATH = path.join(os.tmpdir(), "memory-test-" + Date.now() + ".sqlite");
export const TEST_DATA_DIR = path.join(os.tmpdir(), "memory-test-data-" + Date.now());
export const TEST_CONFIG_PATH = path.join(
  os.tmpdir(),
  "memory-test-config-" + Date.now() + ".json",
);

export function getTestDb() {
  const db = new Database(TEST_DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON"); // Enable foreign key constraints
  return db;
}

export async function setupTestDataDir() {
  // Create test config file - simplified structure
  const testConfig = {
    embeddingModel: "text-embedding-3-small",
    rerankModel: "gpt-5-mini",
    apiKey: "sk-test-api-key-for-testing",
  };

  await writeFile(TEST_CONFIG_PATH, JSON.stringify(testConfig, null, 2));
  await mkdir(TEST_DATA_DIR, { recursive: true });
  return TEST_DATA_DIR;
}

export async function cleanupTestDataDir() {
  try {
    await rm(TEST_DATA_DIR, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
  try {
    await unlink(TEST_CONFIG_PATH);
  } catch {
    // Ignore cleanup errors
  }
}

export async function cleanupTestDb() {
  try {
    await unlink(TEST_DB_PATH);
  } catch {
    // Ignore cleanup errors
  }
}

// Create a test markdown file
export async function createTestFile(filename: string, content: string): Promise<string> {
  const filePath = path.join(TEST_DATA_DIR, filename);
  await Bun.write(filePath, content);
  return filePath;
}
