#!/usr/bin/env bun
import * as path from "path";
import * as os from "os";
import { stat } from "fs/promises";
import { executeSearch } from "./search.js";
import {
  initSchema,
  upsertFile,
  deleteChunksForFile,
  insertChunk,
  getFileByPath,
  getChunksWithIdsByFileId,
  updateChunkEmbedding,
  getAllFiles,
  deleteFile,
  countChunksForFile,
} from "./db.js";
import { chunkText, createPreview, type ChunkerConfig } from "./chunker.js";
import { ensureConfig, validateConfig, runSetup, type MemoryConfig } from "./config.js";
import { generateEmbeddingsBatched, embeddingToBuffer } from "./embeddings.js";

// Expand tilde (~) to home directory
function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  if (filePath === "~") {
    return os.homedir();
  }
  return filePath;
}

// Compute SHA-256 hash of file content
async function computeHash(content: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

// Check if file exists on disk
async function fileExists(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath);
    return await file.exists();
  } catch {
    return false;
  }
}

// Clean up orphaned DB entries for files that no longer exist
async function cleanupOrphanedFiles(): Promise<{
  deleted: Array<{
    file: string;
    chunksRemoved: number;
  }>;
  totalChunksRemoved: number;
}> {
  const allFiles = getAllFiles();
  const deleted: Array<{ file: string; chunksRemoved: number }> = [];
  let totalChunksRemoved = 0;

  for (const dbFile of allFiles) {
    const exists = await fileExists(dbFile.path);
    if (!exists) {
      const chunksBefore = countChunksForFile(dbFile.id);
      deleteFile(dbFile.id);
      deleted.push({
        file: dbFile.path,
        chunksRemoved: chunksBefore,
      });
      totalChunksRemoved += chunksBefore;
    }
  }

  return { deleted, totalChunksRemoved };
}

