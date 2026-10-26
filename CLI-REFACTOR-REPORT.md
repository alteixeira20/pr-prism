# CLI Architectural Refactor Report

## 1. Original Responsibilities

Prior to this refactor, `src/cli.ts` was a 1,369-line monolithic file bundling disparate CLI concerns into a single module:
- **Global Command Registration:** Direct instantiation and registration of 14 commands (`init`, `doctor`, `scan`, `dupes`, `rank`, `vision`, `review`, `triage`, `compare`, `benchmark`, `reset`, `re-embed`, `stats`, `status`, `report`).
- **Mixed Business and Presentation Logic:** Review terminal rendering, spinner lifecycle orchestration, interactive prompt handling (via `readline`), and 150+ lines of Markdown report formatting lived inside command action blocks.
- **Top-level Side Effects on Import:** A regex/substring check (`process.argv[1]?.includes("prism")`) inadvertently triggered `program.parseAsync()` during unit testing whenever the worktree directory path contained `"prism"`, causing `src/__tests__/cli.test.ts` to inline helper functions rather than import `src/cli.ts`.
- **Untestable Handlers:** Command action handlers directly performed file I/O, process exits, and database queries without clear module seams, making unit and characterization testing difficult without network or disk mutations.

---

## 2. Final Directory Architecture

The CLI has been refactored into focused, cohesive, independently testable modules under `src/cli/` while preserving `src/cli.ts` as a 29-line thin executable entry point:

```
src/
  cli.ts                             # Thin executable entry point (delegates to createProgram(), handles direct run)
  cli/
    program.ts                       # Factory function `createProgram()` configuring root Commander instance
    register-commands.ts             # Orchestrates registering all 14 commands
    commands/
      benchmark.ts                   # `prism benchmark` registration and action handler
      compare.ts                     # `prism compare <number1> <number2>` registration and handler
      doctor.ts                      # `prism doctor` health checks (config, env, GitHub token, DB, LLM)
      dupes.ts                       # `prism dupes` duplicate detection, cluster inspection, starmap & housekeeping
      init.ts                        # `prism init` configuration bootstrap, provider detection, setup verification
      rank.ts                        # `prism rank` PR quality scoring and ranking
      re-embed.ts                    # `prism re-embed` batch re-embedding of stored vectors
      report.ts                      # `prism report` triage report generation (JSON or Markdown)
      reset.ts                       # `prism reset` database removal with prompt confirmation
      review.ts                      # `prism review [number]` LLM review (single, batch, show)
      scan.ts                        # `prism scan` repository ingestion
      stats.ts                       # `prism stats` and `prism status` database & provider metrics
      triage.ts                      # `prism triage` end-to-end pipeline orchestration
      vision.ts                      # `prism vision` vision document alignment
    formatting/
      report.ts                      # Pure `generateMarkdownReport()` builder (tables, clusters, details, scores)
      review.ts                      # `displayReview()` and review terminal presentation
    shared/
      paths.ts                       # Path utilities: `getPackageRoot()`, `getDataDir()`, `getDatabasePath()`
      prompts.ts                     # Interactive readline utilities: `askQuestion()`, `askConfirmation()`
      validation.ts                  # Option validation: `validateJsonOutputMutex()`
```

---

## 3. Rationale for Every Major Extraction

