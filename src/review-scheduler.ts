import { existsSync, readFileSync } from "node:fs";
import { computeCredentialFingerprint } from "./decisions/triage-v2.js";
import { classifyFetchError, classifyHttpError } from "./errors.js";
import type { ClaimedReviewJob, DurableReviewQueue } from "./review-queue.js";

export const MAX_PROVIDER_ACCOUNTS = 5;

export type ReviewProviderName = "featherless" | "openai" | "kimi" | "anthropic" | "ollama" | "opencode";

export interface ReviewAccountProfile {
  accountId: string;
  provider: ReviewProviderName;
  model: string;
  apiKey?: string;
  apiKeyEnvVar?: string;
  apiKeyFile?: string;
  baseUrl?: string;
  enabled?: boolean;
  consecutive429Limit?: number;
  cooldownBaseMs?: number;
}

export interface ClassifiedError {
  kind: "auth_failed" | "credit_exhausted" | "rate_limited" | "request_rejected" | "transient_error";
  httpStatus?: number;
  errorCode?: string;
  message: string;
  retryableOnOtherAccount: boolean;
  disableAccount: boolean;
}

export interface AccountAuthStatus {
  accountId: string;
  provider: string;
  model: string;
  keyFingerprint: string;
  ok: boolean;
  status: "authenticated" | "auth_failed" | "credit_exhausted" | "rate_limited" | "error";
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  latencyMs: number;
}

export interface PreflightAuthReport {
  accounts: AccountAuthStatus[];
  allAuthenticated: boolean;
  activeAccountCount: number;
  totalAccountCount: number;
}

export interface ReviewSchedulerOptions {
  maxProviderAccounts?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  cooldownBaseMs?: number;
  maxConsecutive429?: number;
  pollIntervalMs?: number;
  drainWhenEmpty?: boolean;
  workerFn?: (
    job: ClaimedReviewJob,
    profile: ReviewAccountProfile,
    cred: { apiKey: string; keyFingerprint: string },
    signal?: AbortSignal,
  ) => Promise<{
    result: unknown;
    promptTokens?: number;
    completionTokens?: number;
    latencyMs?: number;
  }>;
}

export interface SchedulerRunResult {
  completedJobs: number;
  failedJobs: number;
  rejectedJobs: number;
  disabledAccounts: string[];
  maxObservedInFlightByAccount: Record<string, number>;
}

/**
 * Resolves account credentials without ever exposing or logging the secret key.
 * Returns a 12-char SHA-256 hex fingerprint for provenance tracking.
 */
