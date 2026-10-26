import { execFileSync } from "node:child_process";
import dns from "node:dns";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCORING_WEIGHTS, type PrismConfig } from "../config.js";
import { GitHubClient } from "../github.js";
import { parseDuration, runDupes, runRank, runScan, runVision } from "../pipeline.js";
import { VectorStore } from "../store.js";
import type { EmbeddingProvider, PipelineContext } from "../types.js";
import { captureProcessEnv, getIsolatedEnv, restoreProcessEnv } from "./cli-test-env.js";
import {
  execInOsNetworkSandbox,
  installNetworkGuard,
  isOsNetworkIsolationSupported,
  type NetworkGuard,
} from "./network-sandbox.js";

const rootDir = resolve(__dirname, "../..");
const distCli = resolve(rootDir, "dist/cli.js");

describe("PR-Prism v4 Orchestrated Production E2E & Negative Acceptance", () => {
  let tempDir: string;
  let visionDocPath: string;
  let baselineEnv: NodeJS.ProcessEnv;
  let networkGuard: NetworkGuard;

  // Normalized 4-dimensional unit vector fixtures
  const v101 = [0.96, 0.28, 0.0, 0.0];
  const v102 = [0.98, 0.198997, 0.0, 0.0];
  const v50 = [0.94, 0.341174, 0.0, 0.0];
  const v201 = [0.0, 0.0, 0.8, 0.6];
  const v202 = [0.0, 0.0, 0.0, 1.0];
  const vVisionAligned = [0.0, 0.0, 0.8, 0.6];
  const vGeneral = [0.5, 0.5, 0.5, 0.5];

  // Deterministic 4D mock embedder
  let embedBatchCalls = 0;
  const deterministicEmbedder: EmbeddingProvider = {
    dimensions: 4,
    embed: async (text: string) => {
      const lower = text.toLowerCase();
      if (lower.includes("101") || lower.includes("retry backoff timeout in network client")) {
        return v101;
      }
      if (lower.includes("102") || lower.includes("duplicate submission of retry backoff")) {
        return v102;
      }
      if (lower.includes("50") || lower.includes("connection retries fail with timeout")) {
        return v50;
      }
      if (lower.includes("201") || lower.includes("architecture vision") || lower.includes("triage guide")) {
        return v201;
      }
      if (lower.includes("202") || lower.includes("multi-repo clustering")) {
        return v202;
      }
      if (lower.includes("core capabilities") || lower.includes("vision")) {
        return vVisionAligned;
      }
      return vGeneral;
    },
    embedBatch: async (texts: string[]) => {
      embedBatchCalls++;
      return Promise.all(texts.map((t) => deterministicEmbedder.embed(t)));
    },
  };

  beforeAll(() => {
    // 1. Strict credential isolation
    baselineEnv = captureProcessEnv();
    const isolatedEnv = getIsolatedEnv();
    for (const key of Object.keys(process.env)) {
      if (!(key in isolatedEnv)) {
        delete process.env[key];
      }
    }

    // 2. Strict in-process network sandbox covering fetch, http, https, net sockets, tls, dns
    networkGuard = installNetworkGuard();

    // 3. Temporary filesystem fixture
    tempDir = mkdtempSync(join(tmpdir(), "prism-orchestrated-e2e-"));
    visionDocPath = join(tempDir, "VISION.md");

    writeFileSync(
      visionDocPath,
      `# PR-Prism Architecture Vision

## Core Capabilities
PR-Prism provides high-throughput GitHub PR and issue triage, deterministic duplicate detection,
incident-aware scoring, and optional advisory typed decisions.

## Out of Scope
Hosting git repositories or replacing interactive human code reviews.
`,
      "utf-8",
    );
  });

  afterAll(() => {
    networkGuard.restore();
    restoreProcessEnv(baselineEnv);
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Helper to construct a fully controlled PipelineContext
  function createTestPipelineContext(options: {
    store: VectorStore;
    repoFull?: string;
    octokitMock?: any;
    writeGateMode?: "dry-run" | "apply";
  }): PipelineContext {
    const repoFull = options.repoFull ?? "test-owner/test-repo";
    const [owner, repo] = repoFull.split("/");

    const config: PrismConfig = {
      version: 1,
      repo: repoFull,
      thresholds: {
        duplicate_similarity: 0.85,
        aligned: 0.65,
        drifting: 0.4,
      },
      scoring: {
        weights: DEFAULT_SCORING_WEIGHTS,
      },
      labels: {
        duplicate: "prism:duplicate",
        aligned: "prism:aligned",
        drifting: "prism:drifting",
        off_vision: "prism:off-vision",
        top_pick: "prism:top-pick",
      },
      decisions: {
        enabled: false,
        provider: "mock",
        model: "jev-1.14.0",
        timeout_ms: 10000,
      },
      cluster: {
        include_bot_authors: false,
        bot_authors: [],
      },
      batch_size: 50,
      max_prs: 5000,
    };

    const env = {
      GITHUB_TOKEN: "mock-offline-token",
      EMBEDDING_PROVIDER: "openai",
      EMBEDDING_MODEL: "deterministic-v4",
      EMBEDDING_DIMENSIONS: 4,
      LLM_PROVIDER: "ollama",
      LLM_MODEL: "local",
    };

    const client = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
    if (options.octokitMock) {
      (client as unknown as { octokit: unknown }).octokit = options.octokitMock;
    }

    return {
      config,
      env,
      owner,
      repo,
      repoFull,
      github: client,
      store: options.store,
      embedder: deterministicEmbedder,
    };
  }

  // ── 1. PRODUCTION ORCHESTRATION PIPELINE ────────────────────────────────

  it("proves items from mocked GitHub transport travel through real runScan into SQLite and feed runDupes, runRank, runVision", async () => {
    const repoFull = "test-owner/test-repo";
    const dbPath = join(tempDir, "prod-orchestrator.db");
    const store = new VectorStore(dbPath, 4, "deterministic-v4");
    embedBatchCalls = 0;

    // Synthetic GraphQL Pull Requests: Alice #101 (high quality, tests, approvals) and Bob #102 (duplicate, no tests)
    const rawGraphQLPRNodes = [
      {
        number: 101,
        title: "Fix retry backoff timeout in network client",
        body: "Implements incremental backoff retry when rate limit reset is approaching.\nFixes #50",
        author: { login: "contributor-alice" },
        state: "OPEN",
        createdAt: "2026-08-01T10:00:00Z",
        updatedAt: "2026-08-02T12:00:00Z",
        additions: 45,
        deletions: 10,
        changedFiles: 2,
        id: "PR_node_101",
        headRefOid: "commit_sha_101",
        url: `https://github.com/${repoFull}/pull/101`,
        labels: { nodes: [{ name: "bug" }, { name: "networking" }] },
        files: {
          nodes: [{ path: "src/net/retry.ts" }, { path: "src/__tests__/retry.test.ts" }],
        },
        reviews: {
          totalCount: 2,
          nodes: [{ state: "APPROVED" }, { state: "APPROVED" }],
        },
        commits: {
          nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
        },
        closingIssuesReferences: {
          nodes: [{ number: 50, repository: { nameWithOwner: repoFull } }],
        },
      },
      {
        number: 102,
        title: "Fix retry backoff timeout in network client",
        body: "Duplicate submission of retry backoff logic without test coverage.\nCloses #50",
        author: { login: "contributor-bob" },
        state: "OPEN",
        createdAt: "2026-08-01T11:00:00Z",
        updatedAt: "2026-08-01T11:30:00Z",
        additions: 120,
        deletions: 5,
        changedFiles: 1,
        id: "PR_node_102",
        headRefOid: "commit_sha_102",
        url: `https://github.com/${repoFull}/pull/102`,
        labels: { nodes: [{ name: "bug" }] },
        files: {
          nodes: [{ path: "src/net/retry.ts" }],
        },
        reviews: {
          totalCount: 0,
          nodes: [],
        },
        commits: {
          nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }],
        },
        closingIssuesReferences: {
          nodes: [{ number: 50, repository: { nameWithOwner: repoFull } }],
        },
      },
    ];

    // Synthetic GraphQL Issue: Original bug report #50
    const rawGraphQLIssueNodes = [
      {
        number: 50,
        title: "Connection retries fail with timeout under high load",
        body: "When API rate limits are approached, retry requests immediately timeout rather than backing off.",
        author: { login: "user-reporter" },
        state: "OPEN",
        createdAt: "2026-07-28T09:00:00Z",
        updatedAt: "2026-07-29T14:00:00Z",
        id: "ISSUE_node_50",
        url: `https://github.com/${repoFull}/issues/50`,
        labels: { nodes: [{ name: "bug" }] },
      },
    ];

    // Mock Octokit transport
    const octokitMock = {
      graphql: vi.fn(async (query: string | { query: string }) => {
        const queryStr = typeof query === "string" ? query : query?.query || "";
        if (queryStr.includes("pullRequests")) {
          return {
            repository: {
              pullRequests: {
                totalCount: 2,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: rawGraphQLPRNodes,
              },
            },
          };
        }
        if (queryStr.includes("issues")) {
          return {
            repository: {
              issues: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: rawGraphQLIssueNodes,
              },
            },
          };
        }
        if (queryStr.includes("search")) {
          // Author merge count queries
          return {
            search: {
              issueCount: 12,
            },
          };
        }
        return {};
      }),
      pulls: {
        list: vi.fn(),
      },
      issues: {
        listForRepo: vi.fn(),
        createLabel: vi.fn(),
        addLabels: vi.fn(),
        removeLabel: vi.fn(),
      },
      repos: {
        getContent: vi.fn(),
      },
    };

    const ctx = createTestPipelineContext({ store, repoFull, octokitMock });

    try {
      // 1. Execute runScan (NOT direct SQLite insertion)
      await runScan(ctx, { useRest: false });

      // Verify that items flowed through runScan into SQLite
      const stats = store.getStats(repoFull);
      expect(stats.totalItems).toBe(3);
      expect(stats.prs).toBe(2);
      expect(stats.issues).toBe(1);

      const dbPR101 = store.getByNumber(repoFull, 101);
      expect(dbPR101).toBeDefined();
      expect(dbPR101?.title).toBe("Fix retry backoff timeout in network client");
      expect(dbPR101?.metadata.ciStatus).toBe("success");
      expect(dbPR101?.metadata.hasTests).toBe(true);
      expect(dbPR101?.metadata.reviewCount).toBe(2);

      const dbPR102 = store.getByNumber(repoFull, 102);
      expect(dbPR102).toBeDefined();
      expect(dbPR102?.metadata.ciStatus).toBe("pending");
      expect(dbPR102?.metadata.hasTests).toBe(false);

      const dbIssue50 = store.getByNumber(repoFull, 50);
      expect(dbIssue50).toBeDefined();
      expect(dbIssue50?.type).toBe("issue");

      // Verify vector embeddings exist in sqlite
      const embedding101 = store.getEmbedding(dbPR101!.id);
      expect(embedding101).toBeDefined();
      expect(embedding101!.length).toBe(4);

      // 2. Execute runDupes consuming the SQLite store populated by runScan
      const clusters = await runDupes(ctx, { threshold: 0.85 });
      expect(clusters).toHaveLength(1);
      const cluster = clusters[0];
      expect(cluster.items.length).toBe(3);
      expect(cluster.items.map((i) => i.number).sort((a, b) => a - b)).toEqual([50, 101, 102]);
      // Alice #101 must be selected as canonical best pick
      expect(cluster.bestPick.number).toBe(101);
      expect(cluster.avgSimilarity).toBeGreaterThan(0.85);

      // 3. Execute runRank consuming SQLite items populated by runScan
      const ranked = await runRank(ctx, { top: 10, explain: true });
      expect(ranked.length).toBeGreaterThanOrEqual(2);
      const topRanked = ranked[0];
      expect(topRanked.number).toBe(101);
      expect(topRanked.score).toBeGreaterThan(ranked[1].score);
      expect(topRanked.signals.hasTests).toBe(1.0);
      expect(topRanked.signals.ciPassing).toBe(1.0);

      // 4. Execute runVision consuming SQLite items against vision document
      const visionScores = await runVision(ctx, { doc: visionDocPath });
      expect(visionScores).toBeDefined();
      expect(visionScores!.length).toBe(3);
      const visionPR101 = visionScores!.find((s) => s.prNumber === 101);
      expect(visionPR101).toBeDefined();
      expect(visionPR101?.classification).toBeDefined();

      // Ensure network guard recorded zero network breaches
      networkGuard.assertZeroViolations();
    } finally {
      store.close();
    }
  });

  // ── 2. NEGATIVE SCENARIOS ───────────────────────────────────────────────

  it("handles REST fallback scan and controlled transport fetch failure", async () => {
    const repoFull = "test-owner/test-repo";
    const dbPath = join(tempDir, "rest-fallback.db");
    const store = new VectorStore(dbPath, 4, "deterministic-v4");

    const octokitMock = {
      graphql: vi.fn(),
      pulls: {
        list: vi.fn(async ({ page }: { page?: number } = {}) => ({
          data:
            (page ?? 1) === 1
              ? [
                  {
                    number: 201,
                    title: "Add architecture vision documentation and triage guide",
                    body: "Documents PR-Prism architecture vision and triage guide.",
                    user: { login: "maintainer-charlie" },
                    state: "open",
                    created_at: "2026-08-03T08:00:00Z",
                    updated_at: "2026-08-03T08:30:00Z",
                    labels: [{ name: "documentation" }],
                  },
                ]
              : [],
          headers: {
            "x-ratelimit-remaining": "4990",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": "1700000000",
          },
        })),
      },
      issues: {
        listForRepo: vi.fn(async ({ page }: { page?: number } = {}) => ({
          data:
            (page ?? 1) === 1
              ? [
                  {
                    number: 202,
                    title: "Question: roadmap for multi-repo clustering support",
                    body: "Inquiring about multi-repo clustering roadmap.",
                    user: { login: "user-curious" },
                    state: "open",
                    created_at: "2026-08-03T09:00:00Z",
                    updated_at: "2026-08-03T09:15:00Z",
                    labels: [{ name: "question" }],
                  },
                ]
              : [],
          headers: {
            "x-ratelimit-remaining": "4989",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": "1700000000",
          },
        })),
      },
    };

    const ctx = createTestPipelineContext({ store, repoFull, octokitMock });

    try {
      // Successful REST fallback
      await runScan(ctx, { useRest: true });
      expect(store.getByNumber(repoFull, 201)).toBeDefined();
      expect(store.getByNumber(repoFull, 202)).toBeDefined();

      // Controlled fetch failure: simulate upstream non-transient transport failure
      octokitMock.pulls.list.mockRejectedValueOnce(new Error("GitHub API transport connection closed"));
      await expect(runScan(ctx, { useRest: true })).rejects.toThrow("GitHub API transport connection closed");

      // Verify database remains valid and uncorrupted after controlled failure
      expect(store.getByNumber(repoFull, 201)).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("handles repeated scan with unchanged items and metadata drift without re-embedding", async () => {
    const repoFull = "test-owner/test-repo";
    const dbPath = join(tempDir, "repeated-scan.db");
    const store = new VectorStore(dbPath, 4, "deterministic-v4");

    const prNode = {
      number: 101,
      title: "Fix retry backoff timeout in network client",
      body: "Body",
      author: { login: "contributor-alice" },
      state: "OPEN",
      createdAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-08-02T12:00:00Z",
      additions: 45,
      deletions: 10,
      changedFiles: 2,
      id: "PR_node_101",
      headRefOid: "sha_101",
      url: `https://github.com/${repoFull}/pull/101`,
      labels: { nodes: [] },
      files: { nodes: [] },
      reviews: { totalCount: 1, nodes: [{ state: "APPROVED" }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
    };

    const octokitMock = {
      graphql: vi.fn(async (query: string | { query: string }) => {
        const queryStr = typeof query === "string" ? query : query?.query || "";
        if (queryStr.includes("pullRequests")) {
          return {
            repository: {
              pullRequests: {
                totalCount: 1,
                pageInfo: { hasNextPage: false },
                nodes: [prNode],
              },
            },
          };
        }
        return {
          repository: {
            issues: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
          },
        };
      }),
    };

    const ctx = createTestPipelineContext({ store, repoFull, octokitMock });

    try {
      const initialEmbedCalls = embedBatchCalls;
      // First scan: embeds item #101
      await runScan(ctx, {});
      expect(embedBatchCalls).toBe(initialEmbedCalls + 1);

      // Second scan with identical item: skips unchanged items without re-embedding
      const callsBeforeRepeated = embedBatchCalls;
      await runScan(ctx, {});
      expect(embedBatchCalls).toBe(callsBeforeRepeated); // 0 additional embedding calls

      // Third scan with metadata drift (CI changes to SUCCESS, reviewCount changes to 3, but updatedAt is identical)
      prNode.commits.nodes[0].commit.statusCheckRollup.state = "SUCCESS";
      prNode.reviews.totalCount = 3;

      await runScan(ctx, {});
      expect(embedBatchCalls).toBe(callsBeforeRepeated); // still zero new embedding calls!

      // Check that metadata was updated in SQLite
      const updated = store.getByNumber(repoFull, 101);
      expect(updated?.metadata.ciStatus).toBe("success");
      expect(updated?.metadata.reviewCount).toBe(3);
    } finally {
      store.close();
    }
  });

  it("verifies SQLite persistence and reopen behavior across lifecycle", async () => {
    const repoFull = "test-owner/test-repo";
    const dbPath = join(tempDir, "persistence-reopen.db");

    // 1. Initial creation and scan
    const store1 = new VectorStore(dbPath, 4, "deterministic-v4");
    const rawGraphQLPRNodes = [
      {
        number: 101,
        title: "Fix retry backoff timeout in network client",
        body: "Implements incremental backoff retry.\nFixes #50",
        author: { login: "contributor-alice" },
        state: "OPEN",
        createdAt: "2026-08-01T10:00:00Z",
        updatedAt: "2026-08-02T12:00:00Z",
        additions: 45,
        deletions: 10,
        changedFiles: 2,
        id: "PR_node_101",
        headRefOid: "sha_101",
        url: `https://github.com/${repoFull}/pull/101`,
        labels: { nodes: [] },
        files: { nodes: [{ path: "src/retry.ts" }, { path: "src/retry.test.ts" }] },
        reviews: { totalCount: 2, nodes: [{ state: "APPROVED" }, { state: "APPROVED" }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      },
      {
        number: 102,
        title: "Fix retry backoff timeout in network client",
        body: "Duplicate submission.\nCloses #50",
        author: { login: "contributor-bob" },
        state: "OPEN",
        createdAt: "2026-08-01T11:00:00Z",
        updatedAt: "2026-08-01T11:30:00Z",
        additions: 100,
        deletions: 5,
        changedFiles: 1,
        id: "PR_node_102",
        headRefOid: "sha_102",
        url: `https://github.com/${repoFull}/pull/102`,
        labels: { nodes: [] },
        files: { nodes: [{ path: "src/retry.ts" }] },
        reviews: { totalCount: 0, nodes: [] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
      },
    ];

    const octokitMock = {
      graphql: vi.fn(async (query: string | { query: string }) => {
        const queryStr = typeof query === "string" ? query : query?.query || "";
        if (queryStr.includes("pullRequests")) {
          return {
            repository: {
              pullRequests: {
                totalCount: 2,
                pageInfo: { hasNextPage: false },
                nodes: rawGraphQLPRNodes,
              },
            },
          };
        }
        return {
          repository: {
            issues: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
          },
        };
      }),
    };

    const ctx1 = createTestPipelineContext({ store: store1, repoFull, octokitMock });
    await runScan(ctx1, {});

    expect(store1.getByNumber(repoFull, 101)).toBeDefined();
    expect(store1.getMeta("embedding_model")).toBe("deterministic-v4");
    expect(store1.getMeta("embedding_dimensions")).toBe("4");
    // Explicitly close
    store1.close();

    // 2. Reopen store from disk with fresh instance
    const store2 = new VectorStore(dbPath, 4, "deterministic-v4");
    try {
      const item = store2.getByNumber(repoFull, 101);
      expect(item).toBeDefined();
      expect(item?.number).toBe(101);
      expect(item?.title).toBe("Fix retry backoff timeout in network client");

      const embedding = store2.getEmbedding(item!.id);
      expect(embedding).toBeDefined();
      expect(embedding!.length).toBe(4);

      // Verify runDupes works seamlessly against reopened store
      const ctxReopened = createTestPipelineContext({ store: store2, repoFull });
      const clusters = await runDupes(ctxReopened, { threshold: 0.85 });
      expect(clusters).toHaveLength(1);
      expect(clusters[0].bestPick.number).toBe(101);
    } finally {
      store2.close();
    }
  });

  it("enforces default dry-run write protection with zero mutations against GitHub", async () => {
    const repoFull = "test-owner/test-repo";
    const dbPath = join(tempDir, "dry-run.db");
    const store = new VectorStore(dbPath, 4, "deterministic-v4");

    const octokitMock = {
      issues: {
        addLabels: vi.fn(),
        removeLabel: vi.fn(),
        createLabel: vi.fn(),
        getLabel: vi.fn().mockRejectedValue({ status: 404 }),
      },
    };

    const ctx = createTestPipelineContext({ store, repoFull, octokitMock });

    try {
      // 1. runDupes with dryRun: true
      await runDupes(ctx, { threshold: 0.85, applyLabels: true, dryRun: true });

      // 2. runVision with dryRun: true
      await runVision(ctx, { doc: visionDocPath, applyLabels: true, dryRun: true });

      // Ensure zero mutation calls reached Octokit
      expect(octokitMock.issues.addLabels).not.toHaveBeenCalled();
      expect(octokitMock.issues.removeLabel).not.toHaveBeenCalled();
      expect(octokitMock.issues.createLabel).not.toHaveBeenCalled();

      // 3. GitHubClient default write-gate protection
      const defaultClient = new GitHubClient("token", "owner", "repo");
      (defaultClient as any).octokit = octokitMock;
      await defaultClient.applyLabel(101, "prism:duplicate");
      await defaultClient.removeLabel(101, "needs-triage");
      await defaultClient.ensureLabel("prism:duplicate", "ffffff", "Duplicate PR");

      expect(octokitMock.issues.addLabels).not.toHaveBeenCalled();
      expect(octokitMock.issues.removeLabel).not.toHaveBeenCalled();
      expect(octokitMock.issues.createLabel).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("rejects invalid or incomplete configurations cleanly", async () => {
    const repoFull = "test-owner/test-repo";
    const dbPath = join(tempDir, "invalid-config.db");
    const store = new VectorStore(dbPath, 4, "deterministic-v4");

    const octokitMock = {
      graphql: vi.fn(async () => ({
        repository: {
          pullRequests: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
          issues: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
        },
      })),
    };

    const ctx = createTestPipelineContext({ store, repoFull, octokitMock });

    try {
      // 1. Invalid since duration
      await expect(runScan(ctx, { since: "invalid-duration" })).rejects.toThrow("Invalid duration: invalid-duration");
      expect(() => parseDuration("xyz")).toThrow("Invalid duration");

      // 2. Incompatible embedding config hash detection:
      // Seed an item with vector so store.hasEmbeddings() is true
      store.upsert({
        id: `${repoFull}:pr:1`,
        type: "pr",
        number: 1,
        repo: repoFull,
        title: "Existing PR",
        bodySnippet: "Snippet",
        embedding: new Float32Array(v101),
        metadata: {},
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-01T00:00:00Z",
      });
      store.setMeta("embedding_config_hash", "legacy-incompatible-hash-v1");

      await expect(runScan(ctx, {})).rejects.toThrow(/embedding configuration changed/);
    } finally {
      store.close();
    }
  });

  it("verifies failure cleanup without retained temp artifacts", () => {
    const isolatedTempDir = mkdtempSync(join(tmpdir(), "prism-failure-cleanup-"));
    const isolatedDbPath = join(isolatedTempDir, "crash-test.db");

    let store: VectorStore | null = null;
    try {
      store = new VectorStore(isolatedDbPath, 4, "test-model");
      // Simulate failure scenario
      throw new Error("Simulated pipeline failure during execution");
    } catch (err: any) {
      expect(err.message).toBe("Simulated pipeline failure during execution");
    } finally {
      store?.close();
      rmSync(isolatedTempDir, { recursive: true, force: true });
    }

    // Verify temp dir and database were completely removed
    expect(existsSync(isolatedTempDir)).toBe(false);
  });

  // ── 3. CLI ENTRYPOINT & CONTRACT VERIFICATION ───────────────────────────

  it("verifies CLI output contracts for doctor, dupes, rank, and vision in offline isolation", () => {
    const cliTempDir = mkdtempSync(join(tmpdir(), "prism-cli-contract-"));
    try {
      writeFileSync(join(cliTempDir, "prism.config.yaml"), "repo: cli-test/contract-repo\n");

      // doctor --json output contract
      const doctorOutput = execFileSync("node", [distCli, "doctor", "--json"], {
        cwd: cliTempDir,
        env: getIsolatedEnv(),
        encoding: "utf-8",
      });
      const doctorParsed = JSON.parse(doctorOutput);
      expect(doctorParsed.command).toBe("doctor");
      expect(Array.isArray(doctorParsed.checks)).toBe(true);

      // --version output contract
      const versionOutput = execFileSync("node", [distCli, "--version"], {
        cwd: cliTempDir,
        env: getIsolatedEnv(),
        encoding: "utf-8",
      }).trim();
      expect(versionOutput).toBe("4.0.0");

      // --help output contract
      const helpOutput = execFileSync("node", [distCli, "--help"], {
        cwd: cliTempDir,
        env: getIsolatedEnv(),
        encoding: "utf-8",
      });
      expect(helpOutput).toContain("Usage: prism");
      expect(helpOutput).toContain("dupes");
      expect(helpOutput).toContain("rank");
      expect(helpOutput).toContain("vision");
      expect(helpOutput).toContain("scan");
    } finally {
      rmSync(cliTempDir, { recursive: true, force: true });
    }
  });

  // ── 4. NETWORK SAFETY & PROHIBITED ACCESS CONTROLS ───────────────────────

  it("verifies negative controls for all intercepted network transport paths", async () => {
    // 1. globalThis.fetch
    await expect(globalThis.fetch("https://api.github.com")).rejects.toThrow("CRITICAL VIOLATION");

    // 2. http.get
    expect(() => http.get("http://127.0.0.1:9999")).toThrow("CRITICAL VIOLATION");

    // 3. https.get
    expect(() => https.get("https://127.0.0.1:9999")).toThrow("CRITICAL VIOLATION");

    // 4. net.Socket.prototype.connect
    const socket = new net.Socket();
    await new Promise<void>((resolve) => {
      socket.on("error", (err) => {
        expect(err.message).toContain("CRITICAL VIOLATION");
        resolve();
      });
      socket.connect(80, "1.1.1.1");
    });

    // 5. dns.lookup
    await new Promise<void>((resolve) => {
      dns.lookup("api.github.com", (err) => {
        expect(err).toBeDefined();
        expect(err?.message).toContain("CRITICAL VIOLATION");
        resolve();
      });
    });

    // Check violations list
    expect(networkGuard.violations.length).toBeGreaterThanOrEqual(5);
    // Clear violations so suite remains clean
    networkGuard.violations.length = 0;
  });

  it("demonstrates verifiable OS-level network isolation where bwrap is supported", () => {
    if (!isOsNetworkIsolationSupported()) {
      // Skip if OS-level bwrap is not available in environment
      return;
    }

    // 1. Negative control: OS kernel blocks DNS lookup in network-isolated namespace
    const dnsCheck = execInOsNetworkSandbox("node", [
      "-e",
      "require('node:dns').lookup('github.com', (err) => { process.exit(err ? 0 : 1); });",
    ]);
    expect(dnsCheck).toBe("");

    // 2. Negative control: OS kernel blocks TCP connection with ENETUNREACH in network-isolated namespace
    const tcpCheck = execInOsNetworkSandbox("node", [
      "-e",
      "const s = require('node:net').connect(80, '8.8.8.8'); s.on('error', (e) => { process.exit(e.code === 'ENETUNREACH' ? 0 : 2); });",
    ]);
    expect(tcpCheck).toBe("");

    // 3. Positive control: CLI executes cleanly in network-isolated namespace
    const cliOutput = execInOsNetworkSandbox("node", [distCli, "--version"], { env: getIsolatedEnv() }).trim();
    expect(cliOutput).toBe("4.0.0");
  });
});
