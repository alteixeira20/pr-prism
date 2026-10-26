import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { getRepos, loadConfig, loadEnvConfig, parseRepo } from "../../config.js";
import { createEmbeddingProvider } from "../../embeddings.js";
import { GitHubClient } from "../../github.js";
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
    .option("--json", "Output results as JSON")
    .action(async (numberArg: string | undefined, opts) => {
      const config = loadConfig();
      const env = loadEnvConfig();
      const repoStr = opts.repo || config.repo || getRepos(config)[0];
      const { owner, repo } = parseRepo(repoStr);
      const repoFull = `${owner}/${repo}`;

      const github = new GitHubClient(env.GITHUB_TOKEN, owner, repo);
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
