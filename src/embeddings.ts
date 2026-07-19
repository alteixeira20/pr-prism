import type { EnvConfig } from "./config.js";
import { classifyFetchError, classifyHttpError, ProviderError } from "./errors.js";
import type { EmbeddingProvider } from "./types.js";

interface ProviderConfig {
  provider: string;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  dimensions?: number;
}

class OpenAIEmbeddings implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private config: ProviderConfig;
  dimensions = 1536;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) throw new Error("EMBEDDING_API_KEY required for OpenAI");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.config = config;
    this.baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    if (config.model.includes("3-large")) {
      this.dimensions = 3072;
    } else if (config.model.includes("3-small") || config.model.includes("ada-002")) {
      this.dimensions = 1536;
    } else {
      this.dimensions = 1536;
    }

    if (config.dimensions && config.dimensions > this.dimensions) {
      this.dimensions = config.dimensions;
    }
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const sanitized = texts.map((t) => {
      if (!t || typeof t !== "string") return " ";
      return t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim() || " ";
    });
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input: sanitized, model: this.model }),
      });
    } catch (err: any) {
      throw classifyFetchError("OpenAI Embeddings", err, { apiKeyEnvVar: "EMBEDDING_API_KEY" });
    }
    if (!resp.ok) {
      const body = await resp.text();

      if (process.env.PRISM_DEBUG_PROVIDER === "1") {
        const lengths = sanitized.map((text) => text.length);
        const totalCharacters = lengths.reduce((sum, length) => sum + length, 0);

        console.error(
          JSON.stringify(
            {
              provider: "OpenAI Embeddings",
              status: resp.status,
              statusText: resp.statusText,
              model: this.model,
              endpoint: `${this.baseUrl}/embeddings`,
              inputCount: sanitized.length,
              inputLengths: lengths,
              totalCharacters,
              responseContentType: resp.headers.get("content-type"),
              responseBodyPreview: body.slice(0, 1000),
            },
            null,
            2,
          ),
        );
      }

      throw classifyHttpError("OpenAI Embeddings", resp.status, body, {
        apiKeyEnvVar: "EMBEDDING_API_KEY",
      });
    }
    const data = (await resp.json()) as any;
    if (!data.data || !Array.isArray(data.data)) {
      throw new ProviderError(
        "OpenAI Embeddings",
        "Unexpected response format (missing data array)",
        "Check the API base URL and model name are correct",
      );
    }
    const embeddings = data.data.map((d: any) => d.embedding);

    if (embeddings.length > 0 && embeddings[0]) {
      const returnedDim = embeddings[0].length;
      const hasConfiguredDim = this.config.dimensions !== undefined;

      if (!hasConfiguredDim && returnedDim !== this.dimensions) {
        throw new ProviderError(
          "OpenAI Embeddings",
          `Dimension mismatch: model returned ${returnedDim} dimensions, but provider defaulted to ${this.dimensions}.`,
          `Set EMBEDDING_DIMENSIONS=${returnedDim} in your .env file and run \`prism reset\` to start fresh.`,
        );
      }

      if (hasConfiguredDim && returnedDim < (this.config.dimensions || 0)) {
        throw new ProviderError(
          "OpenAI Embeddings",
          `Dimension mismatch: model returned ${returnedDim} dimensions, but provider was configured to use ${this.config.dimensions}.`,
          `Set EMBEDDING_DIMENSIONS=${returnedDim} in your .env file and run \`prism reset\` to start fresh.`,
        );
      }
    }

    return embeddings;
  }
}

class KimiEmbeddings implements EmbeddingProvider {
  private inner: OpenAIEmbeddings;
  dimensions = 1024;

  constructor(config: ProviderConfig) {
    this.inner = new OpenAIEmbeddings({
      ...config,
      baseUrl: "https://api.moonshot.cn/v1",
    });
  }

  embed(text: string) {
    return this.inner.embed(text);
  }
  embedBatch(texts: string[]) {
    return this.inner.embedBatch(texts);
  }
}

class OllamaEmbeddings implements EmbeddingProvider {
  private model: string;
  private baseUrl: string;
  dimensions = 0; // set by init()
  private initialized = false;

