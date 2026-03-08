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
import { ensureConfig, validateConfig, generateConfigHelp, type MemoryConfig } from "./config.js";
import { generateEmbeddingsBatched, embeddingToBuffer } from "./embeddings.js";
import { VERSION } from "./version.js";

// Command argument definition
export interface CommandArgument {
  name: string;
  description: string;
  optional?: boolean;
}

// Command example
export interface CommandExample {
  command: string;
  description?: string;
}

// Command definition structure
export interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  arguments: CommandArgument[];
  options?: CommandArgument[];
  examples: CommandExample[];
  returns?: string;
  shorthand?: string;
  handler: (args: string[]) => Promise<void> | void;
}

// Command register - single source of truth for all commands
export class CommandRegister {
  private commands: Map<string, CommandDefinition> = new Map();
  private shorthands: Map<string, string> = new Map();

  register(command: CommandDefinition): void {
    this.commands.set(command.name, command);
    if (command.shorthand) {
      this.shorthands.set(command.shorthand, command.name);
    }
  }

  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name) ?? this.commands.get(this.shorthands.get(name) ?? "");
  }

  getAll(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  has(name: string): boolean {
    return this.commands.has(name) || this.shorthands.has(name);
  }

  // Generate global help text
  generateGlobalHelp(): string {
    const lines: string[] = [
      "memory - Markdown indexing and semantic search",
      "",
      "Usage: memory <command> [options]",
      "",
      "Commands:",
    ];

    // Calculate column width for alignment
    const maxNameLength = Math.max(...this.getAll().map((c) => c.name.length));

    for (const cmd of this.getAll()) {
      const nameWithShorthand = cmd.shorthand ? `${cmd.name}, ${cmd.shorthand}` : cmd.name;
      const paddedName = nameWithShorthand.padEnd(maxNameLength + 4);
      lines.push(`  ${paddedName}  ${cmd.description}`);
    }

    lines.push("");
    lines.push("Examples:");

    // Add a few representative examples
    const indexCmd = this.get("index");
    const searchCmd = this.get("search");
    const getCmd = this.get("get");

    if (indexCmd?.examples[0]) {
      lines.push(`  memory ${indexCmd.examples[0].command}`);
    }
    if (indexCmd?.examples[2]) {
      lines.push(`  memory ${indexCmd.examples[2].command}`);
    }
    if (searchCmd?.examples[0]) {
      lines.push(`  memory ${searchCmd.examples[0].command}`);
    }
    if (getCmd?.examples[1]) {
      lines.push(`  memory ${getCmd.examples[1].command}`);
    }

    lines.push("");
    lines.push("Run 'memory <command> --help' for more information on a command.");
    lines.push("Run 'memory config --help' for configuration information.");

    return lines.join("\n");
  }

  // Generate command-specific help text
  generateCommandHelp(commandName: string): string | null {
    const cmd = this.get(commandName);
    if (!cmd) return null;

    const lines: string[] = [`Usage: memory ${cmd.usage}`, ""];

    if (cmd.arguments.length > 0) {
      lines.push("Arguments:");
      for (const arg of cmd.arguments) {
        const optional = arg.optional ? " (optional)" : "";
        lines.push(`  ${arg.name.padEnd(12)} ${arg.description}${optional}`);
      }
      lines.push("");
    }

    if (cmd.options && cmd.options.length > 0) {
      lines.push("Options:");
      for (const opt of cmd.options) {
        lines.push(`  ${opt.name.padEnd(12)} ${opt.description}`);
      }
      lines.push("");
    }

    if (cmd.returns) {
      lines.push("Returns:");
      lines.push(`  ${cmd.returns}`);
      lines.push("");
    }

    if (cmd.examples.length > 0) {
      lines.push("Examples:");
      for (const ex of cmd.examples) {
        if (ex.description) {
          lines.push(`  memory ${ex.command}  # ${ex.description}`);
        } else {
          lines.push(`  memory ${ex.command}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

// Create singleton instance
export const commandRegister = new CommandRegister();

// Helper functions (moved from index.ts)
function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  if (filePath === "~") {
    return os.homedir();
  }
  return filePath;
}

async function computeHash(content: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath);
    return await file.exists();
  } catch {
    return false;
  }
}

async function cleanupOrphanedFiles(): Promise<{
  deleted: Array<{ file: string; chunksRemoved: number }>;
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
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`FILE_NOT_FOUND: File ${filePath} does not exist`);
  }

  const content = await file.text();
  const lines = content.split("\n");
  const totalLines = lines.length;
  const contentHash = await computeHash(content);

  const existingFile = getFileByPath(filePath);
  if (existingFile && existingFile.content_hash === contentHash && !force) {
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

  const stats = await stat(filePath);
  const lastModified = Math.floor(stats.mtimeMs / 1000);
  const fileId = upsertFile(filePath, contentHash, lastModified, totalLines);

  deleteChunksForFile(fileId);
  const chunks = chunkText(content, chunkConfig);

  for (const chunk of chunks) {
    const preview = createPreview(chunk.content);
    insertChunk(fileId, chunk.startLine, chunk.endLine, chunk.tokenCount, preview, null);
  }

  const storedChunks = getChunksWithIdsByFileId(fileId);

  if (storedChunks.length !== chunks.length) {
    throw new Error(`MISMATCH: Expected ${chunks.length} chunks, found ${storedChunks.length}`);
  }

  if (chunks.length > 0) {
    const chunkContents = chunks.map((c) => c.content);
    const embeddingResult = await generateEmbeddingsBatched(chunkContents, memConfig, () => {});

    if (embeddingResult.error) {
      throw new Error(`EMBEDDING_ERROR: ${embeddingResult.error}`);
    }

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

async function findMarkdownFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  const glob = new Bun.Glob("**/*.md");
  for await (const filePath of glob.scan({ cwd: dirPath, absolute: true })) {
    files.push(filePath);
  }
  return files.sort();
}

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

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function loadValidatedConfig(): Promise<MemoryConfig> {
  const config = await ensureConfig();
  const validation = validateConfig(config);
  if (!validation.valid) {
    console.error("Configuration error. Missing:");
    for (const missing of validation.errors) {
      console.error(`   - ${missing}`);
    }
    console.error("\nRun 'memory config --help' to see configuration help.");
    process.exit(5);
  }
  return config;
}

interface EnsureFreshIndexResult {
  updated: boolean;
  errors: string[];
  indexed: number;
  skipped: number;
}

// Silently ensures watched paths are fresh, without stdout output
// Returns result object and logs errors only to stderr
async function ensureFreshIndex(
  memConfig: MemoryConfig,
  silent: boolean = true,
): Promise<EnsureFreshIndexResult> {
  if (!memConfig.watched || memConfig.watched.length === 0) {
    return { updated: false, errors: [], indexed: 0, skipped: 0 };
  }

  const defaultChunkConfig: ChunkerConfig = {
    targetTokens: 400,
    overlapTokens: 50,
    lineBoundary: true,
  };

  const result: EnsureFreshIndexResult = {
    updated: false,
    errors: [],
    indexed: 0,
    skipped: 0,
  };

  const targetPaths = memConfig.watched.map((p) => path.resolve(expandTilde(p)));

  // Clean up orphaned files
  try {
    await cleanupOrphanedFiles();
  } catch (error) {
    const msg = `Failed to cleanup orphaned files: ${error instanceof Error ? error.message : String(error)}`;
    if (silent) {
      console.error(msg);
    }
  }

  for (const targetPath of targetPaths) {
    const isDir = await isDirectory(targetPath);
    if (isDir) {
      try {
        const dirResult = await indexDirectory(targetPath, defaultChunkConfig, memConfig, false);
        for (const item of dirResult.indexed) {
          if (item.status === "error") {
            result.errors.push(`Failed to index ${item.file}`);
          } else if (item.chunksIndexed > 0) {
            result.updated = true;
            result.indexed += item.chunksIndexed;
          } else {
            result.skipped += item.chunksSkipped;
          }
        }
      } catch (error) {
        const msg = `Failed to index directory ${targetPath}: ${error instanceof Error ? error.message : String(error)}`;
        if (silent) {
          console.error(msg);
        }
        result.errors.push(msg);
      }
    } else {
      try {
        const fileResult = await indexFile(targetPath, defaultChunkConfig, memConfig, false);
        if (fileResult.status === "error") {
          result.errors.push(`Failed to index ${fileResult.file}`);
        } else if (fileResult.chunksIndexed > 0) {
          result.updated = true;
          result.indexed += fileResult.chunksIndexed;
        } else {
          result.skipped += fileResult.chunksSkipped;
        }
      } catch (error) {
        const msg = `Failed to index file ${targetPath}: ${error instanceof Error ? error.message : String(error)}`;
        if (silent) {
          console.error(msg);
        }
        result.errors.push(msg);
      }
    }
  }

  return result;
}

// Command handlers

function parseIndexArgs(args: string[], watchedPaths?: string[]) {
  if (args.length === 0) {
    if (watchedPaths && watchedPaths.length > 0) {
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

async function indexCommand(args: string[]) {
  const memConfig = await loadValidatedConfig();
  const {
    paths: targetPaths,
    force,
    config: chunkConfig,
    useWatched,
  } = parseIndexArgs(args, memConfig.watched);

  initSchema();
  const startTime = Date.now();
  const { deleted, totalChunksRemoved } = await cleanupOrphanedFiles();

  if (targetPaths.length === 0 && !useWatched) {
    const durationMs = Date.now() - startTime;
    console.log(
      JSON.stringify({
        indexed: [],
        deleted,
        statistics: {
          totalChunksIndexed: 0,
          totalChunksSkipped: 0,
          totalChunksRemoved,
          durationMs,
        },
        message:
          "No paths specified and no watched paths configured. Use 'memory index <path>' or configure watched paths.",
      }),
    );
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

  for (const targetPath of targetPaths) {
    const isDir = await isDirectory(targetPath);
    if (isDir) {
      const dirResult = await indexDirectory(targetPath, chunkConfig, memConfig, force);
      indexed = indexed.concat(dirResult.indexed);
      totalChunksIndexed += dirResult.statistics.totalChunksIndexed;
      totalChunksSkipped += dirResult.statistics.totalChunksSkipped;
    } else {
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
  console.log(
    JSON.stringify({
      indexed,
      deleted,
      statistics: {
        totalChunksIndexed,
        totalChunksSkipped,
        totalChunksRemoved,
        durationMs,
      },
    }),
  );
}

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

  let query = args[0];
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

  return { query, topK, finalK, noRerank };
}

async function searchCommand(args: string[]) {
  const { query, topK, finalK, noRerank } = parseSearchArgs(args);
  const memConfig = await loadValidatedConfig();
  initSchema();

  // Ensure index is fresh before searching
  const indexResult = await ensureFreshIndex(memConfig, true);
  if (indexResult.updated) {
    console.error(`Indexed ${indexResult.indexed} new chunks before searching...`);
  }

  try {
    const results = await executeSearch(query, memConfig, { topK, finalK, noRerank });
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
    process.exit(4);
  }
}

function parseGetArgs(args: string[]) {
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

  if (startLine > endLine) {
    console.error("Error: start_line must be less than or equal to end_line");
    process.exit(1);
  }

  return { file: filePath, startLine, endLine };
}

export function versionCommand(_args: string[]) {
  console.log(VERSION);
}

async function getCommand(args: string[]) {
  const { file: filePath, startLine, endLine } = parseGetArgs(args);

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
    const clampedStart = Math.max(1, Math.min(startLine, totalLines));
    const clampedEnd = Math.max(clampedStart, Math.min(endLine, totalLines));
    const selectedLines = lines.slice(clampedStart - 1, clampedEnd);
    const selectedContent = selectedLines.join("\n");
    const wordCount = selectedContent.split(/\s+/).filter((w) => w.length > 0).length;
    const charCount = selectedContent.length;

    console.log(
      JSON.stringify({
        file: filePath,
        start_line: clampedStart,
        end_line: clampedEnd,
        content: selectedContent,
        word_count: wordCount,
        char_count: charCount,
      }),
    );
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

function configCommand(_args: string[]) {
  console.log(generateConfigHelp());
}

// Register all commands
export function registerAllCommands(): void {
  commandRegister.register({
    name: "index",
    description: "Index a file or directory (or watched paths if no path specified)",
    usage: "index <path> [--force] [--chunk-size <n>] [--overlap <n>]",
    arguments: [{ name: "<path>", description: "File or directory to index", optional: true }],
    options: [
      { name: "--force", description: "Re-index even if file hash unchanged" },
      { name: "--chunk-size <n>", description: "Target chunk size in tokens (default: 400)" },
      { name: "--overlap <n>", description: "Overlap between chunks in tokens (default: 50)" },
    ],
    examples: [
      { command: "index file.md", description: "Index single file" },
      { command: "index file.md --force", description: "Force re-index" },
      {
        command: "index ./notes/ --chunk-size 300",
        description: "Index directory with custom chunk size",
      },
      { command: "index", description: "Index all watched paths from config" },
    ],
    handler: indexCommand,
  });

  commandRegister.register({
    name: "search",
    description: "Semantic search across indexed memories",
    usage: "search <query> [options]",
    arguments: [{ name: "<query>", description: "Search query text" }],
    options: [
      { name: "--top-k <n>", description: "Initial retrieval count (default: 20)" },
      { name: "--final <n>", description: "Results after reranking (default: 5)" },
      { name: "--no-rerank", description: "Skip LLM reranking (faster, less precise)" },
    ],
    examples: [
      { command: 'search "summer vacation"' },
      { command: 'search "birthday gift" --top-k 30 --final 10' },
      { command: 'search "favourite ice cream" --no-rerank' },
    ],
    handler: searchCommand,
  });

  commandRegister.register({
    name: "get",
    description: "Get content from a file by line range",
    usage: "get <file> <start_line> <end_line>",
    arguments: [
      { name: "<file>", description: "Path to the markdown file" },
      { name: "<start_line>", description: "Starting line number (1-indexed)" },
      { name: "<end_line>", description: "Ending line number (1-indexed)" },
    ],
    returns:
      '{ "file": "...", "start_line": N, "end_line": N, "content": "...", "word_count": N, "char_count": N }',
    examples: [
      { command: "get ./journal/2026-03-07.md 45 52" },
      { command: "get tesla.md 678 698" },
    ],
    handler: getCommand,
  });

  commandRegister.register({
    name: "config",
    description: "Show configuration help and provider schemas",
    usage: "config",
    arguments: [],
    examples: [{ command: "config", description: "Display configuration help" }],
    handler: configCommand,
  });

  commandRegister.register({
    name: "version",
    description: "Show the version number",
    usage: "version",
    arguments: [],
    shorthand: "-v",
    examples: [
      { command: "version", description: "Show version number" },
      { command: "-v", description: "Show version number (shorthand)" },
    ],
    handler: versionCommand,
  });
}
