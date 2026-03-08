import {
  BaseProvider,
  type BatchEmbeddingResult,
  type RerankRequest,
  type RerankResult,
  type ProviderConfigSchema,
} from "./base.js";

export interface OpenAIProviderConfig {
  type: "openai";
  name?: string;
  apiKey: string;
  embeddingModel: string;
  rerankModel: string;
  baseUrl?: string;
  embeddingBatchSize?: number;
  rerankTimeoutMs?: number;
  rerankMaxConcurrent?: number;
}

export class OpenAIProvider extends BaseProvider {
  private config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    super(config.name || "openai", "openai");
    this.config = {
      baseUrl: "https://api.openai.com/v1",
      embeddingBatchSize: 100,
      rerankTimeoutMs: 5000,
      rerankMaxConcurrent: 30,
      ...config,
    };
  }

  getEmbeddingDimensions(): number {
    const model = this.config.embeddingModel;
    if (model.includes("large")) return 3072;
    if (model.includes("small")) return 1536;
    return 1536; // default
  }

  async generateEmbeddings(texts: string[]): Promise<BatchEmbeddingResult> {
    if (!this.config.apiKey || this.config.apiKey.trim() === "") {
      return {
        results: [],
        error: "OpenAI API key is not configured",
      };
    }

    const validTexts = texts.map((t) => t.trim()).filter((t) => t.length > 0);

    if (validTexts.length === 0) {
      return {
        results: [],
        error: "No valid texts to embed",
      };
    }

    try {
      const response = await fetch(`${this.config.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: validTexts,
          model: this.config.embeddingModel,
          dimensions: this.getEmbeddingDimensions(),
          encoding_format: "float",
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        const errorMessage =
          errorData.error?.message || `API request failed with status ${response.status}`;
        return {
          results: [],
          error: errorMessage,
        };
      }

      const data = (await response.json()) as {
        data: Array<{
          embedding: number[];
          index: number;
          object: string;
        }>;
        model: string;
        usage: {
          prompt_tokens: number;
          total_tokens: number;
        };
      };

      const results = data.data.map((item) => ({
        index: item.index,
        embedding: new Float32Array(item.embedding),
        dimensions: item.embedding.length,
      }));

      results.sort((a, b) => a.index - b.index);

      return { results };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        results: [],
        error: `Failed to generate embeddings: ${errorMessage}`,
      };
    }
  }

  async rerank(request: RerankRequest): Promise<RerankResult> {
    if (!this.config.apiKey || this.config.apiKey.trim() === "") {
      return { score: 50, error: "OpenAI API key is not configured" };
    }

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.rerankModel,
          messages: [
            {
              role: "system",
              content:
                "You are a relevance scorer. Rate how well the document answers the query. Respond with ONLY a number from 0-100.",
            },
            {
              role: "user",
              content: `Query: "${request.query}"\n\nDocument: "${request.content.slice(0, 1000)}"\n\nRate relevance (0-100):`,
            },
          ],
          temperature: 0,
          max_tokens: 10,
        }),
      });

      if (!response.ok) {
        return { score: 50, error: `Reranking API error: ${response.status}` };
      }

      const data = (await response.json()) as {
        choices: Array<{
          message: {
            content: string;
          };
        }>;
      };

      const content = data.choices[0]?.message?.content?.trim() || "50";
      const match = content.match(/(\d+)/);
      if (match) {
        const score = parseInt(match[1], 10);
        return { score: Math.max(0, Math.min(100, score)) };
      }

      return { score: 50 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { score: 50, error: `Reranking error: ${errorMessage}` };
    }
  }

  validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.config.apiKey || this.config.apiKey.trim() === "") {
      errors.push("apiKey is required");
    }

    if (!this.config.embeddingModel || this.config.embeddingModel.trim() === "") {
      errors.push("embeddingModel is required");
    }

    if (!this.config.rerankModel || this.config.rerankModel.trim() === "") {
      errors.push("rerankModel is required");
    }

    return { valid: errors.length === 0, errors };
  }

  getConfigSchema(): ProviderConfigSchema {
    return {
      type: "openai",
      description: "OpenAI API for embeddings and reranking",
      required: [
        {
          key: "type",
          type: "string",
          description: "Must be 'openai'",
        },
        {
          key: "apiKey",
          type: "string",
          description: "Your OpenAI API key (starts with sk-)",
        },
        {
          key: "embeddingModel",
          type: "string",
          description:
            "Model for embeddings (e.g., 'text-embedding-3-small', 'text-embedding-3-large')",
        },
        {
          key: "rerankModel",
          type: "string",
          description: "Model for reranking (e.g., 'gpt-5-mini', 'gpt-4o-mini')",
        },
      ],
      optional: [
        {
          key: "name",
          type: "string",
          description: "Friendly name for this provider configuration",
        },
        {
          key: "baseUrl",
          type: "string",
          description: "Custom API base URL (for proxies or compatible APIs)",
          default: "https://api.openai.com/v1",
        },
        {
          key: "embeddingBatchSize",
          type: "number",
          description: "Number of texts to embed per API call",
          default: "100",
        },
        {
          key: "rerankTimeoutMs",
          type: "number",
          description: "Timeout for reranking requests",
          default: "5000",
        },
        {
          key: "rerankMaxConcurrent",
          type: "number",
          description: "Max concurrent reranking requests",
          default: "30",
        },
      ],
    };
  }
}
