import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { getRepos, loadConfig, loadEnvConfig, parseRepo } from "../../config.js";
import { assertReadOnlyGitHubClient, reviewIssueDeep, reviewPRDeep } from "../../deep-reviewer.js";
import { createEmbeddingProvider } from "../../embeddings.js";
import { GitHubClient } from "../../github.js";
import { DurableReviewQueue } from "../../review-queue.js";
import {
  loadMultiAccountProfilesFromEnv,
  MultiProviderReviewScheduler,
  verifyAccountsIndependently,
} from "../../review-scheduler.js";
import { reviewPR } from "../../reviewer.js";
import { VectorStore } from "../../store.js";
import type { PRItem, ReviewResult } from "../../types.js";
import { displayReview } from "../formatting/review.js";

export function registerReviewCommand(program: Command): void {
  program
    .command("review [number]")
    .description("Deep LLM review of a PR or issue")
    .option("-m, --model <model>", "Override LLM model")
    .option("-r, --repo <owner/repo>", "Repository")
    .option("-n, --top <number>", "Batch review top N ranked items")
    .option("--show <number>", "Show a previously saved review")
    .option("--type <type>", "Item type: pr or issue", "pr")
    .option("--deep", "Use Stage E grounded deep review schema (PR diff findings / dedicated Issue schema)")
    .option("--verify-accounts", "Verify multi-account provider credentials independently before execution")
    .option("--queue-db <path>", "Run or inspect durable multi-provider SQLite review queue")
    .option("--json", "Output results as JSON")
    .action(async (numberArg: string | undefined, opts) => {
      if (opts.verifyAccounts) {
        const profiles = loadMultiAccountProfilesFromEnv(process.env);
        const report = await verifyAccountsIndependently(profiles);
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(
            chalk.bold(
              `Pre-flight Account Verification (${report.activeAccountCount}/${report.totalAccountCount} active):`,
            ),
          );
          for (const acct of report.accounts) {
            const badge = acct.ok ? chalk.green("PASS") : chalk.red(`FAIL (${acct.status})`);
            console.log(
              `  - ${acct.accountId} [${acct.provider}/${acct.model}] key_sha256=${acct.keyFingerprint}: ${badge} (${acct.latencyMs}ms)${
                acct.errorMessage ? ` — ${acct.errorMessage}` : ""
              }`,
            );
          }
        }
        if (!report.allAuthenticated) {
          process.exitCode = 1;
        }
        return;
      }

      if (opts.queueDb && !numberArg && !opts.top && !opts.show) {
        const queue = new DurableReviewQueue(opts.queueDb);
        try {
          const stats = queue.getQueueStats();
          const usage = queue.getUsageSummaryByAccount();
          const profiles = loadMultiAccountProfilesFromEnv(process.env);
          if (profiles.length === 0) {
            if (opts.json) {
              console.log(JSON.stringify({ stats, usage }, null, 2));
            } else {
              console.log(chalk.bold("Durable Review Queue Status:"), stats);
            }
            return;
          }
          const preflight = await verifyAccountsIndependently(profiles);
          if (!preflight.allAuthenticated) {
            console.error(
              chalk.yellow(
                `Launch Gate 3 Blocker: Only ${preflight.activeAccountCount}/${preflight.totalAccountCount} configured accounts authenticated. Leaving durable queue resumable without launching unattended batch.`,
              ),
            );
            if (opts.json) {
              console.log(JSON.stringify({ launchGateBlocked: true, preflight, stats, usage }, null, 2));
            }
            process.exitCode = 2;
            return;
          }
          const scheduler = new MultiProviderReviewScheduler(queue, profiles);
          const runResult = await scheduler.run();
          if (opts.json) {
            console.log(
              JSON.stringify(
                { runResult, stats: queue.getQueueStats(), usage: queue.getUsageSummaryByAccount() },
                null,
                2,
              ),
            );
          } else {
            console.log(chalk.green("Multi-provider review queue run completed:"), runResult);
          }
        } finally {
          queue.close();
        }
        return;
      }

      const config = loadConfig();
      const env = loadEnvConfig();
      const repoStr = opts.repo || config.repo || getRepos(config)[0];
      const { owner, repo } = parseRepo(repoStr);
      const repoFull = `${owner}/${repo}`;

      const github = assertReadOnlyGitHubClient(new GitHubClient(env.GITHUB_TOKEN, owner, repo));
      const embedder = await createEmbeddingProvider({
        provider: env.EMBEDDING_PROVIDER,
        apiKey: env.EMBEDDING_API_KEY,
        model: env.EMBEDDING_MODEL,
        baseUrl: env.EMBEDDING_BASE_URL,
        dimensions: env.EMBEDDING_DIMENSIONS,
      });
      const store = new VectorStore(undefined, embedder.dimensions, env.EMBEDDING_MODEL);

      try {
        // --show: display a saved review
        if (opts.show) {
          const num = parseInt(opts.show, 10);
          const saved = store.getReview(repoFull, num);
          if (!saved) {
            console.log(chalk.red(`No saved review for #${num}. Run \`prism review ${num}\` first.`));
            return;
          }
          if (opts.json) {
            console.log(JSON.stringify(saved));
          } else {
            displayReview(num, `(${saved.type})`, saved, { provider: saved.provider, model: saved.model });
          }
          return;
        }

        // --top N: batch review
        if (opts.top) {
          const topN = parseInt(opts.top, 10) || 5;
          const items = store.getAllItems(repoFull) as unknown as PRItem[];
          const filtered =
            opts.type === "issue" ? items.filter((i) => i.type === "issue") : items.filter((i) => i.type === "pr");
          const sorted = filtered
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
            .slice(0, topN);

          console.log(chalk.bold(`Reviewing top ${sorted.length} ${opts.type}s...\n`));
          for (const item of sorted) {
            const reviewSpinner = ora(`Reviewing #${item.number}...`).start();
            try {
              let result: ReviewResult;
              if (item.type === "pr") {
                const diff = await github.fetchDiff(item.number, store);
                result = await reviewPR(item.title, item.body, diff, {
                  provider: env.LLM_PROVIDER,
                  apiKey: env.LLM_API_KEY,
                  model: opts.model || env.LLM_MODEL,
                  baseUrl: env.LLM_BASE_URL,
                });
              } else {
                result = await reviewPR(item.title, item.body, "(no diff - this is an issue, not a PR)", {
                  provider: env.LLM_PROVIDER,
                  apiKey: env.LLM_API_KEY,
                  model: opts.model || env.LLM_MODEL,
                  baseUrl: env.LLM_BASE_URL,
                });
              }
              store.saveReview(repoFull, item.number, item.type, env.LLM_PROVIDER, opts.model || env.LLM_MODEL, result);
              reviewSpinner.succeed(`#${item.number} reviewed`);

              if (opts.json) {
                console.log(JSON.stringify({ number: item.number, type: item.type, ...result }));
              } else {
                displayReview(item.number, item.title, result, {
                  author: item.author,
                  additions: item.additions,
                  deletions: item.deletions,
                });
              }
            } catch (e: any) {
              reviewSpinner.fail(`#${item.number} failed: ${e.message?.slice(0, 80)}`);
            }
          }
          return;
        }

        // Single review
        if (!numberArg) {
          console.error(chalk.red("Provide a PR/issue number, --top N for batch, or --show N for history"));
          process.exit(1);
        }

        const num = parseInt(numberArg, 10);
        const isIssue = opts.type === "issue";

        if (isIssue) {
          // Issue review
          const spinner = ora(`Fetching issue #${num}...`).start();
          const items = store.getAllItems(repoFull) as unknown as PRItem[];
          const issue = items.find((i) => i.number === num && i.type === "issue");
          if (!issue) {
            spinner.fail(`Issue #${num} not found in database. Run \`prism scan\` first.`);
            return;
          }
          spinner.succeed(`Loaded issue #${num}`);

          const reviewSpinner = ora(`Reviewing with ${opts.model || env.LLM_MODEL}...`).start();
          if (opts.deep) {
            const deepResult = await reviewIssueDeep(issue, {
              llmConfig: {
                provider: env.LLM_PROVIDER,
                apiKey: env.LLM_API_KEY,
                model: opts.model || env.LLM_MODEL,
                baseUrl: env.LLM_BASE_URL,
              },
              gitHubClient: github,
            });
            reviewSpinner.succeed("Deep issue review complete");
            if (opts.json) {
              console.log(JSON.stringify(deepResult, null, 2));
            } else {
              console.log(chalk.bold(`\nIssue #${num} Deep Review (${deepResult.issueAction}):`));
              console.log(`  Summary: ${deepResult.summary}`);
              console.log(`  Validity: ${deepResult.validityAssessment}`);
              console.log(`  Root Cause / Design: ${deepResult.rootCauseOrDesignAnalysis}`);
              console.log(`  Confidence: ${deepResult.confidence}`);
            }
            return;
          }
          const result = await reviewPR(issue.title, issue.body, "(no diff - this is an issue, not a PR)", {
            provider: env.LLM_PROVIDER,
            apiKey: env.LLM_API_KEY,
            model: opts.model || env.LLM_MODEL,
            baseUrl: env.LLM_BASE_URL,
          });
          store.saveReview(repoFull, num, "issue", env.LLM_PROVIDER, opts.model || env.LLM_MODEL, result);
          reviewSpinner.succeed("Review complete");

          if (opts.json) {
            console.log(JSON.stringify({ number: num, type: "issue", ...result }));
          } else {
            displayReview(num, issue.title, result, { author: issue.author });
          }
        } else {
          // PR review
          const spinner = ora(`Fetching PR #${num}...`).start();
          let pr: PRItem;
          try {
            pr = await github.getPR(num);
          } catch {
            spinner.fail(`PR #${num} not found`);
            return;
          }

          spinner.text = `Fetching diff for #${num}...`;
          const diff = await github.fetchDiff(num, store);
          spinner.succeed(`Loaded PR #${num}`);

          const reviewSpinner = ora(`Reviewing with ${opts.model || env.LLM_MODEL}...`).start();
          if (opts.deep) {
            const deepResult = await reviewPRDeep(
              { ...pr, diffText: diff },
              {
                llmConfig: {
                  provider: env.LLM_PROVIDER,
                  apiKey: env.LLM_API_KEY,
                  model: opts.model || env.LLM_MODEL,
                  baseUrl: env.LLM_BASE_URL,
                },
                gitHubClient: github,
              },
            );
            reviewSpinner.succeed("Deep PR review complete");
            if (opts.json) {
              console.log(JSON.stringify(deepResult, null, 2));
            } else {
              console.log(chalk.bold(`\nPR #${num} Deep Review (${deepResult.recommendation}):`));
              console.log(`  Summary: ${deepResult.summary}`);
              console.log(`  Findings: ${deepResult.findings.length}`);
              console.log(`  Confidence: ${deepResult.confidence}`);
            }
            return;
          }
          const result = await reviewPR(pr.title, pr.body, diff, {
            provider: env.LLM_PROVIDER,
            apiKey: env.LLM_API_KEY,
            model: opts.model || env.LLM_MODEL,
            baseUrl: env.LLM_BASE_URL,
          });
          store.saveReview(repoFull, num, "pr", env.LLM_PROVIDER, opts.model || env.LLM_MODEL, result);
          reviewSpinner.succeed("Review complete");

          if (opts.json) {
            console.log(JSON.stringify({ number: num, type: "pr", ...result }));
          } else {
            displayReview(num, pr.title, result, {
              author: pr.author,
              additions: pr.additions,
              deletions: pr.deletions,
            });
          }
        }
      } finally {
        store.close();
      }
    });
}
