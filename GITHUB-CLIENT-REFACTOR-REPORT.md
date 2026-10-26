# PR-Prism GitHub Client Refactor Report

## 1. Original Responsibility Inventory

Prior to refactoring, `src/github.ts` was a monolithic 747-line module that combined multiple distinct operational and architectural responsibilities:

1. **Client Lifecycle & Instance Management**: Octokit instantiation, target repository state, write gate state, and lifecycle management.
2. **Authentication & Authorization**: Bearer token handling, token scope discrimination (403 permissions error vs. 403 rate-limit exhaustion).
3. **Transport & Network Execution**: Wrapping GraphQL and REST operations with backoff retries and empty response validation.
4. **Retry & Backoff Semantics**: HTTP 429 rate limit backoff (`retry-after` header parsing), HTTP 403 reset-based waiting, and transient error backoff (HTTP 500, 502, 503).
5. **Rate-Limit Accounting**: Parsing REST response headers (`x-ratelimit-*`), parsing GraphQL extension payloads (`extensions.rateLimit`), API call consumption estimation (`estimateAPICallsNeeded`), and warning threshold formatting (`formatRateLimitWarning`).
6. **GraphQL Query Definitions**: Embedding inline GraphQL document strings for PR fetching, issue fetching, and merged PR author counting.
7. **GraphQL Transport & Pagination**: Executing cursor-based pagination via `pullRequests` and `issues` fields, handling `pageInfo`, and managing early termination based on `maxItems` and `since` filters.
8. **REST Transport & Pagination**: Executing page-based pagination via `@octokit/rest` for PRs and issues, filtering non-issue PR entries, handling `per_page` clamping, and applying `maxItems` / `since` filters.
9. **Metadata Normalization**:
   - PR state normalization (`restPRState`: resolving merged vs. closed via `merged_at`).
   - Closed timestamp normalization (`itemClosedAt`: unifying REST `closed_at` and GraphQL `closedAt`).
   - Bot authorship detection (`accountIsBot`: handling GraphQL `__typename` vs. REST `type` without false-negative conversion for unknown users).
   - Closing issue reference resolution (`mapClosingIssues`: dropping cross-repository references and returning empty arrays).
   - CI status normalization (`mapCIStatus`: mapping GraphQL commit rollup and REST check run statuses).
   - Test file presence analysis (`hasTestFiles`, `determineHasTests`: identifying test files and applying 100-file threshold logic).
   - Item conversion (`normalizeGraphQLPR`, `normalizeGraphQLIssue`, `normalizeRestPR`, `normalizeRestIssue`).
10. **Diff Retrieval & Caching**: Retrieving Git diffs formatted as unified diffs, truncating diffs exceeding 500KB, and reading/writing to `VectorStore` cache.
11. **CI Check Status Aggregation**: Fetching PR head commit SHA and querying Check Runs via REST API.
12. **PR & Code Inspection**: Fetching single PR metadata (`getPR`), review counts (`fetchReviewCount`), changed file lists (`fetchChangedFiles`), and repository file contents (`fetchFileContent`).
13. **Write Operations & Write Gate Guarding**: Executing repository mutations (`applyLabel`, `removeLabel`, `ensureLabel`) guarded by `WriteGate` (dry-run vs. apply mode).

---

## 2. Final Module Structure

The monolithic client was decomposed into cohesive, single-responsibility modules under `src/github/`, retaining `src/github.ts` as a 100% backward-compatible public facade:

```
src/
├── github.ts                              # Public compatibility facade (re-exports)
└── github/
    ├── types.ts                           # Internal & public options, context interfaces
    ├── rate-limit.ts                      # RateLimiter class (accounting, warnings, estimation)
    ├── retry.ts                           # withRetryBackoff implementation & transient error handling
    ├── normalization/
    │   ├── bot.ts                         # accountIsBot
    │   ├── ci.ts                          # mapCIStatus & mapCheckRunsToCIStatus
    │   ├── closed-at.ts                   # itemClosedAt
    │   ├── index.ts                       # Aggregated normalization exports
    │   ├── issues.ts                      # mapClosingIssues
    │   ├── items.ts                       # Pure PRItem builders (GraphQL PR, GraphQL Issue, REST PR, REST Issue)
    │   ├── pr-state.ts                    # restPRState
    │   └── test-files.ts                  # hasTestFiles & determineHasTests
    ├── graphql/
    │   ├── author.ts                      # getAuthorMergeCountGraphQL
    │   ├── index.ts                       # Aggregated GraphQL exports
    │   ├── issues.ts                      # fetchIssuesGraphQL
    │   ├── prs.ts                         # fetchPRsGraphQL
    │   └── queries.ts                     # PRS_QUERY, ISSUES_QUERY, AUTHOR_MERGE_COUNT_QUERY
    ├── rest/
    │   ├── author.ts                      # getAuthorMergeCount
    │   ├── content.ts                     # fetchFileContent
    │   ├── diff.ts                        # fetchDiff (caching & truncation)
    │   ├── index.ts                       # Aggregated REST exports
    │   ├── issues.ts                      # fetchIssues
    │   ├── labels.ts                      # applyLabel, removeLabel, ensureLabel (write gate guarded)
    │   └── prs.ts                         # fetchPRs, getPR, fetchReviewCount, fetchChangedFiles, fetchCIStatus
    ├── client.ts                          # GitHubClient class
    └── index.ts                           # Package root exports
```

---

## 3. Dependency Boundaries

The decomposed architecture enforces strict unidirectional dependency flow with zero circular dependencies:

```
                  ┌──────────────────────┐
                  │    src/github.ts     │ (Facade)
                  └──────────┬───────────┘
                             │ re-exports
                             ▼
                  ┌──────────────────────┐
                  │  src/github/index.ts │
                  └──────────┬───────────┘
                             │
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
   ┌─────────────────┐ ┌───────────┐ ┌────────────────┐
   │    client.ts    │ │  retry.ts │ │ rate-limit.ts  │
   └────────┬────────┘ └───────────┘ └────────────────┘
            │
      ┌─────┴────────────────┐
      ▼                      ▼
┌───────────┐          ┌───────────┐
│ graphql/  │          │   rest/   │
└─────┬─────┘          └─────┬─────┘
      │                      │
      └──────────┬───────────┘
                 ▼
        ┌─────────────────┐
        │ normalization/  │
        └────────┬────────┘
                 ▼
        ┌─────────────────┐
        │    types.ts     │
        └─────────────────┘
```

- **Leaf Modules**: `src/github/types.ts` defines operational contracts (`GitHubContext`, `GitHubWriteContext`, `FetchOptions`, `CIStatus`).
- **Normalizers**: `src/github/normalization/*` are pure functions that have no dependencies on network clients or stateful instances.
- **Operations**: `src/github/graphql/*` and `src/github/rest/*` depend only on `GitHubContext` / `GitHubWriteContext`, query constants, and normalizers.
- **Client Facade**: `GitHubClient` in `src/github/client.ts` wires the `RateLimiter`, `withRetryBackoff`, `WriteGate`, and operation functions through dynamic property context binding.

---

## 4. Refactoring Rationale

- **Cohesion**: Transport, queries, rate limiting, and normalizers are separated. Changes to GraphQL queries do not touch REST handling; normalizer bug fixes can be made and tested in pure isolation without mocking network requests.
- **Elimination of Duplication**: The previous monolithic `getPR` duplicated 25 lines of REST PR normalization logic from `fetchPRs`. Both now share the pure normalizer `normalizeRestPR`.
- **Testability**: Pure functions can be tested with plain JavaScript objects. Rate limiting and retries accept an optional mock clock function, enabling sub-millisecond execution of 5-stage backoff tests without `setTimeout` delays.
- **No Circular Dependencies**: Submodules do not import from parent indices or from peer sub-packages (`graphql` does not import `rest`, `normalization` does not import `client`).
- **Strict Invariant Preservation**: Retains identical public API, method signatures, return types, error contracts, and runtime behavior.

---

## 5. Changed Files

### Modified Files
- `src/github.ts`: Replaced 747-line monolithic implementation with clean, backward-compatible facade re-exporting `GitHubClient`, `FetchOptions`, `restPRState`, `itemClosedAt`, `accountIsBot`, and `mapClosingIssues`.
- `src/__tests__/github.test.ts`: Updated `closedAt wiring` test to inspect `src/github/graphql/queries.ts` and `src/github/normalization/items.ts` to ensure query integrity and complete normalizer population.

