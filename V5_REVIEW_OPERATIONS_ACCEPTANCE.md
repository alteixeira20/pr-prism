# V5 review operations acceptance

**Verdict: NO-GO for merging into the fork's future V5 main.** This branch is a native development preview with deterministic offline execution proof. Passing tests do not establish completion of the entire requested V5 scope.

## Source provenance

Selected ref: `fix/v4-overnight-repair`, maintained source base `6155452402e4270700c3a86d6585e24e4c8aa247`. That commit includes the merged V4 review engine, housekeeping, maintainer workflow, CLI/GitHub modularization and E2E integration. It is also the committed tip of `feat/pr-prism-v4-modernization`; `integrate/pr-prism-v4-modernization` is an older source branch. Fork main remained `e606690b7aa8e3f8a1304a72ce8c0dd43bb56a0c`; cached upstream main remained `12c8ef11d2cf4cb1e0ed79200cf5b44ee0a70e3c`. No fetch/integration was performed.

Local branch: `feat/v5-review-operations`. Isolated worktree: `~/Projects/pr-prism-v5-review-operations`. Existing path and branch were checked absent before creation. Original worktree remains on `fix/v4-overnight-repair`, preserving all dirty changes.

Dirty source provenance: four modified files (`src/cli/commands/review.ts`, `src/review-queue.ts`, `src/review-scheduler.ts`, `src/review/model-registry.ts`) and two untracked source/test files (`src/github/pr-evidence.ts`, `src/__tests__/overnight-gate-tests.test.ts`) were exported to a separate private state backup before worktree creation. They remain uncommitted in the original worktree. Their changes include evidence hydration, queue filters, attempt accounting, exports, validation and provider-specific model/benchmark settings. V5 reimplements the operations behavior in separate modules; the dirty patch was deliberately not applied wholesale, including its provider benchmark configuration. Operator `overnight/` data was neither copied into this branch nor modified.

## Changes

- New `src/review-operations/contracts.ts`, `store.ts`, `github.ts`, `runner.ts`, `cli.ts` implement typed evidence/batches, dedicated SQLite queue/ledger, GET-only GitHub reconciliation, bounded execution and native snapshots/dashboard.
- `src/cli/commands/review.ts` adds `--all-open`, `--operations-db`, `--max-new-calls`, `--run-id`, `--output-dir`, `--dashboard`, `--refresh`, and routes V5 `--status`; legacy explicit `--queue-db --status` remains supported. `--type`, `--dry-run`, `--resume`, `--json` apply to the new route. Ambiguous single-item and legacy execution flag combinations are rejected.
- New `src/__tests__/review-operations-v5.test.ts` exercises inventories, races, budgets, checkpoints, fake compiled CLI execution and terminal shutdown.
- Existing `cli-behavior.test.ts` now isolates reset path environment variables and awaits its async command. Existing `v4-e2e-integration.test.ts` replaces a dangerous hard-coded live-baseline writable constructor with an explicit disposable SQLite read-only negative control and sentinel. Store, cluster and metadata regression fixtures use `mkdtemp` before cleanup.
- README, design and offline import plan describe local usage and limitations. Package files include the V5 documents. Embedding benchmark implementation is unchanged.

## Verification

Validation results and tested implementation commit are recorded below after final checks. Only fixed fake GitHub/model payloads are used. No credentials or source payloads enter version control.

The first isolated CI run exposed two inherited test issues: the baseline test attempted a writable constructor against operator state, blocked by the read-only mount; the reset test inherited a shared test database override. Both were fixed. Subsequent regression CI passed. External filesystem paths were read-only under `bwrap`; network was disabled and credentials removed. The standalone OS denial negative control returned `NETWORK_DENIED` with exit 0; this is actual Linux namespace isolation, not merely bwrap executable discovery.

Compiled CLI fixture proof runs in `mkdtemp` with a preload intercepting every fetch. Unexpected destinations and any GitHub method other than GET throw. It executes inventory dry-run (zero attempts), two bounded fake model calls, a partial coverage export, `--status --json` and non-TTY `--dashboard --json`. Direct TTY shutdown additionally preserves the runner's durable ownership. Existing characterization and integration suites cover review/top/show registration, scan/triage and the unchanged embedding benchmark.

Race simulations include changed head/base/body/comments or merged/closed state before dispatch; merge between batches and immediately after the final batch; issue closed while queued; opened/omitted membership during discovery; reopen with the original evidence identity; concurrent mixed PR/issue claims; three fake workers; account contention across SQLite connections; budget-stop resume; model fingerprint mismatch; expired worker with an uncheckpointed charged reservation. Every confirmed pre-dispatch state change sends zero additional calls; final merge prevents current completion. A 264k-character fixture produces 13 evidence batches including metadata and reconstructs every supplied patch character exactly. Binary/unavailable evidence remains limited. Provider 401/402/403/429, timeout and schema failures are charged once and never automatically retried. Unknown model action fields and unrelated evidence references are rejected.

## Remaining acceptance blockers

1. Full reconciliation is used on every invocation. Overlapping incremental windows, periodic full reconciliation scheduling and economical conditional freshness fetches are not implemented. An inventory that consistently omits the same remote item on both enumerations cannot be proven complete by this adapter.
2. REST patches cannot prove complete raw changed-file coverage. Actual PR reviews remain partial; issues also retain explicit conversation/link verification limitations. A source-backed raw diff adapter, hunk-aware context budgeting and stronger semantic source-line validation are needed before full-coverage claims. Exact character offsets and supplied text coverage are implemented.
3. Events are preserved and approvals do not universally skip reviews, but repository review-rule policy, precise external issue-resolution classification and complete CI/check-suite/protection semantics need additional adapters and tests. A linked fix is a candidate, never permission to close an issue.
4. Expired workers pause with retained attempts; explicit audited recovery is not implemented. Cross-process execution is tested through competing database connections and three async workers, not SIGKILL of separate worker processes at every crash boundary. Consistent account IDs across processes are required; aliases for the same provider account are not detected automatically.
5. Dashboard JSON includes current counts, historical stale jobs, active ownership, account leases, ledger, latest checkpoints, sync/rate observations and reported model timings/spend. TTY presentation is basic. Active evidence batch presentation, event-specific since-scan counters, robust resize tests, batch-complexity ETA ranges and active-run-specific bounded ETA need further work. Costs are absent unless a provider supplies an adapter result; the default compatible provider does not parse proprietary cost fields.
6. Findings remain unverified claims. Prompt framing is not proof of injection resistance. Future action execution is deliberately absent; current branch cannot verify execution-time CI/protection rules for a nonexistent write path.
7. Import is a documented offline reversible proposal only; no existing live draft or SQLite import has occurred. Existing V4 draft/maintainer consumers do not automatically consume V5 records.
8. Node 24 validation is recorded; a Node 22 compatibility run remains required. Model changes do not automatically invalidate already completed jobs during inventory; operator-selected model-specific re-review planning needs an explicit command.

## Non-mutation and runner observation

The reference runner source declares version 1.2.0. Process listing observed its bounded `--run-remaining --max-new-calls 80 --continue-on-error` parent and the reference dashboard active before development and after regression testing. These observations are read-only and do not establish backlog completion or current coverage. No live logs, responses or production databases were imported. The attempted inherited baseline write was denied by an OS read-only mount before database configuration could succeed. The test was then removed from all live paths.

No live operator data, paid providers, installed releases, global npm installation, fork main, upstream or Odysseus GitHub records were mutated. No GitHub write, push, PR, approval, merge, branch deletion or release occurred. Local source commits on this feature branch and disposable validation/package directories are the only intended development writes beyond the private repair backup.
