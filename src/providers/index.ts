import { BaseProvider, type ProviderConfigSchema } from "./base.js";
import { OpenAIProvider, type OpenAIProviderConfig } from "./openai.js";

export * from "./base.js";
export * from "./openai.js";

export type ProviderConfig = OpenAIProviderConfig;

/**
 * Factory function to create a provider instance from configuration
 */
export function createProvider(config: ProviderConfig): BaseProvider {
  switch (config.type) {
    case "openai":
      return new OpenAIProvider(config);
    default:
      throw new Error(`Unknown provider type: ${(config as { type: string }).type}`);
  }
}

/**
 * Get all available provider types and their schemas
 */
export function getAvailableProviderSchemas(): ProviderConfigSchema[] {
  return [
    new OpenAIProvider({
      type: "openai",
      apiKey: "",
      embeddingModel: "",
      rerankModel: "",
    }).getConfigSchema(),
  ];
}

/**
 * Format provider schema for help text display
 */
export function formatProviderSchema(schema: ProviderConfigSchema): string {
  const lines: string[] = [
    `  ${schema.type}`,
    `    ${schema.description}`,
    "",
    "    Required fields:",
  ];

  for (const field of schema.required) {
    lines.push(`      ${field.key} (${field.type}) - ${field.description}`);
  }

  if (schema.optional.length > 0) {
    lines.push("", "    Optional fields:");
    for (const field of schema.optional) {
      const defaultStr = field.default ? ` [default: ${field.default}]` : "";
      lines.push(`      ${field.key} (${field.type}) - ${field.description}${defaultStr}`);
    }
  }

  return lines.join("\n");
}

/**
 * Generate help text for all available providers
 */
export function generateProviderHelp(): string {
  const fullConfigExample = JSON.stringify(
    {
      providers: [
        {
          /* see provider-specific config below */
        },
      ],
      watched: ["./docs", "./notes"],
    },
    null,
    2,
  );

  const openaiExample = JSON.stringify(
    {
      type: "openai",
      apiKey: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      embeddingModel: "text-embedding-3-small",
      rerankModel: "gpt-5-mini",
    },
    null,
    2,
  );

  const lines: string[] = [
    "Full config example:",
    "  " + fullConfigExample.replace(/\n/g, "\n  "),
    "",
    "OpenAI provider example:",
    "  " + openaiExample.replace(/\n/g, "\n  "),
    "",
    "Note: The first provider in the array is used by default.",
  ];

  return lines.join("\n");
}
