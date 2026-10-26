import { ProviderError } from "../errors.js";
import type { RateLimitInfo } from "../types.js";

export async function withRetryBackoff<T>(
  fn: () => Promise<T>,
  getRateLimit?: () => RateLimitInfo,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await fn();
      if (result === undefined || result === null) {
        throw new Error("API returned empty response");
      }
      return result;
    } catch (err: any) {
      // 429 rate limit — wait and retry
      if (err.status === 429) {
        const retryAfter = parseInt(err.response?.headers?.["retry-after"] || "60", 10);
        const waitMs = retryAfter * 1000;
        console.warn(`Rate limited (429). Waiting ${retryAfter}s...`);
        await sleepFn(waitMs);
        continue;
      }
      // 403 with rate limit exhausted — wait for reset
      const rl = getRateLimit?.();
      if (err.status === 403 && rl && rl.remaining === 0) {
        const waitMs = Math.max(0, rl.resetAt.getTime() - Date.now()) + 1000;
        console.warn(`Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s until reset...`);
        await sleepFn(waitMs);
        continue;
      }
      // 403 permission error (not rate limit) — fail with actionable message
      if (err.status === 403) {
        throw new ProviderError(
          "GitHub",
          "Token lacks required scopes",
          "Needs `repo` for private repos, `public_repo` for public. Generate at https://github.com/settings/tokens",
          403,
        );
      }
      // Other transient errors — retry with backoff
      const errStatus = err.status || err.response?.status;
      const errMsg = err.message || "";
      if (
        attempt < 4 &&
        (errStatus === 502 ||
          errStatus === 503 ||
          errStatus === 500 ||
          errMsg.includes("502") ||
          errMsg.includes("503"))
      ) {
        const delay = (attempt + 1) * 5000;
        console.warn(`Transient error (${errStatus || errMsg.slice(0, 40)}). Retrying in ${delay / 1000}s...`);
        await sleepFn(delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}
