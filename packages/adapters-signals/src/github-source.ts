/**
 * GitHubSignalSource -- pull-style SignalSource over the public GitHub REST API via
 * `@octokit/rest`: the open, free "developer intent" replacement for the ingestion half of
 * Common Room / ZoomInfo intent data (research/tools/A-signals-ingestion.md). Produces one
 * repo-stats snapshot Signal (stars/watchers/forks) plus one Signal per recent issue, for each
 * configured repo -- all `kind: "intent"`.
 *
 * FLAG FOR SPARK: field names (`stargazers_count`, `watchers_count`, `pull_request` presence to
 * distinguish PRs from issues, `since` filtering issues by `updated_at` not `created_at`) are
 * asserted from GitHub's public REST API docs, not verified against a live call. The real
 * `Octokit` response is cast through the minimal `GitHubClientLike` structural type below (only
 * the fields this adapter actually reads) rather than asserted fully compatible with
 * @octokit/rest's generated types.
 *
 * Individual per-star events (who starred, when) would need the stargazers endpoint's special
 * `application/vnd.github.star+json` Accept header -- deliberately NOT implemented here (too
 * easy to get subtly wrong without a live call to confirm); the aggregate stats snapshot covers
 * "stars/watchers" from the task scope, and per-star history is a reasonable follow-up once
 * verified against a real GitHub response.
 */
import { Octokit } from "@octokit/rest";

import { newId, nowIso, Signal } from "@mstack/core";
import type { PullOptions, SignalSource } from "@mstack/core";

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface GitHubRepoStats {
  full_name?: string;
  stargazers_count: number;
  watchers_count: number;
  forks_count: number;
  open_issues_count: number;
}

export interface GitHubIssueRow {
  number: number;
  title: string;
  html_url: string;
  state: string;
  created_at: string;
  user?: { login: string } | null;
  /** present (any truthy value) only when the Issues API is actually returning a PR. */
  pull_request?: unknown;
}

/** The minimal slice of Octokit's REST client this adapter actually calls -- lets tests inject
 *  a plain object instead of a real `Octokit` instance / needing its full generated types. */
export interface GitHubClientLike {
  rest: {
    repos: {
      get(params: { owner: string; repo: string }): Promise<{ data: GitHubRepoStats }>;
    };
    issues: {
      listForRepo(params: {
        owner: string;
        repo: string;
        state?: "open" | "closed" | "all";
        since?: string;
        per_page?: number;
        sort?: "created" | "updated" | "comments";
        direction?: "asc" | "desc";
      }): Promise<{ data: GitHubIssueRow[] }>;
    };
  };
}

export interface GitHubSignalSourceConfig {
  name?: string;
  repos: GitHubRepoRef[];
  /** PAT; only used to construct the default Octokit client. Ignored when `octokit` is injected.
   *  Unauthenticated calls still work for public repos, just at GitHub's lower rate limit. */
  token?: string;
  /** injectable client -- pass a real `new Octokit({ auth })` or a test fake. Defaults to a
   *  real Octokit instance constructed from `token`. */
  octokit?: GitHubClientLike;
  /** cap on issues fetched per repo per pull (also the per_page sent to GitHub, itself capped at 100). */
  maxIssuesPerRepo?: number;
}

function createDefaultOctokit(token: string | undefined): GitHubClientLike {
  // Cast through unknown: we deliberately don't assert full structural compatibility with
  // @octokit/rest's generated (very large) response types -- only the fields GitHubClientLike
  // declares are ever read from what this returns.
  return new Octokit({ auth: token }) as unknown as GitHubClientLike;
}

function repoStatsSignal(owner: string, repo: string, stats: GitHubRepoStats): Signal {
  return Signal.parse({
    id: newId("sig"),
    ts: nowIso(),
    source: "github",
    kind: "intent",
    actor: { anonId: `gh:${owner}/${repo}` },
    action: "repo_stats_snapshot",
    properties: {
      repo: stats.full_name ?? `${owner}/${repo}`,
      stars: stats.stargazers_count,
      watchers: stats.watchers_count,
      forks: stats.forks_count,
      openIssues: stats.open_issues_count,
    },
    raw: stats,
  });
}

function issueSignal(owner: string, repo: string, issue: GitHubIssueRow): Signal {
  const login = issue.user?.login;
  return Signal.parse({
    id: `gh:${owner}/${repo}:issue:${issue.number}`,
    ts: issue.created_at,
    source: "github",
    kind: "intent",
    actor: login ? { handle: login } : { anonId: `gh:${owner}/${repo}:issue:${issue.number}` },
    action: "github_issue_opened",
    properties: {
      repo: `${owner}/${repo}`,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
    },
    raw: issue,
  });
}

export class GitHubSignalSource implements SignalSource {
  readonly name: string;
  readonly #repos: GitHubRepoRef[];
  readonly #client: GitHubClientLike;
  readonly #maxIssuesPerRepo: number;

  constructor(config: GitHubSignalSourceConfig) {
    this.name = config.name ?? "github";
    this.#repos = config.repos;
    this.#maxIssuesPerRepo = config.maxIssuesPerRepo ?? 20;
    this.#client = config.octokit ?? createDefaultOctokit(config.token);
  }

  async pull(opts?: PullOptions): Promise<Signal[]> {
    const perRepoIssueLimit = Math.min(opts?.limit ?? this.#maxIssuesPerRepo, this.#maxIssuesPerRepo, 100);
    const since = opts?.since;
    const signals: Signal[] = [];

    for (const { owner, repo } of this.#repos) {
      const { data: stats } = await this.#client.rest.repos.get({ owner, repo });
      signals.push(repoStatsSignal(owner, repo, stats));

      // NOTE: GitHub's Issues API filters `since` by updated_at, not created_at (a documented
      // quirk that trips people expecting "created since") -- fine here since we want "recent
      // activity", worth knowing if this is ever repurposed for "newly created only".
      const { data: issues } = await this.#client.rest.issues.listForRepo({
        owner,
        repo,
        state: "all",
        since,
        per_page: perRepoIssueLimit,
        sort: "created",
        direction: "desc",
      });
      for (const issue of issues) {
        if (issue.pull_request) continue; // the Issues API also returns PRs; we only want issues
        signals.push(issueSignal(owner, repo, issue));
      }
    }

    const limit = opts?.limit;
    return limit !== undefined ? signals.slice(0, limit) : signals;
  }
}
