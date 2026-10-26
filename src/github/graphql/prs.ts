import type { PRItem } from "../../types.js";
import { normalizeGraphQLPR } from "../normalization/items.js";
import type { FetchOptions, GitHubContext } from "../types.js";
import { PRS_QUERY } from "./queries.js";

export async function fetchPRsGraphQL(context: GitHubContext, opts: FetchOptions = {}): Promise<PRItem[]> {
  const { since, state = "open", maxItems = 5000, onProgress } = opts;
  const items: PRItem[] = [];

  // Map REST state values to GraphQL enum values
  const gqlStates =
    state === "all" ? ["OPEN", "CLOSED", "MERGED"] : state === "closed" ? ["CLOSED", "MERGED"] : ["OPEN"];

  let cursor: string | null = null;
  let totalCount = 0;
  const repoFull = `${context.owner}/${context.repo}`;

  while (items.length < maxItems) {
    const result: any = await context.withBackoff(() =>
      context.octokit.graphql(PRS_QUERY, {
        owner: context.owner,
        repo: context.repo,
        states: gqlStates,
        cursor,
      }),
    );

    if (!result) {
      throw new Error("GraphQL returned empty result — check token permissions");
    }
    context.rateLimiter.updateFromGraphQL((result as any).extensions);

    const prs = result.repository?.pullRequests;
    if (!prs) {
      throw new Error(`GraphQL response missing pullRequests for ${context.owner}/${context.repo}`);
    }
    totalCount = prs.totalCount;

    if (prs.nodes.length === 0) break;

    for (const pr of prs.nodes) {
      if (since && new Date(pr.updatedAt) < new Date(since)) {
        onProgress?.(items.length, items.length);
        return items;
      }

      items.push(normalizeGraphQLPR(pr, repoFull));

      const closingTotal = pr.closingIssuesReferences?.totalCount || 0;
      const closingFetched = pr.closingIssuesReferences?.nodes?.length || 0;
      if (closingTotal > closingFetched) {
        console.warn(`warning: closing refs truncated for PR #${pr.number} (${closingFetched} of ${closingTotal})`);
      }
    }

    onProgress?.(items.length, totalCount);

    if (!prs.pageInfo.hasNextPage) break;
    cursor = prs.pageInfo.endCursor;
  }

  return items;
}