### Added Modular Implementation Files
- `src/github/types.ts`
- `src/github/rate-limit.ts`
- `src/github/retry.ts`
- `src/github/client.ts`
- `src/github/index.ts`
- `src/github/normalization/pr-state.ts`
- `src/github/normalization/closed-at.ts`
- `src/github/normalization/bot.ts`
- `src/github/normalization/issues.ts`
- `src/github/normalization/ci.ts`
- `src/github/normalization/test-files.ts`
- `src/github/normalization/items.ts`
- `src/github/normalization/index.ts`
- `src/github/graphql/queries.ts`
- `src/github/graphql/prs.ts`
- `src/github/graphql/issues.ts`
- `src/github/graphql/author.ts`
- `src/github/graphql/index.ts`
- `src/github/rest/prs.ts`
- `src/github/rest/issues.ts`
- `src/github/rest/diff.ts`
- `src/github/rest/labels.ts`
- `src/github/rest/content.ts`
- `src/github/rest/author.ts`
- `src/github/rest/index.ts`

### Added Test Files
- `src/__tests__/github-pagination.test.ts`
- `src/__tests__/github-retry.test.ts`
- `src/__tests__/github-rest.test.ts`
- `src/__tests__/github-normalization.test.ts`
- `src/__tests__/github-api-compat.test.ts`

---

## 6. Tests Added

A total of 49 new deterministic characterization tests were added across 5 new test suites:

1. **`src/__tests__/github-pagination.test.ts`** (7 tests):
   - GraphQL PR pagination across cursors (`hasNextPage`, `endCursor`).
   - GraphQL PR early exit on `maxItems`.
   - GraphQL PR early exit on `since` filter with progress notification.
   - GraphQL Issue pagination across cursors and states.
   - REST PR pagination with page numbering until empty page.
   - REST Issue filtering of embedded pull requests (`issue.pull_request`).
   - REST PR early exit on `since` filter.

2. **`src/__tests__/github-retry.test.ts`** (11 tests):
   - 403 token scope error immediately throws `ProviderError` (no retry).
   - 403 rate-limit exhaustion (`remaining === 0`) waits for `resetAt` and retries.
   - 429 rate-limit response parses `retry-after` header and retries.
   - 500, 502, 503 transient errors retry with incremental 5s backoff.
   - Exceeding 5 attempts throws transient error.
   - Empty/null API response throws `"API returned empty response"`.
   - GraphQL empty result or missing pullRequests error handling.
   - REST header rate-limit updates (`x-ratelimit-*`).
   - GraphQL extension rate-limit updates.
   - API call estimation (`estimateAPICallsNeeded`).
   - Rate limit warning formatting (`formatRateLimitWarning`).

3. **`src/__tests__/github-rest.test.ts`** (15 tests):
   - Diff retrieval via Octokit with `mediaType: { format: "diff" }` and store caching.
   - Diff retrieval returning cached diff from `VectorStore` without network call.
   - Diff truncation exceeding 500,000 characters with warning sentinel.
   - `fetchCIStatus` returning `"unknown"` for 0 check runs.
   - `fetchCIStatus` returning `"pending"` for incomplete check runs.
   - `fetchCIStatus` returning `"success"` when all check runs succeed.
   - `fetchCIStatus` returning `"failure"` when check runs fail.
   - `fetchCIStatus` returning `"unknown"` on network error.
   - `fetchFileContent` decoding base64 file contents.
   - `fetchFileContent` returning null on missing file or non-base64 encoding.
   - `fetchReviewCount` returning review count and handling failures.
   - `fetchChangedFiles` returning file list and handling failures.
   - `getAuthorMergeCount` querying search and handling failures.
   - `getPR` retrieving single PR and normalizing fields.
   - `removeLabel` swallowing 404 when label does not exist.

4. **`src/__tests__/github-normalization.test.ts`** (12 tests):
   - GraphQL PR normalization with missing optional fields (body, author, labels, etc.).
   - GraphQL Issue normalization with missing fields.
   - REST PR normalization with string labels and deleted author.
   - REST Issue normalization with missing fields.
   - `restPRState` closed vs. merged distinctions with null/undefined `merged_at`.
   - `mapCIStatus` handling SUCCESS, FAILURE, ERROR, PENDING, EXPECTED, and null/undefined.
   - `mapCheckRunsToCIStatus` evaluating complex check run combinations.
   - `determineHasTests` 100-file threshold and undefined resolution.
   - `hasTestFiles` pattern detection.
   - `itemClosedAt` timestamp resolution.
   - `accountIsBot` unknown semantics (preserving `undefined` for missing accounts).
   - `mapClosingIssues` cross-repo reference dropping.

