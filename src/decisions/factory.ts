import { DisabledDecisionProvider } from "./disabled-provider.js";
import { JevDecisionProvider, type JevProviderConfig } from "./jev-provider.js";
import { MockDecisionProvider, type MockProviderOptions } from "./mock-provider.js";
import type { DecisionConfig, DecisionProvider } from "./types.js";

/**
 * Creates a DecisionProvider according to configuration.
 *
 * Enforces the disabled-provider contract:
 * - If config.enabled is explicitly false, returns DisabledDecisionProvider.
 * - The presence of TYPESAFE_API_KEY in the environment does NOT activate Jev unless
 *   decisions are explicitly enabled.
 */
export function createDecisionProvider(
  config: DecisionConfig & {
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    mockOptions?: MockProviderOptions;
  } = {},
): DecisionProvider {
  if (config.enabled === false) {
    return new DisabledDecisionProvider();
  }

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