// Index a single file
async function indexFile(
  filePath: string,
  chunkConfig: ChunkerConfig,
  memConfig: MemoryConfig,
  force: boolean = false,
): Promise<{
  file: string;
  chunkSize: number;
  chunksIndexed: number;
  chunksSkipped: number;
  linesTotal: number;
  status: string;
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
    // Get chunk count for this existing file
    const existingChunks = getChunksWithIdsByFileId(existingFile.id);
    return {
      file: filePath,
      chunkSize: chunkConfig.targetTokens,
      chunksIndexed: 0,
      chunksSkipped: existingChunks.length,
      linesTotal: totalLines,
      status: "success",
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
    }
  }

  return {
    file: filePath,
    chunkSize: chunkConfig.targetTokens,
    chunksIndexed: chunks.length,
    chunksSkipped: 0,
    linesTotal: totalLines,
    status: "success",
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
  indexed: Array<{
    file: string;
    chunkSize: number;
    chunksIndexed: number;
    chunksSkipped: number;
    linesTotal: number;
    status: string;
  }>;
  statistics: {
    totalChunksIndexed: number;
    totalChunksSkipped: number;
  };
}> {
  const mdFiles = await findMarkdownFiles(dirPath);
  const indexed: Array<{
    file: string;
    chunkSize: number;
    chunksIndexed: number;
    chunksSkipped: number;
    linesTotal: number;
    status: string;
  }> = [];
  let totalChunksIndexed = 0;
  let totalChunksSkipped = 0;

  for (const filePath of mdFiles) {
    try {
      const result = await indexFile(filePath, chunkConfig, memConfig, force);
      indexed.push(result);
      totalChunksIndexed += result.chunksIndexed;
      totalChunksSkipped += result.chunksSkipped;
    } catch (error) {
      indexed.push({
        file: filePath,
        chunkSize: chunkConfig.targetTokens,
        chunksIndexed: 0,
        chunksSkipped: 0,
        linesTotal: 0,
        status: "error",
      });
    }
  }

  return {
    indexed,
    statistics: {
      totalChunksIndexed,
      totalChunksSkipped,
    },
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
function parseIndexArgs(args: string[], watchedPaths?: string[]) {
  // Handle case when no path is provided
  if (args.length === 0) {
    // Check if we have watched paths from config
    if (watchedPaths && watchedPaths.length > 0) {
      // Return a special marker to indicate we should use watched paths
      return {
        paths: watchedPaths.map((p) => path.resolve(expandTilde(p))),
        force: false,
        config: {
          targetTokens: 400,
          overlapTokens: 50,
          lineBoundary: true,
        } as ChunkerConfig,
        useWatched: true,
      };
    }
    
    // No path provided and no watched paths - return empty to indicate no indexing
    return {
      paths: [],
      force: false,
      config: {
        targetTokens: 400,
        overlapTokens: 50,
        lineBoundary: true,
      } as ChunkerConfig,
      useWatched: false,
    };
  }

  const pathArg = args[0];

  // Handle help flags
  if (pathArg === "--help" || pathArg === "-h") {
    console.log("Usage: memory index <path> [--force] [--chunk-size <n>] [--overlap <n>]");
    console.log("       memory index                 # Index watched paths from config");
    console.log("");
    console.log("Arguments:");
    console.log("  <path>           File or directory to index (optional if watched paths set)");
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
    console.log("  memory index                               # Index all watched paths");
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
    paths: [path.resolve(expandTilde(pathArg))],
    force,
    config: {
      targetTokens: chunkSize,
      overlapTokens: overlap,
      lineBoundary: true,
    } as ChunkerConfig,
    useWatched: false,
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
  const { paths: targetPaths, force, config: chunkConfig, useWatched } = parseIndexArgs(
    args,
    memConfig.watched,
  );

  // Initialize database
  initSchema();

  const startTime = Date.now();

  // First, clean up orphaned files (run for both single file and directory)
  const { deleted, totalChunksRemoved } = await cleanupOrphanedFiles();

  // Handle case when no paths to index (no watched paths and no arguments)
  if (targetPaths.length === 0 && !useWatched) {
    const durationMs = Date.now() - startTime;
    console.log(JSON.stringify({
      indexed: [],
      deleted,
      statistics: {
        totalChunksIndexed: 0,
        totalChunksSkipped: 0,
        totalChunksRemoved,
        durationMs,
      },
      message: "No paths specified and no watched paths configured. Use 'memory index <path>' or configure watched paths.",
    }));
    return;
  }

  let indexed: Array<{
    file: string;
    chunkSize: number;
    chunksIndexed: number;
    chunksSkipped: number;
    linesTotal: number;
    status: string;
  }> = [];
  let totalChunksIndexed = 0;
  let totalChunksSkipped = 0;

  // Index all target paths (either watched paths or single specified path)
  for (const targetPath of targetPaths) {
    const isDir = await isDirectory(targetPath);

    if (isDir) {
      const dirResult = await indexDirectory(targetPath, chunkConfig, memConfig, force);
      indexed = indexed.concat(dirResult.indexed);
      totalChunksIndexed += dirResult.statistics.totalChunksIndexed;
      totalChunksSkipped += dirResult.statistics.totalChunksSkipped;
    } else {
      // Single file indexing
      try {
        const result = await indexFile(targetPath, chunkConfig, memConfig, force);
        indexed.push(result);
        totalChunksIndexed += result.chunksIndexed;
        totalChunksSkipped += result.chunksSkipped;
      } catch (error) {
        indexed.push({
          file: targetPath,
          chunkSize: chunkConfig.targetTokens,
          chunksIndexed: 0,
          chunksSkipped: 0,
          linesTotal: 0,
          status: "error",
        });
      }
    }
  }

  const durationMs = Date.now() - startTime;

  console.log(JSON.stringify({
    indexed,
    deleted,
    statistics: {
      totalChunksIndexed,
      totalChunksSkipped,
      totalChunksRemoved,
      durationMs,
    },
  }));
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

// Parse search command arguments
function parseSearchArgs(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: memory search <query> [--top-k <n>] [--final <n>] [--no-rerank]");
    console.error("");
    console.error("Arguments:");
    console.error("  <query>          Search query text");
    console.error("  --top-k <n>      Initial retrieval count (default: 20)");
    console.error("  --final <n>      Results after reranking (default: 5)");
    console.error("  --no-rerank      Skip LLM reranking (faster, less precise)");
    process.exit(1);
  }

  // First argument is the query (handle quoted queries)
  let query = args[0];

  // Handle help flags
  if (query === "--help" || query === "-h") {
    console.log("Usage: memory search <query> [options]");
    console.log("");
    console.log("Arguments:");
    console.log("  <query>          Search query text");
    console.log("  --top-k <n>      Initial retrieval count (default: 20)");
    console.log("  --final <n>      Results after reranking (default: 5)");
    console.log("  --no-rerank      Skip LLM reranking (faster, less precise)");
    console.log("");
    console.log("Examples:");
    console.log('  memory search "AC Propulsion tzero range"');
    console.log('  memory search "restic backup" --top-k 30 --final 10');
    console.log('  memory search "systemd timers" --no-rerank');
    process.exit(0);
  }

  let topK = 20;
  let finalK = 5;
  let noRerank = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--top-k" && i + 1 < args.length) {
      topK = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--final" && i + 1 < args.length) {
      finalK = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--no-rerank") {
      noRerank = true;
    }
  }

  return {
    query,
    topK,
    finalK,
    noRerank,
  };
}

// Search command handler
async function searchCommand(args: string[]) {
  const { query, topK, finalK, noRerank } = parseSearchArgs(args);

  // Ensure config is set up before proceeding
  const memConfig = await loadValidatedConfig();

  // Initialize database
  initSchema();

  try {
    const results = await executeSearch(query, memConfig, {
      topK,
      finalK,
      noRerank,
    });

    console.log(JSON.stringify(results));
  } catch (error) {
    console.error(
      JSON.stringify({
        error: true,
        code: "SEARCH_ERROR",
        message: error instanceof Error ? error.message : String(error),
        command: "search",
      }),
    );
    process.exit(4); // API error per MEMORY_SPEC
  }
}

// Get command handler
async function getCommand(args: string[]) {
  const parsed = parseGetArgs(args);
  const { file: filePath, startLine, endLine } = parsed;

  // File exists check
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    console.error(
      JSON.stringify({
        error: true,
        code: "FILE_NOT_FOUND",
        message: `File ${filePath} does not exist`,
        command: "get",
      }),
    );
    process.exit(2);
  }

  try {
    const content = await file.text();
    const lines = content.split("\n");
    const totalLines = lines.length;

    // Validate and clamp line ranges (1-indexed)
    const clampedStart = Math.max(1, Math.min(startLine, totalLines));
    const clampedEnd = Math.max(clampedStart, Math.min(endLine, totalLines));

    // Extract content (convert to 0-indexed)
    const selectedLines = lines.slice(clampedStart - 1, clampedEnd);
    const selectedContent = selectedLines.join("\n");

    // Calculate metadata
    const wordCount = selectedContent.split(/\s+/).filter((w) => w.length > 0).length;
    const charCount = selectedContent.length;

    const result = {
      file: filePath,
      start_line: clampedStart,
      end_line: clampedEnd,
      content: selectedContent,
      word_count: wordCount,
      char_count: charCount,
    };

    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      JSON.stringify({
        error: true,
        code: "READ_ERROR",
        message: error instanceof Error ? error.message : String(error),
        command: "get",
      }),
    );
    process.exit(2);
  }
}