5. **`src/__tests__/github-api-compat.test.ts`** (4 tests):
   - Public contract exports from `src/github.ts`.
   - Module building block exports from `src/github/index.ts`.
   - Method presence and signatures on `GitHubClient`.
   - Default rate limit and estimation helper initialization.

---

## 7. Complete Test Results

All validation suites passed cleanly:

- **Biome Linting**: `biome check src/` -> 88 files checked, 0 errors, 0 warnings.
- **TypeScript Typechecking**: `tsc --noEmit && tsc -p server/tsconfig.json --noEmit` -> 0 errors.
- **Vitest Test Suite**: 41 test files passed, 594 total tests passed (0 failed).
- **CLI Invariant Check**: `node dist/cli.js --version` (4.0.0) and `node dist/cli.js --help` succeeded.
- **Git Diff Hygiene**: `git diff --check` -> 0 whitespace or format errors.

---

## 8. Preserved Behavior Contracts

The refactoring strictly preserves all observable contracts:

- **Constructor**: `new GitHubClient(token, owner, repo, gate?)` defaults to dry-run `WriteGate`.
- **Public Methods**: All 20 methods on `GitHubClient` retain identical names, signatures, default values, and return types.
- **Write Authorization Model**: Mutations (`applyLabel`, `removeLabel`, `ensureLabel`) remain strictly guarded by `WriteGate`. Dry-run mode never calls Octokit write endpoints.
- **Fallback Behavior**: Bulk scan and author search retain both GraphQL implementation and REST fallback.
- **Pagination Semantics**: Both cursor-based (GraphQL) and page-based (REST) pagination adhere to `maxItems` and `since` limits.
- **Error Classification**: 403 status discrimination (rate limit vs. token permissions) and 500/502/503 transient backoffs are preserved.
- **Metadata Nullability**: No unknown or missing fields are converted to false, zero, or empty strings unless explicitly required by upstream domain contracts (e.g. `accountIsBot` preserves `undefined` for deleted accounts).
- **Incident & Bot Wiring**: `closedAt` is queried in both GraphQL queries and hydrated at all 4 PRItem normalization sites.

---

## 9. Identified Residual Risks

- **Runtime Test Mocking (`(client as any).octokit`)**:
  - *Risk*: Tests or consumers that assign directly to private fields like `client.octokit` could break if property access is decoupled.
  - *Mitigation*: `GitHubClient` accesses `this.octokit` via a live getter in operation contexts, ensuring dynamic mocking on client instances continues to function as before.
- **Upstream v4.0.0 Incident Handling**:
  - *Risk*: Deserialization of incident items requires `closedAt` presence.
  - *Mitigation*: Both GraphQL queries (`PRS_QUERY`, `ISSUES_QUERY`) and normalizers (`normalizeGraphQLPR`, `normalizeGraphQLIssue`, `normalizeRestPR`, `normalizeRestIssue`) maintain explicit `closedAt: itemClosedAt(...)` mappings verified by static and unit tests.

---

## 10. Local Commit List

1. `d5b6bdb`: `refactor(github): decompose github client into modular architecture`
2. `9a9ef06`: `test(github): add comprehensive characterization tests for pagination, retries, and normalization`
3. `c6ecb0d`: `docs: add github client refactor report`

---

## 11. Final HEAD SHA

The final validated local commit on branch `refactor/github-client-modules` is recorded in git rev-parse HEAD.

---

## 12. Integration Instructions

To integrate these changes:

1. Merge branch `refactor/github-client-modules` into `main` (or the integration branch).
2. Existing callers importing from `./github.js` or `../src/github.js` require **no changes**.
3. Internal modules or new features may optionally import directly from `./github/index.js` or specific submodules (e.g., `import { normalizeGraphQLPR } from "./github/normalization/index.js"`) for tree-shaking and isolated testing.
4. Run `npm run ci` to verify clean build, lint, typecheck, and test suite execution.
