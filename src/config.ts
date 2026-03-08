import * as path from "path";
import * as os from "os";
import { mkdir } from "fs/promises";
import * as readline from "readline";

// XDG Base Directory paths
const XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
const XDG_DATA_HOME = process.env["XDG_DATA_HOME"] || path.join(os.homedir(), ".local", "share");

// Allow override via environment variable for testing
const CONFIG_DIR = process.env["MEMORY_CONFIG_PATH"]
  ? path.dirname(process.env["MEMORY_CONFIG_PATH"])
  : path.join(XDG_CONFIG_HOME, "memory");
const CONFIG_PATH = process.env["MEMORY_CONFIG_PATH"] || path.join(CONFIG_DIR, "config.json");
const DATA_DIR = path.join(XDG_DATA_HOME, "memory");

export { CONFIG_DIR, CONFIG_PATH, DATA_DIR };

// Simplified config - only user-settable values
// Everything else (provider, timeouts, batch sizes) is hardcoded for OpenAI
export interface MemoryConfig {
  embeddingModel: string; // e.g., "text-embedding-3-small"
  rerankModel: string; // e.g., "gpt-5-mini"
  apiKey: string;
  watched?: string[]; // Optional: folders/files to watch for auto-indexing
}

// Default configuration - minimal, user-configurable only
export const DEFAULT_CONFIG: MemoryConfig = {
  embeddingModel: "text-embedding-3-small",
  rerankModel: "gpt-5-mini",
  apiKey: "",
  watched: [],
};

// Hardcoded OpenAI configuration (not user-configurable)
export const OPENAI_CONFIG = {
  provider: "openai" as const,
  embedding: {
    batchSize: 100,
    getDimensions: (model: string): number => {
      if (model.includes("large")) return 3072;
      if (model.includes("small")) return 1536;
      return 1536; // default
    },
  },
  rerank: {
    timeoutMs: 5000,
    maxConcurrent: 30,
  },
};

// Create readline interface for prompts
function createPrompt(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

// Check if config exists
export async function configExists(): Promise<boolean> {
  try {
    const file = Bun.file(CONFIG_PATH);
    return await file.exists();
  } catch {
    return false;
  }
}

// Load config from file
export async function loadConfig(): Promise<MemoryConfig | null> {
  try {
    const file = Bun.file(CONFIG_PATH);
    if (!(await file.exists())) {
      return null;
    }
    const content = await file.text();
    const parsed = JSON.parse(content);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (error) {
    console.error("Error loading config:", error);
    return null;
  }
}

// Save config to file
export async function saveConfig(config: MemoryConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Validate that config has required fields
export function validateConfig(config: MemoryConfig): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!config.apiKey || config.apiKey.trim() === "") {
    missing.push("OpenAI API key");
  }

  if (!config.embeddingModel || config.embeddingModel.trim() === "") {
    missing.push("Embedding model");
  }

  if (!config.rerankModel || config.rerankModel.trim() === "") {
    missing.push("Rerank model");
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

// Helper: prompt for input
async function promptInput(rl: readline.Interface, message: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      resolve(answer.trim());
    });
  });
}