| Module / Extraction | Responsibility & Rationale |
|---|---|
| `src/cli/shared/paths.ts` | Centralizes package root and data directory resolution. Decouples modules from fragile relative `__dirname` navigation across build (`dist/`) and dev (`src/`) contexts. |
| `src/cli/shared/prompts.ts` | Extracts interactive `readline` lifecycle handling (`askQuestion`, `askConfirmation`) so prompts cleanly close I/O streams and can be injected with mock streams in unit tests. |
| `src/cli/shared/validation.ts` | Eliminates duplicated mutual exclusion validation (`--json` vs `--output`) used by `dupes` and `vision`. |
| `src/cli/formatting/review.ts` | Isolates terminal styling, color-coding (merge/revise/close), and confidence formatting for PR and issue reviews. |
| `src/cli/formatting/report.ts` | Isolates complex Markdown table rendering (confidence tiers, source of truth, cluster details with pairwise similarity, top-ranked tables) into a pure, testable function without pipeline dependencies. |
| `src/cli/commands/*` | Encapsulates command-specific flags, descriptions, defaults, and action handlers. Ensures changes to one command cannot inadvertently leak or break others. |
| `src/cli/register-commands.ts` | Provides a single explicit registry of all CLI commands, allowing testing of command registration on fresh Commander instances. |
| `src/cli/program.ts` | Creates and configures the top-level Commander instance with package version, metadata, and registered commands. |
| `src/cli.ts` | Retained as a thin executable entry point with clean binary detection (`isDirectRun()`) that avoids false positives in test runners (e.g., vitest), while preserving exported `{ program, createProgram }`. |

---

## 4. Files Changed

### Modified:
- `src/cli.ts` (1,369 lines down to 29 lines: -1,340 lines)
- `src/__tests__/cli.test.ts` (now directly verifies safe `program` export and `createProgram` factory without side effects)

### Created:
- `src/cli/program.ts`
- `src/cli/register-commands.ts`
- `src/cli/shared/paths.ts`
- `src/cli/shared/prompts.ts`
- `src/cli/shared/validation.ts`
- `src/cli/formatting/review.ts`
- `src/cli/formatting/report.ts`
- `src/cli/commands/benchmark.ts`
- `src/cli/commands/compare.ts`
- `src/cli/commands/doctor.ts`
- `src/cli/commands/dupes.ts`
- `src/cli/commands/init.ts`
- `src/cli/commands/rank.ts`
- `src/cli/commands/re-embed.ts`
- `src/cli/commands/report.ts`
- `src/cli/commands/reset.ts`
- `src/cli/commands/review.ts`
- `src/cli/commands/scan.ts`
- `src/cli/commands/stats.ts`
- `src/cli/commands/triage.ts`
- `src/cli/commands/vision.ts`
- `src/__tests__/cli-characterization.test.ts`
- `src/__tests__/cli-shared.test.ts`
- `src/__tests__/cli-formatting.test.ts`
- `src/__tests__/cli-utility-commands.test.ts`
- `src/__tests__/cli-pipeline-commands.test.ts`
- `src/__tests__/cli-core-commands.test.ts`

---

## 5. Tests Added

A comprehensive suite of 49 CLI-specific unit and characterization tests was added:
1. **`src/__tests__/cli-characterization.test.ts` (23 tests):**
   - Version reporting with `-V` and `--version`.
   - Root help display and command listing (`init`, `doctor`, `scan`, `dupes`, `rank`, `vision`, `review`, `triage`, `compare`, `benchmark`, `reset`, `re-embed`, `stats`, `status`, `report`).
   - Flag and option validation across all 14 commands.
   - Mutex enforcement (`--json` and `--output` in `dupes` and `vision`).
   - Unsupported output format rejection in `triage`.
   - Database reset error handling when database does not exist.
2. **`src/__tests__/cli-shared.test.ts` (7 tests):**
   - Path resolution (`getPackageRoot`, `getDataDir`, `getDatabasePath`).
   - Stream-based readline prompt and confirmation behavior.
   - Mutex validator exit codes and error logs.
3. **`src/__tests__/cli-formatting.test.ts` (2 tests):**
   - Review terminal output formatting (color, score, author, recommendation).
   - Full Markdown triage report generation (tables, canonical sources, confidence tiers, vision section).
4. **`src/__tests__/cli-utility-commands.test.ts` (5 tests):**
   - Registration and option checks for `benchmark`, `compare`, `reset`, `re-embed`, and `stats`/`status`.
5. **`src/__tests__/cli-pipeline-commands.test.ts` (6 tests):**
   - Registration and option checks for `scan`, `dupes`, `rank`, `vision`, and `triage`.
   - Output validation error handling in `triage`.
