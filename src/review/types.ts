export interface GitHubPullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export interface GitHubPullRequestSnapshot extends GitHubPullRequestRef {
  url: string;
  repository: string;
  headSha: string;
  state: string;
}

export interface GitHubCommentAuthor {
  login: string;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  author: GitHubCommentAuthor;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface GitHubReviewComment extends GitHubIssueComment {
  reviewId: number | null;
  path: string;
  line: number | null;
}

export interface GitHubPullReview {
  id: number;
  body: string;
  author: GitHubCommentAuthor;
  submittedAt: string;
  state: string;
  url: string;
}

/** The authenticated GitHub operations needed by the Greptile service. */
export interface GitHubReviewBoundary {
  getPullRequest(
    ref: GitHubPullRequestRef,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestSnapshot>;
  listIssueComments(
    ref: GitHubPullRequestRef,
    signal?: AbortSignal,
  ): Promise<GitHubIssueComment[]>;
  createIssueComment(
    ref: GitHubPullRequestRef,
    body: string,
    signal?: AbortSignal,
  ): Promise<GitHubIssueComment>;
  listReviewComments(
    ref: GitHubPullRequestRef,
    signal?: AbortSignal,
  ): Promise<GitHubReviewComment[]>;
  listPullReviews(
    ref: GitHubPullRequestRef,
    signal?: AbortSignal,
  ): Promise<GitHubPullReview[]>;
}

export type ReviewSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface GreptileFinding {
  id: string;
  source: "review_comment" | "review" | "issue_comment";
  file: string | null;
  line: number | null;
  severity: ReviewSeverity;
  body: string;
  url: string;
}

export interface GreptileReviewInput {
  /** An existing https://github.com/{owner}/{repo}/pull/{number} URL. */
  pullRequestUrl: string;
  /** Expected base repository in owner/repo form. */
  repository: string;
  /** Caller-stable key for exactly one trigger comment for this PR and operation. */
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface GreptileReviewFeedback {
  version: 1;
  provider: "greptile";
  status: "completed" | "timed_out";
  pullRequest: {
    url: string;
    repository: string;
    number: number;
    headSha: string;
  };
  trigger: {
    commentId: number;
    url: string;
    idempotencyDigest: string;
    deduplicated: boolean;
  };
  findings: GreptileFinding[];
  remediation: {
    maxPasses: 1;
    findingLimit: number;
    truncated: boolean;
  };
}

export type GreptileReviewErrorCode =
  | "invalid_pull_request_url"
  | "invalid_repository"
  | "repository_mismatch"
  | "pull_request_not_found"
  | "invalid_idempotency_key"
  | "invalid_options"
  | "github_request_failed"
  | "trigger_outcome_unknown"
  | "aborted";

export class GreptileReviewError extends Error {
  readonly code: GreptileReviewErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(
    code: GreptileReviewErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "GreptileReviewError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}