// Parse get command arguments
function parseGetArgs(args: string[]) {
  // Handle help flags first (before length check)
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: memory get <file> <start_line> <end_line>");
    console.log("");
    console.log("Arguments:");
    console.log("  <file>        Path to the markdown file");
    console.log("  <start_line>  Starting line number (1-indexed)");
    console.log("  <end_line>    Ending line number (1-indexed)");
    console.log("");
    console.log("Returns:");
    console.log('  { "file": "...", "start_line": N, "end_line": N, "content": "...", "word_count": N, "char_count": N }');
    console.log("");
    console.log("Examples:");
    console.log("  memory get ./journal/2026-03-07.md 45 52");
    console.log("  memory get tesla.md 678 698");
    process.exit(0);
  }

  if (args.length < 3) {
    console.error("Usage: memory get <file> <start_line> <end_line>");
    console.error("");
    console.error("Arguments:");
    console.error("  <file>        Path to the markdown file");
    console.error("  <start_line>  Starting line number (1-indexed)");
    console.error("  <end_line>    Ending line number (1-indexed)");
    console.error("");
    console.error("Examples:");
    console.error("  memory get ./journal/2026-03-07.md 45 52");
    console.error("  memory get tesla.md 678 698");
    process.exit(1);
  }

  const filePath = path.resolve(args[0]);
  const startLine = parseInt(args[1], 10);
  const endLine = parseInt(args[2], 10);

  if (isNaN(startLine) || isNaN(endLine)) {
    console.error("Error: Line numbers must be valid integers");
    process.exit(1);
  }

  // Note: we don't validate for positive here - let clamping handle out-of-range values
  if (startLine > endLine) {
    console.error("Error: start_line must be less than or equal to end_line");
    process.exit(1);
  }

  return { file: filePath, startLine, endLine };
}

// Show global help
function showHelp() {
  console.log("memory - Markdown indexing and semantic search");
  console.log("");
  console.log("Usage: memory <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  index <path>    Index a file or directory");
  console.log("  index           Index watched paths (if configured via setup)");
  console.log("  search <query>  Semantic search across indexed memories");
  console.log("  get <file> <start> <end>  Get content from line range");
  console.log("  setup           Configure memory settings and watched paths");
  console.log("");
  console.log("Examples:");
  console.log("  memory index lessons.md");
  console.log("  memory index ./notes/ --force");
  console.log("  memory index               # Index watched paths from config");
  console.log('  memory search "restic backup configuration"');
  console.log("  memory get tesla.md 678 698");
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
    case "search":
      await searchCommand(commandArgs);
      break;
    case "get":
      await getCommand(commandArgs);
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
