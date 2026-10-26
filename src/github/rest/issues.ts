import type { PRItem } from "../../types.js";
import { normalizeRestIssue } from "../normalization/items.js";
import type { FetchOptions, GitHubContext } from "../types.js";

export async function fetchIssues(context: GitHubContext, opts: FetchOptions = {}): Promise<PRItem[]> {
  const { since, state = "open", maxItems = 5000, batchSize = 50, onProgress } = opts;
  const items: PRItem[] = [];
  let page = 1;
  const repoFull = `${context.owner}/${context.repo}`;

  while (items.length < maxItems) {
    const response = await context.withBackoff(() =>
      context.octokit.issues.listForRepo({
        owner: context.owner,
        repo: context.repo,
        state: state === "all" ? "all" : state,
        sort: "updated",
        direction: "desc",
        per_page: Math.min(batchSize, 100),
        page,
      }),
    );

    context.rateLimiter.updateFromHeaders(response.headers as Record<string, string>);

    if (response.data.length === 0) break;

    for (const issue of response.data) {
      if (issue.pull_request) continue;

      if (since && new Date(issue.updated_at) < new Date(since)) {
        onProgress?.(items.length, items.length);
        return items;
      }

      items.push(normalizeRestIssue(issue, repoFull));
    }

    onProgress?.(items.length, maxItems);
    page++;
  }

  return items;
}
