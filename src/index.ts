#!/usr/bin/env bun
import * as path from "path";
import { stat } from "fs/promises";
import {
  initSchema,
  upsertFile,
  deleteChunksForFile,
  insertChunk,
  getFileByPath,
  getChunksWithIdsByFileId,
  updateChunkEmbedding,
} from "./db.js";
import { chunkText, createPreview, type ChunkerConfig } from "./chunker.js";
import { ensureConfig, validateConfig, runSetup, type MemoryConfig } from "./config.js";
import { generateEmbeddingsBatched, embeddingToBuffer } from "./embeddings.js";

// Compute SHA-256 hash of file content
async function computeHash(content: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

// Index a single file
async function indexFile(
  filePath: string,
  chunkConfig: ChunkerConfig,
  memConfig: MemoryConfig,
  force: boolean = false,
): Promise<{
  file: string;
  chunksIndexed: number;
  linesTotal: number;
  status: string;
  skipped?: boolean;
  embeddingsGenerated?: number;
}> {
  // Check file exists
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`FILE_NOT_FOUND: File ${filePath} does not exist`);
  }

  // Read content
  const content = await file.text();
  const lines = content.split("\n");
  const totalLines = lines.length;

  // Compute hash
  const contentHash = await computeHash(content);

  // Check if file needs reindexing
  const existingFile = getFileByPath(filePath);
  if (existingFile && existingFile.content_hash === contentHash && !force) {
    return {
      file: filePath,
      chunksIndexed: 0,
      linesTotal: totalLines,
      status: "skipped",
      skipped: true,
    };
  }

  // Get file stats for last_modified
  const stats = await stat(filePath);
  const lastModified = Math.floor(stats.mtimeMs / 1000);

  // Upsert file record
  const fileId = upsertFile(filePath, contentHash, lastModified, totalLines);

  // Delete existing chunks
  deleteChunksForFile(fileId);

  // Chunk the content
  const chunks = chunkText(content, chunkConfig);

  // Store chunks (without embeddings first)
  for (const chunk of chunks) {
    const preview = createPreview(chunk.content);
    insertChunk(fileId, chunk.startLine, chunk.endLine, chunk.tokenCount, preview, null);
  }

  // Get the stored chunks with their IDs
  const storedChunks = getChunksWithIdsByFileId(fileId);

  if (storedChunks.length !== chunks.length) {
    throw new Error(`MISMATCH: Expected ${chunks.length} chunks, found ${storedChunks.length}`);
  }

  // Generate embeddings for all chunks
  let embeddingsGenerated = 0;
  if (chunks.length > 0) {
    const chunkContents = chunks.map((c) => c.content);
    const embeddingResult = await generateEmbeddingsBatched(
      chunkContents,
      memConfig,
      (completed, total) => {
        // Silent progress - could add verbose mode later
        void completed;
        void total;
      },
    );

    if (embeddingResult.error) {
      throw new Error(`EMBEDDING_ERROR: ${embeddingResult.error}`);
    }

    // Store embeddings
    for (const result of embeddingResult.results) {
      const chunkId = storedChunks[result.index].id;
      const embeddingBuffer = embeddingToBuffer(result.embedding);
      updateChunkEmbedding(chunkId, embeddingBuffer);
      embeddingsGenerated++;
    }
  }

  return {
    file: filePath,
    chunksIndexed: chunks.length,
    linesTotal: totalLines,
    status: "indexed",
    embeddingsGenerated,
  };
}

// Recursively find all .md files in directory
async function findMarkdownFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];

  // Use Bun's native glob for simplicity
  const glob = new Bun.Glob("**/*.md");
  for await (const filePath of glob.scan({
    cwd: dirPath,
    absolute: true,
  })) {
    files.push(filePath);
  }

  return files.sort();
}