export function resolveAccountCredential(
  profile: ReviewAccountProfile,
): { apiKey: string; keyFingerprint: string } | null {
  let rawKey: string | undefined = profile.apiKey;
  if (!rawKey && profile.apiKeyEnvVar && process.env[profile.apiKeyEnvVar]) {
    rawKey = process.env[profile.apiKeyEnvVar];
  }
  if (!rawKey && profile.apiKeyFile && existsSync(profile.apiKeyFile)) {
    try {
      rawKey = readFileSync(profile.apiKeyFile, "utf-8");
    } catch {
      // Ignore read error; handled by missing key check below
    }
  }

  if (profile.provider === "ollama") {
    const key = (rawKey || "ollama-local").trim();
    return {
      apiKey: key,
      keyFingerprint: "local-ollama",
    };
  }

  if (!rawKey || !rawKey.trim()) {
    return null;
  }

  const cleanedKey = rawKey.trim().replace(/^["']|["']$/g, "");
  const keyFingerprint = computeCredentialFingerprint(cleanedKey);
  return {
    apiKey: cleanedKey,
    keyFingerprint,
  };
}

/**
 * Loads up to 5 review account profiles from environment variables.
 * Supports REVIEW_ACCOUNT_1_* .. REVIEW_ACCOUNT_5_* or FEATHERLESS_API_KEY_1 .. 5.
 * Throws a configuration error if more than 5 profiles are configured.
 */
export function loadMultiAccountProfilesFromEnv(env: NodeJS.ProcessEnv = process.env): ReviewAccountProfile[] {
  const profiles: ReviewAccountProfile[] = [];

  const reviewAccountIndices = new Set<number>();
  const featherlessKeyIndices = new Set<number>();

  for (const key of Object.keys(env)) {
    const reviewMatch = key.match(/^REVIEW_ACCOUNT_(\d+)_/);
    if (reviewMatch) {
      reviewAccountIndices.add(parseInt(reviewMatch[1], 10));
    }
    const flKeyMatch = key.match(/^FEATHERLESS_API_KEY(?:_FILE)?_(\d+)$/);
    if (flKeyMatch) {
      featherlessKeyIndices.add(parseInt(flKeyMatch[1], 10));
    }
  }

  // Enforce boundary check on index values
  for (const idx of reviewAccountIndices) {
    if (idx > MAX_PROVIDER_ACCOUNTS) {
      throw new Error(
        `Configuration error: Account index ${idx} exceeds maximum allowed provider accounts (${MAX_PROVIDER_ACCOUNTS}).`,
      );
    }
  }
  for (const idx of featherlessKeyIndices) {
    if (idx > MAX_PROVIDER_ACCOUNTS) {
      throw new Error(
        `Configuration error: Account index ${idx} exceeds maximum allowed provider accounts (${MAX_PROVIDER_ACCOUNTS}).`,
      );
    }
  }

  if (reviewAccountIndices.size > 0) {
    const sortedIndices = Array.from(reviewAccountIndices).sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const accountId = env[`REVIEW_ACCOUNT_${idx}_ID`] || `account-${idx}`;
      const provider = (env[`REVIEW_ACCOUNT_${idx}_PROVIDER`] as ReviewProviderName) || "featherless";
      const model =
        env[`REVIEW_ACCOUNT_${idx}_MODEL`] || (provider === "featherless" ? "zai-org/GLM-5.3-Flash" : "gpt-4o-mini");
      const apiKey = env[`REVIEW_ACCOUNT_${idx}_KEY`];
      const apiKeyEnvVar = env[`REVIEW_ACCOUNT_${idx}_KEY_ENV_VAR`];
      const apiKeyFile = env[`REVIEW_ACCOUNT_${idx}_KEY_FILE`];
      const baseUrl = env[`REVIEW_ACCOUNT_${idx}_BASE_URL`];
      const enabled = env[`REVIEW_ACCOUNT_${idx}_ENABLED`] !== "false";

      profiles.push({
        accountId,
        provider,
        model,
        apiKey,
        apiKeyEnvVar,
        apiKeyFile,
        baseUrl,
        enabled,
      });
    }
  } else if (featherlessKeyIndices.size > 0) {
    const sortedIndices = Array.from(featherlessKeyIndices).sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      profiles.push({
        accountId: `featherless-acct-${idx}`,
        provider: "featherless",
        model: env.FEATHERLESS_MODEL || "zai-org/GLM-5.3-Flash",
        apiKey: env[`FEATHERLESS_API_KEY_${idx}`],
        apiKeyFile: env[`FEATHERLESS_API_KEY_FILE_${idx}`],
        baseUrl: env.FEATHERLESS_BASE_URL || "https://api.featherless.ai/v1",
        enabled: true,
      });
    }
  } else if (env.FEATHERLESS_API_KEY || env.FEATHERLESS_API_KEY_FILE) {
    profiles.push({
      accountId: "featherless-acct-1",
      provider: "featherless",
      model: env.FEATHERLESS_MODEL || "zai-org/GLM-5.3-Flash",
      apiKey: env.FEATHERLESS_API_KEY,
      apiKeyFile: env.FEATHERLESS_API_KEY_FILE,
      baseUrl: env.FEATHERLESS_BASE_URL || "https://api.featherless.ai/v1",
      enabled: true,
    });
  }

  if (profiles.length > MAX_PROVIDER_ACCOUNTS) {
    throw new Error(
      `Configuration error: Exceeded maximum allowed provider accounts (${MAX_PROVIDER_ACCOUNTS}). Got ${profiles.length}.`,
    );
  }

  return profiles;
}

