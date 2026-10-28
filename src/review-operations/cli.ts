import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { getDataDir } from "../cli/shared/paths.js";
import type { Kind } from "./contracts.js";
import { OperationsGitHub } from "./github.js";
import { paidModel, reconcile, runOperations } from "./runner.js";
import { OperationsStore } from "./store.js";

export function renderSnapshot(value: ReturnType<OperationsStore["snapshot"]>): string {
  const safe = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  return safe(
    `${value.repo} | ${value.type}\nCurrent ${value.counts.completed_current ?? 0}/${value.totalOpen} open | pending ${value.counts.pending ?? 0} | stale ${value.counts.stale ?? 0} | partial ${value.counts.partial ?? 0} | failed ${value.counts.failed ?? 0}\nExternally resolved ${value.externallyHandled} | blocked ${value.blocked} | workers ${value.workers.length}\nRuns ${JSON.stringify(value.runs)}\nActive ${JSON.stringify(value.active)} | accounts ${JSON.stringify(value.workers)}\nCheckpoints ${JSON.stringify(value.latestCheckpoints)}\nRate limit ${JSON.stringify(value.rateLimit)}\nSync ${JSON.stringify(value.sync)}\nEstimated ETA: bounded stop ${value.eta.boundedStopSeconds ?? "N/A"}s | backlog ${value.eta.backlogSeconds ?? "N/A"}s\n`,
  );
}
const accountSchema = z
  .array(
    z
      .object({
        id: z.string().min(1),
        model: z.string().min(1),
        endpoint: z.url().refine((s) => new URL(s).protocol === "https:", "HTTPS endpoint required"),
        keyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
      })
      .strict(),
  )
  .min(1)
  .max(3);
export async function operationsCLI(opts: any) {
  if (opts.type !== "pr" && opts.type !== "issue") throw new Error("--type must be pr or issue");
  if (!opts.repo) throw new Error("--repo owner/repo is required for V5 operations");
  const kind: Kind = opts.type;
  const file = resolve(opts.operationsDb ?? resolve(getDataDir(), "review-operations-v5.sqlite"));
  const inspecting = opts.status || opts.dashboard;
  if (inspecting) {
    const refresh = Number(opts.refresh);
    if (!Number.isFinite(refresh) || refresh < 0.1) throw new Error("--refresh must be >=0.1 seconds");
    const display = () => {
      if (!existsSync(file)) {
        console.log(JSON.stringify({ repo: opts.repo, type: kind, state: "not_initialized", paidCalls: 0 }));
        return;
      }
      const store = new OperationsStore(file, true);
      try {
        const value = store.snapshot(opts.repo, kind);
        if (opts.json || !process.stdout.isTTY) console.log(JSON.stringify(value));
        else {
          if (opts.dashboard) process.stdout.write("\x1b[2J\x1b[H");
          console.log(renderSnapshot(value));
        }
      } finally {
        store.close();
      }
    };
    display();
    if (opts.dashboard && process.stdout.isTTY && !opts.json)
      await new Promise<void>((done) => {
        const timer = setInterval(display, refresh * 1000);
        const stop = () => {
          clearInterval(timer);
          process.removeListener("SIGINT", stop);
          done();
        };
        process.once("SIGINT", stop);
      });
    return;
  }
  if (!opts.allOpen) throw new Error("--all-open is required to run V5 operations");
  if (
    opts.queueDb ||
    opts.top ||
    opts.show ||
    opts.verifyAccounts ||
    opts.model ||
    opts.tier ||
    opts.maxJobs ||
    opts.maxTokens ||
    opts.prsOnly ||
    opts.issuesOnly
  )
    throw new Error("V5 operations cannot be combined with legacy queue/review modes");
  // Dry run exits before account configuration or provider initialization.
  const budget = Number(opts.maxNewCalls);
  const accounts = opts.dryRun ? [] : accountSchema.parse(JSON.parse(process.env.PRISM_REVIEW_ACCOUNTS ?? "[]"));
  if (!opts.dryRun && (!Number.isSafeInteger(budget) || budget < 0))
    throw new Error("Explicit --max-new-calls nonnegative integer required");
  if (!opts.dryRun && accounts.some((a) => !process.env[a.keyEnv]))
    throw new Error("Missing configured account credential");
  if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required for read-only inventory");
  if (!opts.dryRun && opts.resume && !opts.runId) throw new Error("--resume requires the original --run-id and budget");
  const store = new OperationsStore(file);
  try {
    const source = new OperationsGitHub(process.env.GITHUB_TOKEN);
    await reconcile(store, source, opts.repo, kind);
    let snapshot = store.snapshot(opts.repo, kind);
    if (!opts.dryRun) {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      try {
        snapshot = await runOperations({
          store,
          source,
          model: paidModel,
          accounts,
          repo: opts.repo,
          kind,
          runId: opts.runId ?? crypto.randomUUID(),
          budget,
          output: resolve(opts.outputDir ?? resolve(getDataDir(), "review-operations-drafts")),
          signal: controller.signal,
        });
      } finally {
        process.removeListener("SIGINT", stop);
      }
    }
    if (opts.json || !process.stdout.isTTY) console.log(JSON.stringify({ ...snapshot, dryRun: Boolean(opts.dryRun) }));
    else console.log(renderSnapshot(snapshot));
  } finally {
    store.close();
  }
}