// Index a directory recursively
async function indexDirectory(
  dirPath: string,
  chunkConfig: ChunkerConfig,
  memConfig: MemoryConfig,
  force: boolean = false,
): Promise<{
  directory: string;
  filesIndexed: number;
  filesSkipped: number;
  totalChunks: number;
  totalEmbeddings: number;
}> {
  const mdFiles = await findMarkdownFiles(dirPath);

  let filesIndexed = 0;
  let filesSkipped = 0;
  let totalChunks = 0;
  let totalEmbeddings = 0;

  for (const filePath of mdFiles) {
    try {
      const result = await indexFile(filePath, chunkConfig, memConfig, force);
      if (result.skipped) {
        filesSkipped++;
      } else {
        filesIndexed++;
        totalChunks += result.chunksIndexed;
        totalEmbeddings += result.embeddingsGenerated || 0;
      }
      // Output progress for each file
      console.log(JSON.stringify(result));
    } catch (error) {
      console.log(
        JSON.stringify({
          error: true,
          file: filePath,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return {
    directory: dirPath,
    filesIndexed,
    filesSkipped,
    totalChunks,
    totalEmbeddings,
  };
}

// Check if path is directory
async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// Parse index command arguments
function parseIndexArgs(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: memory index <path> [--force] [--chunk-size <n>] [--overlap <n>]");
    console.error("");
    console.error("Arguments:");
    console.error("  <path>           File or directory to index");
    console.error("  --force          Re-index even if file hash unchanged");
    console.error("  --chunk-size <n> Target chunk size in tokens (default: 400)");
    console.error("  --overlap <n>    Overlap between chunks in tokens (default: 50)");
    process.exit(1);
  }

  const pathArg = args[0];

  // Handle help flags
  if (pathArg === "--help" || pathArg === "-h") {
    console.log("Usage: memory index <path> [--force] [--chunk-size <n>] [--overlap <n>]");
    console.log("");
    console.log("Arguments:");
    console.log("  <path>           File or directory to index");
    console.log("  --force          Re-index even if file hash unchanged");
    console.log("  --chunk-size <n> Target chunk size in tokens (default: 400)");
    console.log("  --overlap <n>    Overlap between chunks in tokens (default: 50)");
    console.log("");
    console.log("Examples:");
    console.log("  memory index lessons.md                    # Index single file");
    console.log("  memory index lessons.md --force            # Force re-index");
    console.log(
      "  memory index ./notes/ --chunk-size 300     # Index directory with custom chunk size",
    );
    process.exit(0);
  }

  let force = false;
  let chunkSize = 400;
  let overlap = 50;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--chunk-size" && i + 1 < args.length) {
      chunkSize = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--overlap" && i + 1 < args.length) {
      overlap = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return {
    path: path.resolve(pathArg),
    force,
    config: {
      targetTokens: chunkSize,
      overlapTokens: overlap,
      lineBoundary: true,
    } as ChunkerConfig,
  };
}

// Load config with validation - auto-runs setup if needed
async function loadValidatedConfig(): Promise<MemoryConfig> {
  const config = await ensureConfig();

  const validation = validateConfig(config);
  if (!validation.valid) {
    console.error("❌ Configuration error. Missing:");
    for (const missing of validation.missing) {
      console.error(`   - ${missing}`);
    }
    console.error("\nRun setup to configure: memory setup");
    process.exit(5); // Configuration error exit code per MEMORY_SPEC
  }

  return config;
}

// Index command handler
async function indexCommand(args: string[]) {
  // Ensure config is set up before proceeding
  const memConfig = await loadValidatedConfig();

  // Use config values for chunking if not overridden by CLI
  const { path: targetPath, force, config: chunkConfig } = parseIndexArgs(args);

  // Initialize database
  initSchema();

  const isDir = await isDirectory(targetPath);

  if (isDir) {
    const result = await indexDirectory(targetPath, chunkConfig, memConfig, force);
    console.log(JSON.stringify(result));
  } else {
    const result = await indexFile(targetPath, chunkConfig, memConfig, force);
    console.log(JSON.stringify(result));
  }
}

// Setup command handler
async function setupCommand(_args: string[]) {
  try {
    await runSetup();
  } catch (error) {
    console.error("Setup failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Show global help
function showHelp() {
  console.log("memory - Markdown indexing and semantic search");
  console.log("");
  console.log("Usage: memory <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  index <path>    Index a file or directory");
  console.log("  setup           Configure memory settings");
  console.log("");
  console.log("Examples:");
  console.log("  memory index lessons.md");
  console.log("  memory index ./notes/ --force");
  console.log("  memory setup");
  console.log("");
  console.log("Run 'memory <command> --help' for more information on a command.");
}

// Main entry point - parse subcommands
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    showHelp();
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  switch (command) {
    case "index":
      await indexCommand(commandArgs);
      break;
    case "setup":
      await setupCommand(commandArgs);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("");
      showHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      error: true,
      code: "FATAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