/**
 * Classifies an error thrown during review execution into typed categories:
 * - auth_failed: 401 or 403 upgrade_required (disables account, retryable on other accounts)
 * - credit_exhausted: 402 or quota exceeded (disables account, retryable on other accounts)
 * - rate_limited: 429 (backs off exponential cooldown)
 * - request_rejected: 400 or 422 or schema failure (marks job rejected_permanent, NEVER retried!)
 * - transient_error: 5xx, network timeouts (retryable up to max attempts)
 */
export function classifyProviderError(err: unknown): ClassifiedError {
  const anyErr = err as any;
  const status =
    typeof anyErr?.statusCode === "number"
      ? anyErr.statusCode
      : typeof anyErr?.status === "number"
        ? anyErr.status
        : typeof anyErr?.httpStatus === "number"
          ? anyErr.httpStatus
          : typeof anyErr?.response?.status === "number"
            ? anyErr.response.status
            : undefined;

  const rawMessage =
    (err instanceof Error ? err.message : typeof anyErr?.message === "string" ? anyErr.message : String(err)) || "";
  const lowerMsg = rawMessage.toLowerCase();
  const name = anyErr?.name || "";

  // 1. Request rejected: Bad Request / Unprocessable / Validation -> NEVER retry across accounts!
  if (
    status === 400 ||
    status === 422 ||
    name === "ZodError" ||
    lowerMsg.includes("bad request") ||
    lowerMsg.includes("unprocessable") ||
    lowerMsg.includes("schema validation") ||
    lowerMsg.includes("validation error") ||
    lowerMsg.includes("invalid prompt") ||
    lowerMsg.includes("request_rejected") ||
    lowerMsg.includes("content policy") ||
    lowerMsg.includes("invalid argument")
  ) {
    return {
      kind: "request_rejected",
      httpStatus: status ?? (lowerMsg.includes("422") ? 422 : 400),
      errorCode: anyErr?.code || "REQUEST_REJECTED",
      message: rawMessage,
      retryableOnOtherAccount: false,
      disableAccount: false,
    };
  }

  // 2. Auth failed: 401, or 403 upgrade_required / forbidden
  if (
    status === 401 ||
    (status === 403 &&
      (lowerMsg.includes("upgrade_required") ||
        lowerMsg.includes("unauthorized") ||
        lowerMsg.includes("forbidden") ||
        lowerMsg.includes("permission") ||
        lowerMsg.includes("invalid key") ||
        lowerMsg.includes("api key"))) ||
    lowerMsg.includes("upgrade_required") ||
    lowerMsg.includes("unauthorized") ||
    lowerMsg.includes("invalid api key") ||
    lowerMsg.includes("auth_failed")
  ) {
    return {
      kind: "auth_failed",
      httpStatus: status ?? (lowerMsg.includes("403") ? 403 : 401),
      errorCode: lowerMsg.includes("upgrade_required") ? "UPGRADE_REQUIRED" : anyErr?.code || "AUTH_FAILED",
      message: rawMessage,
      retryableOnOtherAccount: true,
      disableAccount: true,
    };
  }

  // 3. Credit exhausted: 402 or credit / quota message
  if (
    status === 402 ||
    lowerMsg.includes("credit_exhausted") ||
    lowerMsg.includes("insufficient credit") ||
    lowerMsg.includes("quota exceeded") ||
    lowerMsg.includes("payment required") ||
    lowerMsg.includes("balance") ||
    lowerMsg.includes("billing")
  ) {
    return {
      kind: "credit_exhausted",
      httpStatus: status ?? 402,
      errorCode: anyErr?.code || "CREDIT_EXHAUSTED",
      message: rawMessage,
      retryableOnOtherAccount: true,
      disableAccount: true,
    };
  }

  // 4. Rate limited: 429
  if (
    status === 429 ||
    lowerMsg.includes("rate_limited") ||
    lowerMsg.includes("rate limit") ||
    lowerMsg.includes("too many requests")
  ) {
    return {
      kind: "rate_limited",
      httpStatus: 429,
      errorCode: anyErr?.code || "RATE_LIMITED",
      message: rawMessage,
      retryableOnOtherAccount: true,
      disableAccount: false,
    };
  }

  // 5. Transient error: 5xx, timeouts, network interruptions
  return {
    kind: "transient_error",
    httpStatus: status,
    errorCode: anyErr?.code || "TRANSIENT_ERROR",
    message: rawMessage,
    retryableOnOtherAccount: true,
    disableAccount: false,
  };
}

