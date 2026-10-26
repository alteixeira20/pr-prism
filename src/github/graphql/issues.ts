import type { PRItem } from "../../types.js";
import { normalizeGraphQLIssue } from "../normalization/items.js";
import type { FetchOptions, GitHubContext } from "../types.js";
import { ISSUES_QUERY } from "./queries.js";

export async function fetchIssuesGraphQL(context: GitHubContext, opts: FetchOptions = {}): Promise<PRItem[]> {
  const { since, state = "open", maxItems = 5000, onProgress } = opts;
  const items: PRItem[] = [];

  const gqlStates = state === "all" ? ["OPEN", "CLOSED"] : state === "closed" ? ["CLOSED"] : ["OPEN"];
  let cursor: string | null = null;
  let totalCount = 0;
  const repoFull = `${context.owner}/${context.repo}`;

  while (items.length < maxItems) {
    const result: any = await context.withBackoff(() =>
      context.octokit.graphql(ISSUES_QUERY, {
        owner: context.owner,
        repo: context.repo,
        states: gqlStates,
        cursor,
      }),
    );

    context.rateLimiter.updateFromGraphQL((result as any).extensions);

    const issues = result.repository.issues;
    totalCount = issues.totalCount;

    if (issues.nodes.length === 0) break;

    for (const issue of issues.nodes) {
      if (since && new Date(issue.updatedAt) < new Date(since)) {
        onProgress?.(items.length, items.length);
        return items;
      }

      items.push(normalizeGraphQLIssue(issue, repoFull));
    }

    onProgress?.(items.length, totalCount);

    if (!issues.pageInfo.hasNextPage) break;
    cursor = issues.pageInfo.endCursor;
  }

  return items;
}
