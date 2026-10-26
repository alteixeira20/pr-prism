import { JevDecisionProvider, type JevProviderConfig } from "./jev-provider.js";
import { MockDecisionProvider, type MockProviderOptions } from "./mock-provider.js";
import type { DecisionConfig, DecisionProvider } from "./types.js";

export function createDecisionProvider(
  config: DecisionConfig & {
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    mockOptions?: MockProviderOptions;
  } = {},
): DecisionProvider {
  const provider = config.provider || "jev";

  switch (provider) {
    case "jev": {
      const jevConfig: JevProviderConfig = {
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultModel: config.model,
        timeoutMs: config.timeoutMs,
        fetch: config.fetch,
      };
      return new JevDecisionProvider(jevConfig);
    }
    case "mock": {
      return new MockDecisionProvider({
        model: config.model,
        ...config.mockOptions,
      });
    }
    default:
      throw new Error(`Unknown decision provider: ${provider}. Supported providers are 'jev' and 'mock'.`);
  }
}