/**
 * Pre-flight authentication gate:
 * Probes each configured account independently (1 minimal probe per account).
 * Returns a detailed report of active and failing accounts.
 */
export async function verifyAccountsIndependently(
  profiles: ReviewAccountProfile[],
  probeFn?: (
    profile: ReviewAccountProfile,
    cred: { apiKey: string; keyFingerprint: string },
  ) => Promise<{
    ok: boolean;
    status?: AccountAuthStatus["status"];
    httpStatus?: number;
    errorCode?: string;
    errorMessage?: string;
  }>,
): Promise<PreflightAuthReport> {
  const accounts: AccountAuthStatus[] = [];

  for (const profile of profiles) {
    if (profile.enabled === false) {
      continue;
    }

    const cred = resolveAccountCredential(profile);
    if (!cred) {
      accounts.push({
        accountId: profile.accountId,
        provider: profile.provider,
        model: profile.model,
        keyFingerprint: "unknown",
        ok: false,
        status: "auth_failed",
        errorCode: "MISSING_CREDENTIALS",
        errorMessage: `Missing API credentials for account ${profile.accountId}`,
        latencyMs: 0,
      });
      continue;
    }

    const start = Date.now();
    try {
      if (probeFn) {
        const res = await probeFn(profile, cred);
        const latencyMs = Date.now() - start;
        accounts.push({
          accountId: profile.accountId,
          provider: profile.provider,
          model: profile.model,
          keyFingerprint: cred.keyFingerprint,
          ok: res.ok,
          status: res.status ?? (res.ok ? "authenticated" : "error"),
          httpStatus: res.httpStatus,
          errorCode: res.errorCode,
          errorMessage: res.errorMessage,
          latencyMs,
        });
      } else {
        const baseUrl =
          profile.baseUrl ||
          (profile.provider === "featherless" ? "https://api.featherless.ai/v1" : "https://api.openai.com/v1");

        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cred.apiKey}`,
          },
          body: JSON.stringify({
            model: profile.model || "zai-org/GLM-5.3-Flash",
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(15000),
        });

        const latencyMs = Date.now() - start;
        if (resp.ok) {
          accounts.push({
            accountId: profile.accountId,
            provider: profile.provider,
            model: profile.model,
            keyFingerprint: cred.keyFingerprint,
            ok: true,
            status: "authenticated",
            httpStatus: resp.status,
            latencyMs,
          });
        } else {
          const errText = await resp.text().catch(() => "");
          const classified = classifyProviderError({
            statusCode: resp.status,
            message: errText,
          });
          const authStatus: AccountAuthStatus["status"] =
            classified.kind === "auth_failed"
              ? "auth_failed"
              : classified.kind === "credit_exhausted"
                ? "credit_exhausted"
                : classified.kind === "rate_limited"
                  ? "rate_limited"
                  : "error";

          accounts.push({
            accountId: profile.accountId,
            provider: profile.provider,
            model: profile.model,
            keyFingerprint: cred.keyFingerprint,
            ok: false,
            status: authStatus,
            httpStatus: resp.status,
            errorCode: classified.errorCode,
            errorMessage: classified.message,
            latencyMs,
          });
        }
      }
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      const classified = classifyProviderError(err);
      const authStatus: AccountAuthStatus["status"] =
        classified.kind === "auth_failed"
          ? "auth_failed"
          : classified.kind === "credit_exhausted"
            ? "credit_exhausted"
            : classified.kind === "rate_limited"
              ? "rate_limited"
              : "error";

      accounts.push({
        accountId: profile.accountId,
        provider: profile.provider,
        model: profile.model,
        keyFingerprint: cred.keyFingerprint,
        ok: false,
        status: authStatus,
        httpStatus: classified.httpStatus,
        errorCode: classified.errorCode,
        errorMessage: classified.message,
        latencyMs,
      });
    }
  }

  const activeAccountCount = accounts.filter((a) => a.ok).length;
  const totalAccountCount = accounts.length;
  const allAuthenticated = totalAccountCount > 0 && activeAccountCount === totalAccountCount;

  return {
    accounts,
    allAuthenticated,
    activeAccountCount,
    totalAccountCount,
  };
}

/**
 * Multi-Provider Review Scheduler.
 *
 * Runs up to 1 concurrent worker loop per configured active account (max 5 accounts).
 * Enforces the Hard Concurrency Invariant:
 *   - Each account has exactly 1 worker loop.
 *   - `inFlightByAccount` for each account never exceeds 1.
 *   - `maxObservedInFlightByAccount` tracks runtime proof for testing.
 *   - Automatically halts failing accounts on auth/credit issues without cycling.
 *   - Exponential backoff on HTTP 429 rate limits.
 */
export class MultiProviderReviewScheduler {
  private queue: DurableReviewQueue;
  private profiles: ReviewAccountProfile[];
  private maxProviderAccounts: number;
  private leaseDurationMs: number;
  private heartbeatIntervalMs: number;
  private cooldownBaseMs: number;
  private maxConsecutive429: number;
  private pollIntervalMs: number;
  private drainWhenEmpty: boolean;
  private workerFn?: (
    job: ClaimedReviewJob,
    profile: ReviewAccountProfile,
    cred: { apiKey: string; keyFingerprint: string },
    signal?: AbortSignal,
  ) => Promise<{
    result: unknown;
    promptTokens?: number;
    completionTokens?: number;
    latencyMs?: number;
  }>;

  private inFlightByAccount = new Map<string, number>();
  public readonly maxObservedInFlightByAccount = new Map<string, number>();
  private disabledAccounts = new Set<string>();
  private accountCooldownUntil = new Map<string, number>();
  private consecutive429ByAccount = new Map<string, number>();
  private stopped = false;
  private abortController = new AbortController();

  constructor(queue: DurableReviewQueue, profiles: ReviewAccountProfile[], options: ReviewSchedulerOptions = {}) {
    this.maxProviderAccounts = options.maxProviderAccounts ?? MAX_PROVIDER_ACCOUNTS;
    if (profiles.length > this.maxProviderAccounts) {
      throw new Error(
        `Configuration error: Exceeded maximum allowed provider accounts (${this.maxProviderAccounts}). Got ${profiles.length}.`,
      );
    }

    this.queue = queue;
    this.profiles = profiles;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.cooldownBaseMs = options.cooldownBaseMs ?? 1_000;
    this.maxConsecutive429 = options.maxConsecutive429 ?? 3;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.drainWhenEmpty = options.drainWhenEmpty ?? true;
    this.workerFn = options.workerFn;

    for (const p of this.profiles) {
      this.inFlightByAccount.set(p.accountId, 0);
      this.maxObservedInFlightByAccount.set(p.accountId, 0);
      this.consecutive429ByAccount.set(p.accountId, 0);
      this.accountCooldownUntil.set(p.accountId, 0);
    }
  }

  public getInFlight(accountId: string): number {
    return this.inFlightByAccount.get(accountId) || 0;
  }

  public getMaxObservedInFlight(accountId: string): number {
    return this.maxObservedInFlightByAccount.get(accountId) || 0;
  }

  public isAccountDisabled(accountId: string): boolean {
    return this.disabledAccounts.has(accountId);
  }

  public getDisabledAccounts(): string[] {
    return Array.from(this.disabledAccounts);
  }

  public stop(): void {
    this.stopped = true;
    this.abortController.abort();
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted || ms <= 0) return resolve();
      const timeout = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async defaultExecuteJob(
    job: ClaimedReviewJob,
    profile: ReviewAccountProfile,
    cred: { apiKey: string; keyFingerprint: string },
    signal?: AbortSignal,
  ): Promise<{
    result: unknown;
    promptTokens?: number;
    completionTokens?: number;
    latencyMs?: number;
  }> {
    const baseUrl =
      profile.baseUrl ||
      (profile.provider === "featherless" ? "https://api.featherless.ai/v1" : "https://api.openai.com/v1");

    const model = profile.model || (profile.provider === "featherless" ? "zai-org/GLM-5.3-Flash" : "gpt-4o-mini");

    const payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
    const messages = [
      {
        role: "system",
        content: "You are an automated PR reviewer. Return your review strictly as JSON.",
      },
      {
        role: "user",
        content: `Review the following ${job.itemType} #${job.itemNumber} (${job.title}):\n${JSON.stringify(payload)}`,
      },
    ];

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cred.apiKey && cred.apiKey !== "ollama-local") {
      headers.Authorization = `Bearer ${cred.apiKey}`;
    }

    const start = Date.now();
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
        signal,
      });
    } catch (err: any) {
      throw classifyFetchError(profile.provider, err, { secrets: [cred.apiKey] });
    }

    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      throw classifyHttpError(profile.provider, resp.status, errorText, {
        secrets: [cred.apiKey],
      });
    }

    const data = (await resp.json()) as any;
    const content = data.choices?.[0]?.message?.content || "{}";
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { rawContent: content };
    }

    return {
      result: parsed,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      latencyMs,
    };
  }

  private async runWorkerForAccount(
    profile: ReviewAccountProfile,
    cred: { apiKey: string; keyFingerprint: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const accountId = profile.accountId;

    while (!this.stopped && !signal?.aborted && !this.disabledAccounts.has(accountId)) {
      // 1. Check cooldown
      const cooldownUntil = this.accountCooldownUntil.get(accountId) || 0;
      const now = Date.now();
      if (cooldownUntil > now) {
        const waitTime = Math.min(cooldownUntil - now, 200);
        await this.sleep(waitTime, signal);
        continue;
      }

      // 2. Claim next job
      const claimed = this.queue.claimNextJobForAccount(accountId, this.leaseDurationMs, Date.now());

      if (!claimed) {
        if (this.drainWhenEmpty) {
          const anyInFlight = Array.from(this.inFlightByAccount.values()).some((c) => c > 0);
          const stats = this.queue.getQueueStats();
          if (stats.queued === 0 && !anyInFlight) {
            break;
          }
        }
        await this.sleep(this.pollIntervalMs, signal);
        continue;
      }

      // 3. Concurrency check: enforce HARD CONCURRENCY INVARIANT
      const currentInFlight = (this.inFlightByAccount.get(accountId) || 0) + 1;
      if (currentInFlight > 1) {
        throw new Error(
          `CRITICAL INVARIANT VIOLATION: Account ${accountId} has ${currentInFlight} in-flight operations (max allowed is 1)!`,
        );
      }
      this.inFlightByAccount.set(accountId, currentInFlight);
      const maxObs = Math.max(currentInFlight, this.maxObservedInFlightByAccount.get(accountId) || 0);
      this.maxObservedInFlightByAccount.set(accountId, maxObs);

      // 4. Heartbeat timer while job is processing
      let heartbeatTimer: NodeJS.Timeout | null = setInterval(() => {
        try {
          this.queue.heartbeatLease(accountId, claimed.leaseId, this.leaseDurationMs);
        } catch {
          // Heartbeat failure ignored
        }
      }, this.heartbeatIntervalMs);

      const startMs = Date.now();
      try {
        let execResult: {
          result: unknown;
          promptTokens?: number;
          completionTokens?: number;
          latencyMs?: number;
        };

        if (this.workerFn) {
          execResult = await this.workerFn(claimed, profile, cred, signal);
        } else {
          execResult = await this.defaultExecuteJob(claimed, profile, cred, signal);
        }

        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        const latencyMs = Date.now() - startMs;
        this.consecutive429ByAccount.set(accountId, 0);

        this.queue.completeJobWithCheckpoint({
          jobId: claimed.jobId,
          accountId,
          leaseId: claimed.leaseId,
          provider: profile.provider,
          model: profile.model,
          keyFingerprint: cred.keyFingerprint,
          result: execResult.result,
          promptTokens: execResult.promptTokens ?? 0,
          completionTokens: execResult.completionTokens ?? 0,
          latencyMs: execResult.latencyMs ?? latencyMs,
        });
      } catch (err: any) {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        const latencyMs = Date.now() - startMs;
        const classified = classifyProviderError(err);

        if (classified.kind === "rate_limited") {
          const streak = (this.consecutive429ByAccount.get(accountId) || 0) + 1;
          this.consecutive429ByAccount.set(accountId, streak);
          if (streak > this.maxConsecutive429) {
            this.disabledAccounts.add(accountId);
          } else {
            const backoff = this.cooldownBaseMs * 2 ** (streak - 1);
            this.accountCooldownUntil.set(accountId, Date.now() + backoff);
          }
        } else if (classified.disableAccount) {
          this.disabledAccounts.add(accountId);
        }

        this.queue.releaseJobOnFailure({
          jobId: claimed.jobId,
          accountId,
          leaseId: claimed.leaseId,
          provider: profile.provider,
          model: profile.model,
          keyFingerprint: cred.keyFingerprint,
          failureKind: classified.kind,
          errorMessage: classified.message,
          errorCode: classified.errorCode,
          httpStatus: classified.httpStatus,
          latencyMs,
        });
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        this.inFlightByAccount.set(accountId, 0);
      }
    }
  }

  /**
   * Alias for `start(signal)` to support both `.start()` and `.run()` callers.
   */
  public async run(signal?: AbortSignal): Promise<SchedulerRunResult> {
    return this.start(signal);
  }

  /**
   * Starts review processing across all active accounts concurrently.
   * Runs until queue is drained, signal is aborted, or all accounts are disabled.
   */
  public async start(signal?: AbortSignal): Promise<SchedulerRunResult> {
    if (this.profiles.length > this.maxProviderAccounts) {
      throw new Error(
        `Configuration error: Exceeded maximum allowed provider accounts (${this.maxProviderAccounts}). Got ${this.profiles.length}.`,
      );
    }

    const linkedController = new AbortController();
    const onAbort = () => {
      this.stopped = true;
      linkedController.abort();
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    this.abortController.signal.addEventListener("abort", onAbort, { once: true });

    // Filter valid configured accounts
    const activeProfilesWithCreds = this.profiles
      .filter((p) => p.enabled !== false && !this.disabledAccounts.has(p.accountId))
      .map((p) => ({ profile: p, cred: resolveAccountCredential(p) }))
      .filter((entry): entry is { profile: ReviewAccountProfile; cred: { apiKey: string; keyFingerprint: string } } => {
        if (!entry.cred) {
          this.disabledAccounts.add(entry.profile.accountId);
          return false;
        }
        return true;
      });

    for (const p of this.profiles) {
      this.inFlightByAccount.set(p.accountId, 0);
      this.maxObservedInFlightByAccount.set(p.accountId, 0);
    }

    if (activeProfilesWithCreds.length > 0) {
      const workerPromises = activeProfilesWithCreds.map((entry) =>
        this.runWorkerForAccount(entry.profile, entry.cred, linkedController.signal),
      );
      await Promise.all(workerPromises);
    }

    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }

    const stats = this.queue.getQueueStats();
    const maxInFlightObj: Record<string, number> = {};
    for (const [acc, maxVal] of this.maxObservedInFlightByAccount.entries()) {
      maxInFlightObj[acc] = maxVal;
    }

    return {
      completedJobs: stats.completed,
      failedJobs: stats.failed,
      rejectedJobs: stats.rejected_permanent,
      disabledAccounts: Array.from(this.disabledAccounts),
      maxObservedInFlightByAccount: maxInFlightObj,
    };
  }
}
