import { describe, expect, it, vi } from "vitest";
import {
  GitHubRestError,
  GitHubRestReviewClient,
  GreptileReviewError,
  GreptileReviewService,
  parseGitHubPullRequestUrl,
  type GitHubIssueComment,
  type GitHubPullRequestRef,
  type GitHubPullRequestSnapshot,
  type GitHubPullReview,
  type GitHubReviewBoundary,
  type GitHubReviewComment,
} from "../src/review/index.js";

const PR_URL = "https://github.com/shahdadk/dex/pull/42";
const CREATED_AT = "2026-08-23T16:00:00.000Z";

function issueComment(
  id: number,
  body: string,
  author = "dex-user",
  createdAt = CREATED_AT,
): GitHubIssueComment {
  return {
    id,
    body,
    author: { login: author },
    createdAt,
    updatedAt: createdAt,
    url: `${PR_URL}#issuecomment-${id}`,
  };
}

function reviewComment(
  id: number,
  body: string,
  author = "greptile-apps[bot]",
  path = "src/checkout.ts",
): GitHubReviewComment {
  return {
    ...issueComment(id, body, author, "2026-08-23T16:00:01.000Z"),
    reviewId: 900,
    path,
    line: id,
  };
}

function pullReview(
  id: number,
  body: string,
  author = "greptile-apps[bot]",
): GitHubPullReview {
  return {
    id,
    body,
    author: { login: author },
    submittedAt: "2026-08-23T16:00:01.000Z",
    state: "COMMENTED",
    url: `${PR_URL}#pullrequestreview-${id}`,
  };
}

class FakeGitHub implements GitHubReviewBoundary {
  issueComments: GitHubIssueComment[] = [];
  reviewComments: GitHubReviewComment[] = [];
  reviews: GitHubPullReview[] = [];
  readonly createIssueComment = vi.fn(async (_ref: GitHubPullRequestRef, body: string) => {
    const comment = issueComment(100 + this.issueComments.length, body);
    this.issueComments.push(comment);
    return comment;
  });

  async getPullRequest(ref: GitHubPullRequestRef): Promise<GitHubPullRequestSnapshot> {
    return {
      ...ref,
      url: PR_URL,
      repository: "shahdadk/dex",
      headSha: "a".repeat(40),
      state: "open",
    };
  }

  async listIssueComments(): Promise<GitHubIssueComment[]> {
    return [...this.issueComments];
  }

  async listReviewComments(): Promise<GitHubReviewComment[]> {
    return [...this.reviewComments];
  }

  async listPullReviews(): Promise<GitHubPullReview[]> {
    return [...this.reviews];
  }
}

function input(signal?: AbortSignal) {
  return {
    pullRequestUrl: PR_URL,
    repository: "shahdadk/dex",
    idempotencyKey: "task-checkout:commit-abc",
    ...(signal === undefined ? {} : { signal }),
  };
}

