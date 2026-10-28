import { type Evidence, fingerprint, type Kind, type Source } from "./contracts.js";

// This transport exposes only GET. Pagination follows Link, not item-count guesses.
export class OperationsGitHub implements Source {
  health: Evidence["health"];
  constructor(
    private token: string,
    private request: typeof fetch = fetch,
    private api = "https://api.github.com",
  ) {}
  private async getJSON(route: string): Promise<{ data: any; next: string | null }> {
    const url = new URL(route, this.api);
    if (url.origin !== new URL(this.api).origin || !url.pathname.startsWith("/repos/"))
      throw new Error("Untrusted GitHub pagination URL");
    const response = await this.request(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30000),
    });
    this.health = {
      remaining: response.headers.get("x-ratelimit-remaining"),
      reset: response.headers.get("x-ratelimit-reset"),
    };
    if (!response.ok) throw new Error(`GitHub read failed (${response.status}); inventory is incomplete`);
    const next = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1] ?? null;
    return { data: await response.json(), next };
  }
  private async pages(route: string): Promise<any[]> {
    const expectedPath = new URL(route, this.api).pathname;
    let expectedPage = 1;
    const result: any[] = [];
    const seen = new Set<string>();
    let next: string | null = route;
    while (next) {
      if (seen.has(next)) throw new Error("Repeated GitHub pagination cursor");
      const url = new URL(next, this.api);
      if (url.pathname !== expectedPath || Number(url.searchParams.get("page") ?? 1) !== expectedPage++)
        throw new Error("Invalid GitHub page scope or skipped page");
      seen.add(next);
      const page = await this.getJSON(next);
      if (!Array.isArray(page.data) || (page.next && page.data.length === 0)) throw new Error("Missing GitHub page");
      result.push(...page.data);
      next = page.next;
    }
    const unique = new Map<string, any>();
    for (const item of result) {
      const identity = item.id ?? item.filename;
      if (identity === undefined) throw new Error("GitHub record missing identity");
      const old = unique.get(String(identity));
      if (old && fingerprint(old) !== fingerprint(item)) throw new Error("Inconsistent duplicate GitHub record");
      unique.set(String(identity), item);
    }
    return [...unique.values()];
  }
  private root(repo: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Expected owner/repo");
    return `/repos/${repo}`;
  }
  async inventory(repo: string, kind: Kind): Promise<number[]> {
    const items = await this.pages(
      `${this.root(repo)}/${kind === "pr" ? "pulls" : "issues"}?state=open&sort=created&direction=asc&per_page=100`,
    );
    return items
      .filter((i) => kind === "pr" || !i.pull_request)
      .map((i) => i.number)
      .sort((a, b) => a - b);
  }
  async get(repo: string, kind: Kind, number: number): Promise<Evidence> {
    const root = this.root(repo);
    const route = `${root}/${kind === "pr" ? "pulls" : "issues"}/${number}`;
    const first = (await this.getJSON(route)).data;
    if (first.number !== number || (first.base?.repo?.full_name && first.base.repo.full_name !== repo))
      throw new Error("GitHub evidence identity mismatch");
    const comments = await this.pages(`${root}/issues/${number}/comments?per_page=100`);
    const events = await this.pages(`${root}/issues/${number}/timeline?per_page=100`);
    const limitations: string[] = [];
    let files: Evidence["files"] = [];
    if (kind === "pr") {
      const raw = await this.pages(`${route}/files?per_page=100`);
      files = raw.map((f) => ({
        path: f.filename,
        previousPath: f.previous_filename,
        patch: f.patch,
        status: f.status,
      }));
      if (raw.length !== first.changed_files)
        limitations.push("Changed-file inventory incomplete (GitHub file API limit or moving snapshot)");
      for (const f of files) if (f.patch === undefined) limitations.push(`Patch unavailable: ${f.path}`);
      // REST patches may be truncated without an explicit marker; do not assert full coverage.
      limitations.push("GitHub REST patches cannot prove complete raw diff coverage; source verification required");
      events.push(...(await this.pages(`${route}/reviews?per_page=100`)));
      const checks = await this.getJSON(`${root}/commits/${first.head.sha}/status`);
      events.push({ event: "CI_changed", state: checks.data.state, statuses: checks.data.statuses });
    } else {
      // Linked fixes remain candidate evidence: resolving semantics require independent verification.
      for (const event of events) {
        const issue = event.source?.issue;
        if (issue?.pull_request?.url?.startsWith(`${this.api}${root}/pulls/`)) {
          const linked = (await this.getJSON(issue.pull_request.url)).data;
          event.linkedFix = {
            number: linked.number,
            state: linked.state,
            merged: linked.merged,
            head: linked.head?.sha,
            updatedAt: linked.updated_at,
          };
        }
      }
      limitations.push(
        "Linked fixes and duplicate claims require source verification; conversation may exclude inaccessible events",
      );
    }
    const last = (await this.getJSON(route)).data;
    if (JSON.stringify(first) !== JSON.stringify(last))
      throw new Error("GitHub metadata moved during evidence fetch; reconcile again");
    return {
      repo,
      kind,
      number,
      state: first.merged ? "merged" : first.state,
      title: first.title,
      body: first.body ?? "",
      author: first.user.login,
      createdAt: first.created_at,
      updatedAt: first.updated_at,
      head: first.head?.sha,
      base: first.base?.sha,
      draft: first.draft,
      labels: first.labels.map((l: any) => l.name),
      comments,
      events,
      files,
      limitations,
      observedAt: new Date().toISOString(),
      health: this.health,
    };
  }
}
