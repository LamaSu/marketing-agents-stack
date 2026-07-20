import { describe, it, expect } from "vitest";
import { Signal } from "@mstack/core";

import { GitHubSignalSource, type GitHubClientLike } from "./github-source.js";

function fakeClient(): GitHubClientLike {
  return {
    rest: {
      repos: {
        get: async () => ({
          data: {
            full_name: "mstack/signal-adapters",
            stargazers_count: 42,
            watchers_count: 42,
            forks_count: 3,
            open_issues_count: 2,
          },
        }),
      },
      issues: {
        listForRepo: async () => ({
          data: [
            {
              number: 7,
              title: "Add SqlWarehouseSource",
              html_url: "https://github.com/mstack/signal-adapters/issues/7",
              state: "open",
              created_at: "2026-07-19T00:00:00.000Z",
              user: { login: "noramarchetti" },
            },
            {
              number: 8,
              title: "Not actually an issue",
              html_url: "https://github.com/mstack/signal-adapters/pull/8",
              state: "open",
              created_at: "2026-07-19T01:00:00.000Z",
              user: { login: "someone" },
              pull_request: { url: "https://github.com/mstack/signal-adapters/pull/8" },
            },
          ],
        }),
      },
    },
  };
}

describe("GitHubSignalSource", () => {
  it("yields a repo-stats intent Signal and an issue intent Signal, filtering out PRs", async () => {
    const source = new GitHubSignalSource({ repos: [{ owner: "mstack", repo: "signal-adapters" }], octokit: fakeClient() });
    const signals = await source.pull();

    for (const s of signals) expect(() => Signal.parse(s)).not.toThrow();
    expect(signals.every((s) => s.kind === "intent")).toBe(true);
    expect(signals.every((s) => s.source === "github")).toBe(true);

    const stats = signals.find((s) => s.action === "repo_stats_snapshot");
    expect(stats?.properties).toMatchObject({ stars: 42, watchers: 42, forks: 3, openIssues: 2 });

    const issueSignals = signals.filter((s) => s.action === "github_issue_opened");
    expect(issueSignals).toHaveLength(1); // the PR (#8) was filtered out
    expect(issueSignals[0]?.properties).toMatchObject({ number: 7 });
    expect(issueSignals[0]?.actor.handle).toBe("noramarchetti");
    expect(issueSignals[0]?.id).toBe("gh:mstack/signal-adapters:issue:7");
  });

  it('has the name "github"', () => {
    const source = new GitHubSignalSource({ repos: [], octokit: fakeClient() });
    expect(source.name).toBe("github");
  });

  it("returns no signals when repos is empty", async () => {
    const source = new GitHubSignalSource({ repos: [], octokit: fakeClient() });
    expect(await source.pull()).toEqual([]);
  });

  it("caps overall results to PullOptions.limit across multiple repos", async () => {
    const source = new GitHubSignalSource({
      repos: [
        { owner: "a", repo: "b" },
        { owner: "c", repo: "d" },
      ],
      octokit: fakeClient(),
    });
    const signals = await source.pull({ limit: 1 });
    expect(signals).toHaveLength(1);
  });
});