// Helper: prompt for secret (hidden input when TTY, normal input otherwise)
async function promptSecret(rl: readline.Interface, message: string): Promise<string> {
  // Check if we have a TTY
  if (!process.stdin.isTTY) {
    // Non-interactive mode - read normally
    return promptInput(rl, message);
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    // Pause readline and use raw mode for secret input
    rl.pause();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    stdout.write(message);

    let result = "";

    const onData = (char: string) => {
      const code = char.charCodeAt(0);

      // Enter key
      if (code === 13 || code === 10) {
        stdout.write("\n");
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        rl.resume();
        resolve(result);
        return;
      }

      // Backspace
      if (code === 127 || code === 8) {
        if (result.length > 0) {
          result = result.slice(0, -1);
          stdout.write("\b \b");
        }
        return;
      }

      // Ctrl+C or Ctrl+D
      if (code === 3 || code === 4) {
        stdout.write("\n");
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.exit(0);
      }

      // Printable characters
      if (code >= 32 && code < 127) {
        result += char;
        stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

// Helper: mask an API key for display (first 7, last 4 chars)
function maskApiKey(key: string): string {
  if (!key || key.length < 12) return "********";
  return key.slice(0, 7) + "..." + key.slice(-4);
}

// Helper: prompt for input with a default value
async function promptInputWithDefault(
  rl: readline.Interface,
  message: string,
  defaultValue: string,
): Promise<string> {
  const defaultDisplay = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await promptInput(rl, message + defaultDisplay + ": ");
  return answer || defaultValue;
}

// Helper: prompt for secret with optional existing value
async function promptSecretWithDefault(
  rl: readline.Interface,
  message: string,
  existingKey: string | undefined,
): Promise<string> {
  if (existingKey) {
    const masked = maskApiKey(existingKey);
    const defaultDisplay = ` [${masked} - Enter to keep, or type new]`;
    const answer = await promptSecret(rl, message + defaultDisplay + ": ");
    return answer || existingKey;
  }
  return promptSecret(rl, message + ": ");
}

// Interactive setup flow
export async function runSetup(): Promise<MemoryConfig> {
  const rl = createPrompt();

  try {
    console.log("\n🧠 Memory - Semantic Memory System Setup\n");
    console.log(`Configuration will be saved to: ${CONFIG_PATH}\n`);

    // Load existing config if available
    const existingConfig = await loadConfig();
    const config: MemoryConfig = existingConfig ? { ...existingConfig } : { ...DEFAULT_CONFIG };
    const isReconfiguring = !!existingConfig;

    if (isReconfiguring) {
      console.log("ℹ️  Existing configuration found. Press Enter to keep current values.\n");
    }

    // Model configuration
    console.log("📊 Model Configuration");
    console.log("-----------------------");

    // Embedding model
    const embeddingModel = await promptInputWithDefault(
      rl,
      "Embedding model",
      config.embeddingModel,
    );
    config.embeddingModel = embeddingModel;

    // Rerank model
    const rerankModel = await promptInputWithDefault(rl, "Rerank model", config.rerankModel);
    config.rerankModel = rerankModel;

    // API Key
    console.log("\n🔑 API Configuration");
    console.log("--------------------");
    console.log("OpenAI is used for both embedding and reranking.\n");

    const apiKey = await promptSecretWithDefault(rl, "OpenAI API key", config.apiKey);
    if (!apiKey || apiKey.trim() === "") {
      console.error("❌ API key is required. Setup aborted.");
      process.exit(1);
    }
    config.apiKey = apiKey;

    // Watch configuration (optional)
    console.log("\n📁 Watch Configuration (Optional)");
    console.log("---------------------------------");
    console.log("Specify folders or files to auto-index when running 'memory index' without arguments.");
    console.log("Separate multiple paths with commas. Leave empty to skip.\n");

    const existingWatched = config.watched?.join(", ") || "";
    const watchedInput = await promptInputWithDefault(
      rl,
      "Folders/files to watch",
      existingWatched,
    );
    if (watchedInput.trim()) {
      config.watched = watchedInput.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    } else {
      config.watched = [];
    }

    // Summary
    console.log("\n✅ Configuration Summary");
    console.log("------------------------");
    console.log(`Embedding model: ${config.embeddingModel}`);
    console.log(`Rerank model: ${config.rerankModel}`);
    console.log(`API key: ${maskApiKey(config.apiKey)}`);
    if (config.watched && config.watched.length > 0) {
      console.log(`Watched paths: ${config.watched.join(", ")}`);
    } else {
      console.log("Watched paths: (none)");
    }

    // Save config
    await saveConfig(config);
    console.log(`\n✅ Configuration saved to ${CONFIG_PATH}`);
    console.log("You can now use the memory commands!\n");

    return config;
  } finally {
    rl.close();
  }
}

// Ensure config exists, run setup if needed
export async function ensureConfig(): Promise<MemoryConfig> {
  const exists = await configExists();

  if (!exists) {
    console.log("⚠️  Configuration not found. Starting setup...\n");
    return await runSetup();
  }

  const config = await loadConfig();
  if (!config) {
    console.log("⚠️  Configuration file exists but is invalid. Starting setup...\n");
    return await runSetup();
  }

  const validation = validateConfig(config);
  if (!validation.valid) {
    console.log("⚠️  Configuration is incomplete:");
    for (const missing of validation.missing) {
      console.log(`   - Missing: ${missing}`);
    }
    console.log("\nStarting setup to fix configuration...\n");
    return await runSetup();
  }

  return config;
}