  constructor(config: ProviderConfig) {
    this.model = config.model || "nomic-embed-text";
    this.baseUrl = config.baseUrl || "http://localhost:11434";
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const probe = await this.embed("dimension probe");
    this.dimensions = probe.length;
    this.initialized = true;
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (err: any) {
      throw classifyFetchError("Ollama", err);
    }
    if (!resp.ok) {
      const body = await resp.text();
      throw classifyHttpError("Ollama", resp.status, body);
    }
    const data = (await resp.json()) as any;
    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new ProviderError(
        "Ollama",
        "Unexpected response format (missing embeddings array)",
        "Check that Ollama is up to date and the model supports embeddings",
      );
    }
    if (!this.initialized) {
      this.dimensions = data.embeddings[0].length;
      this.initialized = true;
    }
    return data.embeddings;
  }
}

class VoyageEmbeddings implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  dimensions = 1024;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) throw new Error("EMBEDDING_API_KEY required for VoyageAI");
    this.apiKey = config.apiKey;
    this.model = config.model || "voyage-2";
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    let resp: Response;
    try {
      resp = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input: texts, model: this.model }),
      });
    } catch (err: any) {
      throw classifyFetchError("VoyageAI", err, { apiKeyEnvVar: "EMBEDDING_API_KEY" });
    }
    if (!resp.ok) {
      const body = await resp.text();
      throw classifyHttpError("VoyageAI", resp.status, body, { apiKeyEnvVar: "EMBEDDING_API_KEY" });
    }
    const data = (await resp.json()) as any;
    if (!data.data || !Array.isArray(data.data)) {
      throw new ProviderError(
        "VoyageAI",
        "Unexpected response format (missing data array)",
        "Check the API key and model name are correct",
      );
    }
    if (this.dimensions === 0 || this.dimensions === 1024) {
      this.dimensions = data.data[0].embedding.length;
    }
    return data.data.map((d: any) => d.embedding);
  }
}

class JinaEmbeddings implements EmbeddingProvider {
  private inner: OpenAIEmbeddings;
  dimensions = 1024;

  constructor(config: ProviderConfig) {
    this.inner = new OpenAIEmbeddings({
      ...config,
      baseUrl: "https://api.jina.ai/v1",
      model: config.model || "jina-embeddings-v3",
    });
  }

  embed(text: string) {
    return this.inner.embed(text);
  }
  embedBatch(texts: string[]) {
    return this.inner.embedBatch(texts);
  }
}

export async function createEmbeddingProviderFromEnv(env: EnvConfig): Promise<EmbeddingProvider> {
  return createEmbeddingProvider({
    provider: env.EMBEDDING_PROVIDER,
    apiKey: env.EMBEDDING_API_KEY,
    model: env.EMBEDDING_MODEL,
    baseUrl: env.EMBEDDING_BASE_URL,
    dimensions: env.EMBEDDING_DIMENSIONS,
  });
}

export async function createEmbeddingProvider(config: ProviderConfig): Promise<EmbeddingProvider> {
  switch (config.provider) {
    case "openai":
      return new OpenAIEmbeddings(config);
    case "kimi":
      return new KimiEmbeddings(config);
    case "ollama": {
      const provider = new OllamaEmbeddings(config);
      await provider.init();
      return provider;
    }
    case "voyageai":
      return new VoyageEmbeddings(config);
    case "jina":
      return new JinaEmbeddings(config);
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}

// Bump whenever prepareEmbeddingText's output format changes. It's folded into
// the embedding config hash so a format change invalidates cached embeddings and
// the scan warns to re-embed, instead of silently mixing old and new text vectors.
// v1: "Pull Request:"/"Issue:" type prefix. v2: no prefix.
export const EMBEDDING_TEXT_VERSION = 2;

export function embeddingConfigHash(provider: string, model: string, dimensions: number): string {
  return `${provider}:${model}:${dimensions}:t${EMBEDDING_TEXT_VERSION}`;
}

export function prepareEmbeddingText(item: { title: string; body: string; type: string }): string {
  // No type prefix. A leading "Pull Request:" / "Issue:" token systematically
  // pushes an issue away from its own fix PR in embedding space, which fragments
  // a single bug across separate clusters. Only takes effect after a re-embed.
  const title = (item.title || "Untitled").trim();
  const body = (item.body || "").trim().slice(0, 2000);
  return body ? `${title}\n\n${body}` : title;
}
