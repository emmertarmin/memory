import * as path from "path";
import * as os from "os";
import { mkdir } from "fs/promises";
import type { ProviderConfig } from "./providers/index.js";
import { createProvider, generateProviderHelp } from "./providers/index.js";

// XDG Base Directory paths
const XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
const XDG_DATA_HOME = process.env["XDG_DATA_HOME"] || path.join(os.homedir(), ".local", "share");

// Allow override via environment variable for testing
export const CONFIG_DIR = process.env["MEMORY_CONFIG_PATH"]
  ? path.dirname(process.env["MEMORY_CONFIG_PATH"])
  : path.join(XDG_CONFIG_HOME, "memory");
export const CONFIG_PATH =
  process.env["MEMORY_CONFIG_PATH"] || path.join(CONFIG_DIR, "config.json");
export const DATA_DIR = path.join(XDG_DATA_HOME, "memory");

/**
 * Memory configuration with multiple provider support
 * The first provider in the array is used by default
 */
export interface MemoryConfig {
  providers: ProviderConfig[];
  watched?: string[]; // Optional: folders/files to watch for auto-indexing
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

    // Validate that we have a providers array
    if (!parsed.providers || !Array.isArray(parsed.providers) || parsed.providers.length === 0) {
      return null;
    }

    return {
      providers: parsed.providers,
      watched: parsed.watched || [],
    };
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

/**
 * Get the active provider (first provider in the array)
 */
export function getActiveProvider(config: MemoryConfig) {
  if (!config.providers || config.providers.length === 0) {
    return { provider: null, error: "No providers configured" };
  }

  const providerConfig = config.providers[0];
  try {
    const provider = createProvider(providerConfig);
    const validation = provider.validateConfig();

    if (!validation.valid) {
      return {
        provider: null,
        error: `Provider validation failed: ${validation.errors.join(", ")}`,
      };
    }

    return { provider, error: null };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { provider: null, error: `Failed to create provider: ${errorMessage}` };
  }
}

/**
 * Validate the configuration and return detailed error information
 */
export function validateConfig(config: MemoryConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.providers || !Array.isArray(config.providers)) {
    errors.push("providers must be an array");
    return { valid: false, errors };
  }

  if (config.providers.length === 0) {
    errors.push("at least one provider is required");
    return { valid: false, errors };
  }

  // Validate each provider
  for (let i = 0; i < config.providers.length; i++) {
    const providerConfig = config.providers[i];

    if (!providerConfig.type) {
      errors.push(`provider[${i}]: type is required`);
      continue;
    }

    try {
      const provider = createProvider(providerConfig);
      const validation = provider.validateConfig();

      if (!validation.valid) {
        errors.push(`provider[${i}] (${providerConfig.type}): ${validation.errors.join(", ")}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`provider[${i}]: ${errorMessage}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// Generate config error message with provider help
function generateConfigErrorMessage(errors: string[]): string {
  const lines: string[] = [
    "Configuration error:",
    "",
    ...errors.map((e) => `  - ${e}`),
    "",
    "Configuration file location:",
    `  ${CONFIG_PATH}`,
    "",
  ];

  lines.push(generateProviderHelp());

  return lines.join("\n");
}

// Ensure config exists and is valid, show help if not
export async function ensureConfig(): Promise<MemoryConfig> {
  const exists = await configExists();

  if (!exists) {
    console.error(generateConfigErrorMessage(["Configuration file not found"]));
    process.exit(5);
  }

  const config = await loadConfig();
  if (!config) {
    console.error(
      generateConfigErrorMessage(["Configuration file is invalid or missing required fields"]),
    );
    process.exit(5);
  }

  const validation = validateConfig(config);
  if (!validation.valid) {
    console.error(generateConfigErrorMessage(validation.errors));
    process.exit(5);
  }

  return config;
}

/**
 * Generate help text showing provider schemas and example configuration
 */
export function generateConfigHelp(): string {
  const lines: string[] = [
    "Configuration Help",
    "==================",
    "",
    "Configuration file location:",
    `  ${CONFIG_PATH}`,
    "",
    "Environment variable:",
    "  MEMORY_CONFIG_PATH - Override the config file path",
    "",
    generateProviderHelp(),
  ];

  return lines.join("\n");
}
