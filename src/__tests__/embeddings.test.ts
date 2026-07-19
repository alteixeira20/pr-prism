import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnvConfig } from "../config.js";
import {
  createEmbeddingProvider,
  EMBEDDING_TEXT_VERSION,
  embeddingConfigHash,
  prepareEmbeddingText,
} from "../embeddings.js";
import { ProviderError } from "../errors.js";

describe("prepareEmbeddingText", () => {
  it("formats title and body without a type prefix", () => {
    const result = prepareEmbeddingText({ title: "Fix bug", body: "This fixes the login issue", type: "pr" });
    expect(result).toBe("Fix bug\n\nThis fixes the login issue");
  });

  it("formats title without body", () => {
    const result = prepareEmbeddingText({ title: "Feature request", body: "", type: "issue" });
    expect(result).toBe("Feature request");
  });

  it("a PR and an issue with identical content embed to identical text (no type bias)", () => {
    const content = { title: "Login fails on empty password", body: "steps: submit the form blank" };
    const pr = prepareEmbeddingText({ ...content, type: "pr" });
    const issue = prepareEmbeddingText({ ...content, type: "issue" });
    // the old "Pull Request:" / "Issue:" prefix pulled these apart in embedding space
    expect(pr).toBe(issue);
  });

  it("truncates long bodies", () => {
    const longBody = "x".repeat(3000);
    const result = prepareEmbeddingText({ title: "Test", body: longBody, type: "pr" });
    expect(result.length).toBeLessThanOrEqual(2000 + "Test\n\n".length);
  });

  it("handles null-ish title", () => {
    const result = prepareEmbeddingText({ title: "", body: "body", type: "pr" });
    expect(result).toContain("Untitled");
  });
});

describe("embeddingConfigHash", () => {
  it("folds in the text-format version so an embed-text change invalidates cached embeddings", () => {
    // pre-guard DBs stored the bare provider:model:dims hash; a text change like
    // dropping the type prefix must now mismatch it so the scan warns to reset.
    const legacy = "ollama:nomic-embed-text:768";
    const now = embeddingConfigHash("ollama", "nomic-embed-text", 768);
    expect(now).not.toBe(legacy);
    expect(now).toContain(`:t${EMBEDDING_TEXT_VERSION}`);
  });

  it("stays stable for the same provider/model/dims/version", () => {
    expect(embeddingConfigHash("jina", "jina-v3", 1024)).toBe(embeddingConfigHash("jina", "jina-v3", 1024));
  });
});

describe("loadEnvConfig", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("preserves EMBEDDING_BASE_URL", () => {
    process.env.GITHUB_TOKEN = "dummy-token";
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.EMBEDDING_BASE_URL = "https://api.custom-openai.com/v1/";
    process.env.EMBEDDING_API_KEY = "dummy-key";

    const config = loadEnvConfig("/nonexistent-to-avoid-loading-file");
    expect(config.EMBEDDING_BASE_URL).toBe("https://api.custom-openai.com/v1/");
  });
});

describe("OpenAIEmbeddings constructions and endpoint routing", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses the default official OpenAI endpoint when baseUrl is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: new Array(1536).fill(0.1) }],
      }),
    });

    const provider = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
    });

    await provider.embed("hello");
    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/embeddings", expect.any(Object));
  });

  it("normalizes trailing slashes in custom baseUrl", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: new Array(1536).fill(0.1) }],
      }),
    });

    const providerWithSlash = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      baseUrl: "https://api.custom.com/v1/",
    });

    await providerWithSlash.embed("hello");
    expect(fetchMock).toHaveBeenLastCalledWith("https://api.custom.com/v1/embeddings", expect.any(Object));

    const providerWithoutSlash = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      baseUrl: "https://api.custom.com/v1",
    });

    await providerWithoutSlash.embed("hello");
    expect(fetchMock).toHaveBeenLastCalledWith("https://api.custom.com/v1/embeddings", expect.any(Object));
  });

  it("does not leak secret API key in diagnostics console logs", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalDebug = process.env.PRISM_DEBUG_PROVIDER;
    process.env.PRISM_DEBUG_PROVIDER = "1";

    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid key",
    });

    const provider = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "sk-secret-key-12345",
      model: "text-embedding-3-small",
    });

    await expect(provider.embed("hello")).rejects.toThrow();

    // Check console error content
    const callArgs = consoleErrorSpy.mock.calls.map((call) => JSON.stringify(call));
    for (const arg of callArgs) {
      expect(arg).not.toContain("sk-secret-key-12345");
    }

    // Restore
    consoleErrorSpy.mockRestore();
    if (originalDebug !== undefined) {
      process.env.PRISM_DEBUG_PROVIDER = originalDebug;
    } else {
      delete process.env.PRISM_DEBUG_PROVIDER;
    }
  });

  it("aborts promptly and throws on deterministic 401 without retry", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid key",
    });

    const provider = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
    });

    await expect(provider.embed("hello")).rejects.toThrow(ProviderError);
    // Should only be called once because it is deterministic 401, so no retries inside OpenAIEmbeddings or outer loop
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates dimensions correctly and throws on mismatch", async () => {
    // 1. Mismatch with default expected dimensions (1536) when no config dimensions are specified
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: new Array(2560).fill(0.1) }], // returned is 2560, expected is 1536
      }),
    });

    const providerNoConfigDim = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
    });

    await expect(providerNoConfigDim.embed("hello")).rejects.toThrow(
      /Dimension mismatch: model returned 2560 dimensions, but provider defaulted to 1536/,
    );

    // 2. Mismatch when configured dimension is higher than what the model returns
    const providerConfigDimTooHigh = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 3000,
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: new Array(2560).fill(0.1) }], // returned is 2560, configured is 3000
      }),
    });

    await expect(providerConfigDimTooHigh.embed("hello")).rejects.toThrow(
      /Dimension mismatch: model returned 2560 dimensions, but provider was configured to use 3000/,
    );

    // 3. Success when configured dimension is smaller than what the model returns (truncation allowed)
    const providerConfigDimSmaller = await createEmbeddingProvider({
      provider: "openai",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 1024,
    });

    const result = await providerConfigDimSmaller.embed("hello");
    expect(result.length).toBe(2560); // raw provider returns full dimensions; pipeline wrapper will slice it
  });
});