describe("Greptile review integration", () => {
  it("accepts only canonical HTTPS GitHub pull request URLs", () => {
    expect(parseGitHubPullRequestUrl(PR_URL)).toEqual({
      owner: "shahdadk",
      repo: "dex",
      number: 42,
      url: PR_URL,
    });
    for (const value of [
      "http://github.com/shahdadk/dex/pull/42",
      `${PR_URL}/`,
      `${PR_URL}?diff=split`,
      `${PR_URL}#discussion_r1`,
      "https://github.com/shahdadk/dex/issues/42",
      "https://github.com/shahdadk/dex/pull/0",
      "https://github.com/shahdadk/dex/pull/9007199254740992",
      "https://evil.example/shahdadk/dex/pull/42",
    ]) {
      expect(() => parseGitHubPullRequestUrl(value), value).toThrowError(
        expect.objectContaining({ code: "invalid_pull_request_url" }),
      );
    }
  });

  it("validates the canonical repository identity returned by GitHub", async () => {
    const github = new FakeGitHub();
    github.getPullRequest = vi.fn(async (ref) => ({
      ...ref,
      url: "https://github.com/attacker/dex/pull/42",
      repository: "attacker/dex",
      headSha: "b".repeat(40),
      state: "open",
    }));
    const service = new GreptileReviewService({ github, timeoutMs: 1 });
    await expect(service.review(input())).rejects.toMatchObject({ code: "repository_mismatch" });
    expect(github.createIssueComment).not.toHaveBeenCalled();
  });

  it("coalesces concurrent triggers and reuses the durable marker on later calls", async () => {
    const github = new FakeGitHub();
    let now = Date.parse(CREATED_AT);
    const service = new GreptileReviewService({
      github,
      timeoutMs: 1_000,
      initialPollIntervalMs: 1,
      maxPollIntervalMs: 1,
      now: () => now,
      sleep: async () => {
        now += 1;
        github.reviews = [pullReview(501, "Greptile review complete")];
      },
    });

    const first = service.review(input());
    const concurrent = service.review(input());
    expect(concurrent).toBe(first);
    const firstResult = await first;
    expect(firstResult.trigger.deduplicated).toBe(false);
    expect(github.createIssueComment).toHaveBeenCalledTimes(1);

    const secondResult = await service.review(input());
    expect(secondResult.trigger).toMatchObject({
      commentId: firstResult.trigger.commentId,
      idempotencyDigest: firstResult.trigger.idempotencyDigest,
      deduplicated: true,
    });
    expect(github.createIssueComment).toHaveBeenCalledTimes(1);
  });

  it("uses bounded polling and returns a deterministic timeout", async () => {
    const github = new FakeGitHub();
    let now = 10_000;
    const sleeps: number[] = [];
    const service = new GreptileReviewService({
      github,
      timeoutMs: 12,
      initialPollIntervalMs: 5,
      maxPollIntervalMs: 8,
      backoffFactor: 2,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await expect(service.review(input())).resolves.toMatchObject({ status: "timed_out", findings: [] });
    expect(sleeps).toEqual([5, 7]);
  });

  it("filters authors and normalizes, redacts, sorts, and caps material findings", async () => {
    const github = new FakeGitHub();
    let now = Date.parse(CREATED_AT);
    const service = new GreptileReviewService({
      github,
      timeoutMs: 100,
      initialPollIntervalMs: 1,
      maxPollIntervalMs: 1,
      maxFindings: 2,
      maxFindingBodyChars: 100,
      now: () => now,
      sleep: async () => {
        now += 1;
        github.reviewComments = [
          reviewComment(3, "P2: should fix medium issue", "greptile-apps[bot]", "src/z.ts"),
          reviewComment(1, `P0: must fix OPENAI_API_KEY=sk-${"x".repeat(40)} ${"a".repeat(120)}`),
          reviewComment(2, "P1: should fix high issue", "greptile-apps[bot]", "src/a.ts"),
          reviewComment(4, "P0: malicious author", "attacker[bot]", "src/evil.ts"),
        ];
        github.reviews = [pullReview(800, "done")];
      },
    });

    const result = await service.review(input());
    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((finding) => finding.severity)).toEqual(["critical", "high"]);
    expect(result.findings.every((finding) => finding.file !== "src/evil.ts")).toBe(true);
    expect(result.findings[0]?.body).toContain("[REDACTED]");
    expect(result.findings[0]?.body).not.toContain("sk-");
    expect(result.findings[0]?.body.length).toBeLessThanOrEqual(100);
    expect(result.remediation).toEqual({ maxPasses: 1, findingLimit: 2, truncated: true });
  });

  it("honors aborts and wraps unexpected polling failures", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const untouched = new FakeGitHub();
    const service = new GreptileReviewService({ github: untouched });
    expect(() => service.review(input(preAborted.signal))).toThrowError(
      expect.objectContaining({ code: "aborted" }),
    );
    expect(untouched.createIssueComment).not.toHaveBeenCalled();

    const github = new FakeGitHub();
    let now = 0;
    const failing = new GreptileReviewService({
      github,
      timeoutMs: 10,
      initialPollIntervalMs: 1,
      maxPollIntervalMs: 1,
      now: () => now,
      sleep: async () => {
        now += 1;
        throw new Error("private implementation detail");
      },
    });
    await expect(failing.review(input())).rejects.toMatchObject({
      code: "github_request_failed",
      message: "Authenticated GitHub review request failed",
    });
  });

  it("never retries an ambiguous GitHub POST outcome", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("socket closed after write");
    });
    const client = new GitHubRestReviewClient({ token: "github-token-value", fetch: fetchImpl });

    await expect(client.createIssueComment(
      { owner: "shahdadk", repo: "dex", number: 42 },
      "@greptileai",
    )).rejects.toMatchObject({
      code: "network_failure",
      ambiguous: true,
    } satisfies Partial<GitHubRestError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("marks malformed success responses and in-flight POST aborts as ambiguous", async () => {
    const malformedFetch = vi.fn(async () => new Response("{}", {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    const malformedClient = new GitHubRestReviewClient({
      token: "github-token-value",
      fetch: malformedFetch,
    });
    await expect(malformedClient.createIssueComment(
      { owner: "shahdadk", repo: "dex", number: 42 },
      "@greptileai",
    )).rejects.toMatchObject({ code: "invalid_response", ambiguous: true });
    expect(malformedFetch).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const abortedFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      })
    );
    const abortedClient = new GitHubRestReviewClient({
      token: "github-token-value",
      fetch: abortedFetch,
    });
    const pending = abortedClient.createIssueComment(
      { owner: "shahdadk", repo: "dex", number: 42 },
      "@greptileai",
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted", ambiguous: true });
    expect(abortedFetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces ambiguous trigger outcomes without issuing a second POST", async () => {
    const github = new FakeGitHub();
    github.createIssueComment.mockRejectedValueOnce(
      new GitHubRestError("request_timeout", "timed out", { ambiguous: true }),
    );
    const service = new GreptileReviewService({ github });

    await expect(service.review(input())).rejects.toMatchObject({
      code: "trigger_outcome_unknown",
      retryable: false,
    } satisfies Partial<GreptileReviewError>);
    expect(github.createIssueComment).toHaveBeenCalledTimes(1);
  });
});
