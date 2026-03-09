import {
  BaseProvider,
  type BatchEmbeddingResult,
  type RerankRequest,
  type RerankResult,
  type ProviderConfigSchema,
} from "./base.js";

export interface OllamaProviderConfig {
  type: "ollama";
  name?: string;
  url?: string;
  embeddingModel: string;
  rerankModel: string;
  embeddingBatchSize?: number;
  rerankTimeoutMs?: number;
  rerankMaxConcurrent?: number;
}

export class OllamaProvider extends BaseProvider {
  private config: OllamaProviderConfig;

  constructor(config: OllamaProviderConfig) {
    super(config.name || "ollama", "ollama");
    this.config = {
      url: "http://localhost:11434",
      embeddingBatchSize: 100,
      rerankTimeoutMs: 5000,
      rerankMaxConcurrent: 30,
      ...config,
    };
  }

  getEmbeddingDimensions(): number {
    // qwen3-embedding:8b has 1024 dimensions
    // Default to 1024 for qwen models, 768 for others
    const model = this.config.embeddingModel;
    if (model.includes("qwen")) return 1024;
    return 768;
  }

  async generateEmbeddings(texts: string[]): Promise<BatchEmbeddingResult> {
    const validTexts = texts.map((t) => t.trim()).filter((t) => t.length > 0);

    if (validTexts.length === 0) {
      return {
        results: [],
        error: "No valid texts to embed",
      };
    }

    try {
      // Ollama's /api/embed accepts an array of inputs
      const response = await fetch(`${this.config.url}/api/embed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.embeddingModel,
          input: validTexts,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          results: [],
          error: `Ollama API request failed with status ${response.status}: ${errorText}`,
        };
      }

      const data = (await response.json()) as {
        embeddings: number[][];
        model: string;
      };

      if (!data.embeddings || !Array.isArray(data.embeddings)) {
        return {
          results: [],
          error: "Invalid response format from Ollama: embeddings array not found",
        };
      }

      const results = data.embeddings.map((embedding, index) => ({
        index,
        embedding: new Float32Array(embedding),
        dimensions: embedding.length,
      }));

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
    try {
      const response = await fetch(`${this.config.url}/api/chat`, {
        method: "POST",
        headers: {
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
          stream: false,
          options: {
            temperature: 0,
            num_predict: 10,
          },
        }),
      });

      if (!response.ok) {
        return { score: 50, error: `Reranking API error: ${response.status}` };
      }

      const data = (await response.json()) as {
        message: {
          content: string;
        };
      };

      const content = data.message?.content?.trim() || "50";
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

    if (!this.config.embeddingModel || this.config.embeddingModel.trim() === "") {
      errors.push("embeddingModel is required");
    }

    if (!this.config.rerankModel || this.config.rerankModel.trim() === "") {
      errors.push("rerankModel is required");
    }

    if (!this.config.url || this.config.url.trim() === "") {
      errors.push("url is required");
    }

    return { valid: errors.length === 0, errors };
  }

  getConfigSchema(): ProviderConfigSchema {
    return {
      type: "ollama",
      description: "Ollama API for local embeddings and reranking",
      required: [
        {
          key: "type",
          type: "string",
          description: "Must be 'ollama'",
        },
        {
          key: "embeddingModel",
          type: "string",
          description: "Model for embeddings (e.g., 'qwen3-embedding:8b')",
        },
        {
          key: "rerankModel",
          type: "string",
          description: "Model for reranking (e.g., 'qwen3:8b')",
        },
      ],
      optional: [
        {
          key: "name",
          type: "string",
          description: "Friendly name for this provider configuration",
        },
        {
          key: "url",
          type: "string",
          description: "Ollama API base URL",
          default: "http://localhost:11434",
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