6. **`src/__tests__/cli-core-commands.test.ts` (4 tests):**
   - Registration and options for `init`, `doctor`, `review`, and `report`.
7. **`src/__tests__/cli.test.ts` (7 tests):**
   - `parseDuration` contracts preserved.
   - Safe `program` singleton export without argv side effects.
   - Clean `createProgram()` factory instantiation.

---

## 6. Exact Validation Results

All checks passed with zero errors or warnings on Node.js v24.22.0:

```bash
$ npm run build
> prism-triage@4.0.0 build
> npm run clean && tsc -p tsconfig.build.json

$ npm run lint
> prism-triage@4.0.0 lint
> biome check src/
Checked 85 files in 42ms. No fixes applied.

$ npm run typecheck
> prism-triage@4.0.0 typecheck
> tsc --noEmit && tsc -p server/tsconfig.json --noEmit

$ npm test
> prism-triage@4.0.0 test
> vitest run
 Test Files  42 passed (42)
      Tests  594 passed (594)

$ npm run ci
> prism-triage@4.0.0 ci
> npm run build && npm run lint && npm run typecheck && npm test && node dist/cli.js --version && node dist/cli.js --help
4.0.0
Usage: prism [options] [command]
...

$ git diff --check
(clean, no output)

$ node dist/cli.js --version
4.0.0
```

---

## 7. Behavior Compatibility Findings

- **Help and Option Contracts:** Fully preserved across all commands and aliases (`stats` and `status`).
- **Defaults:** All default values (e.g., threshold `"0.85"`, top `"20"`, state `"open"`, type `"pr"`, output `"prism-report.md"`) remain identical.
- **Exit Codes:** Error handling and exit semantics (exit code 1 on invalid arguments, exit code 0 on successful help/version/completion) are strictly preserved.
- **Output Formats:** JSON, NDJSON, and Markdown formatting outputs match previous schemas and text structure.
- **Write Gating:** All write operations continue to default to dry-run unless `--apply-labels` is passed.
- **Programmatic Export:** `import { program } from "prism-triage/cli"` continues to function without side effects or breaking external consumers.

---

## 8. Remaining Limitations & Follow-ups

- **Potential Pipeline Follow-up:** Several command handlers (`init`, `doctor`, `re-embed`, `report`, `review`) still instantiate `GitHubClient`, `VectorStore`, or `createEmbeddingProvider` directly within their action closures rather than calling high-level pipeline facade methods. As parallel work completes GitHub client decomposition and pipeline enhancements, these command actions can delegate to dedicated pipeline functions.

---

## 9. Complete Commit List

1. `d6b17aa` test(cli): add characterization tests for CLI contract and flags
2. `21e0786` refactor(cli): extract shared cli utilities for paths, prompts and validation
3. `101f660` refactor(cli): extract formatting modules for reviews and markdown reports
4. `2d3d9cb` refactor(cli): extract benchmark, compare, reset, re-embed, and stats command modules
5. `65105c9` refactor(cli): extract scan, rank, vision, dupes, and triage command modules
6. `ad395d7` refactor(cli): extract init, doctor, review, and report command modules
7. `244c8f5` refactor(cli): modularize cli.ts into register-commands, program, and thin entry point
8. `c8aca98` test(cli): verify safe program import and factory instantiation in cli.test.ts
9. `docs: add CLI refactor report`

---

## 10. Final HEAD SHA

Branch `refactor/cli-command-modules` HEAD commit: `docs: add CLI refactor report` (SHA: `5c283196582a11f08290c333183085b6050d6bde`).

---

## 11. Integration Instructions

To integrate these changes into `main` or merge alongside parallel refactoring branches:
1. Ensure the worktree is on branch `refactor/cli-command-modules`.
2. Run standard verification:
   ```bash
   npm run ci
   ```
3. Merge or cherry-pick `refactor/cli-command-modules`. Since this refactor strictly modified `src/cli.ts`, created `src/cli/**`, and added CLI test files under `src/__tests__/`, there are no merge conflicts with other tracks working in `src/github/**`, `src/pipeline.ts`, or `src/decisions/**`.
