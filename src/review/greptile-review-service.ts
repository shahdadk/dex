import { createHash } from "node:crypto";
import { redactMemoryString } from "../memory/redaction.js";
import { GitHubRestError } from "./github-rest-client.js";
import {
  GreptileReviewError,
  type GitHubIssueComment,
  type GitHubPullRequestRef,
  type GitHubPullReview,
  type GitHubReviewBoundary,
  type GitHubReviewComment,
  type GreptileFinding,
  type GreptileReviewFeedback,
  type GreptileReviewInput,
  type ReviewSeverity,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_INITIAL_POLL_MS = 5_000;
const DEFAULT_MAX_POLL_MS = 30_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_MAX_FINDINGS = 25;
const DEFAULT_MAX_BODY_CHARS = 8_000;
const DEFAULT_GREPTILE_LOGINS = ["greptile-apps[bot]"] as const;

export type ReviewSleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface GreptileReviewServiceOptions {
  github: GitHubReviewBoundary;
  timeoutMs?: number;
  initialPollIntervalMs?: number;
  maxPollIntervalMs?: number;
  backoffFactor?: number;
  maxFindings?: number;
  maxFindingBodyChars?: number;
  greptileAuthorLogins?: readonly string[];
  now?: () => number;
  sleep?: ReviewSleep;
}

interface ValidatedInvocation {
  ref: GitHubPullRequestRef;
  repository: string;
  pullRequestUrl: string;
  idempotencyDigest: string;
  marker: string;
  signal?: AbortSignal;
}

interface Baseline {
  issueComments: Map<number, string>;
  reviewComments: Map<number, string>;
  reviews: Set<number>;
}

interface PollSnapshot {
  issueComments: GitHubIssueComment[];
  reviewComments: GitHubReviewComment[];
  reviews: GitHubPullReview[];
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

function invalidUrl(): never {
  throw new GreptileReviewError(
    "invalid_pull_request_url",
    "A canonical HTTPS GitHub pull request URL is required",
  );
}

export function parseGitHubPullRequestUrl(value: string): GitHubPullRequestRef & { url: string } {
  if (typeof value !== "string" || value.length === 0) return invalidUrl();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidUrl();
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return invalidUrl();
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    segments.length !== 4 ||
    segments[2] !== "pull" ||
    !OWNER_PATTERN.test(segments[0] ?? "") ||
    !REPO_PATTERN.test(segments[1] ?? "") ||
    !/^[1-9]\d*$/.test(segments[3] ?? "") ||
    url.pathname !== `/${segments.join("/")}`
  ) {
    return invalidUrl();
  }
  const number = Number(segments[3]);
  if (!Number.isSafeInteger(number)) return invalidUrl();
  const owner = segments[0]!;
  const repo = segments[1]!;
  return {
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

function parseRepository(value: string): { owner: string; repo: string; fullName: string } {
  if (typeof value !== "string") {
    throw new GreptileReviewError("invalid_repository", "Repository must use owner/repo form");
  }
  const segments = value.split("/");
  if (
    segments.length !== 2 ||
    !OWNER_PATTERN.test(segments[0] ?? "") ||
    !REPO_PATTERN.test(segments[1] ?? "")
  ) {
    throw new GreptileReviewError("invalid_repository", "Repository must use owner/repo form");
  }
  return { owner: segments[0]!, repo: segments[1]!, fullName: value };
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new GreptileReviewError("aborted", "Greptile review was aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new GreptileReviewError("aborted", "Greptile review was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function integerOption(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new GreptileReviewError(
      "invalid_options",
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function triggerIdentity(repository: string, number: number, key: string): {
  digest: string;
  marker: string;
} {
  const digest = createHash("sha256")
    .update("dex-greptile-review\0")
    .update(repository.toLowerCase())
    .update("\0")
    .update(String(number))
    .update("\0")
    .update(key)
    .digest("hex");
  return {
    digest,
    marker: `<!-- dex:greptile-review:${digest} -->`,
  };
}

function baseline(snapshot: PollSnapshot): Baseline {
  return {
    issueComments: new Map(snapshot.issueComments.map((comment) => [comment.id, comment.updatedAt])),
    reviewComments: new Map(snapshot.reviewComments.map((comment) => [comment.id, comment.updatedAt])),
    reviews: new Set(snapshot.reviews.map((review) => review.id)),
  };
}

function afterTrigger(timestamp: string, triggerTimestamp: number): boolean {
  return Date.parse(timestamp) >= triggerTimestamp;
}

function changedIssueComment(
  comment: GitHubIssueComment,
  initial: Baseline,
  deduplicated: boolean,
  triggerTimestamp: number,
): boolean {
  if (deduplicated) {
    return afterTrigger(comment.createdAt, triggerTimestamp) ||
      afterTrigger(comment.updatedAt, triggerTimestamp);
  }
  return !initial.issueComments.has(comment.id) ||
    initial.issueComments.get(comment.id) !== comment.updatedAt;
}

function changedReviewComment(
  comment: GitHubReviewComment,
  initial: Baseline,
  deduplicated: boolean,
  triggerTimestamp: number,
): boolean {
  if (deduplicated) {
    return afterTrigger(comment.createdAt, triggerTimestamp) ||
      afterTrigger(comment.updatedAt, triggerTimestamp);
  }
  return !initial.reviewComments.has(comment.id) ||
    initial.reviewComments.get(comment.id) !== comment.updatedAt;
}

function changedReview(
  review: GitHubPullReview,
  initial: Baseline,
  deduplicated: boolean,
  triggerTimestamp: number,
): boolean {
  return deduplicated
    ? afterTrigger(review.submittedAt, triggerTimestamp)
    : !initial.reviews.has(review.id);
}

function inferSeverity(body: string): ReviewSeverity {
  const prefix = body.slice(0, 1_500);
  if (/\bP0\b/i.test(prefix) || /\bseverity\s*[:=-]\s*critical\b/i.test(prefix)) return "critical";
  if (/\bP1\b/i.test(prefix) || /\bseverity\s*[:=-]\s*high\b/i.test(prefix)) return "high";
  if (/\bP2\b/i.test(prefix) || /\bseverity\s*[:=-]\s*medium\b/i.test(prefix)) return "medium";
  if (/\bP3\b/i.test(prefix) || /\bseverity\s*[:=-]\s*low\b/i.test(prefix)) return "low";
  return "unknown";
}

function materialBody(body: string): boolean {
  return inferSeverity(body) !== "unknown" ||
    /\b(?:must fix|should fix|bug|incorrect|vulnerab\w*|data loss|crash|race condition)\b/i.test(body);
}

function boundedRedacted(value: string, maximum: number): string {
  const redacted = redactMemoryString(value).replace(/\r\n/g, "\n").trim();
  if (redacted.length <= maximum) return redacted;
  return `${redacted.slice(0, Math.max(0, maximum - 14)).trimEnd()}\n[TRUNCATED]`;
}

function commentUrl(value: string, ref: GitHubPullRequestRef, fallback: string): string {
  try {
    const parsed = new URL(value);
    const prefix = `/${ref.owner}/${ref.repo}/pull/${ref.number}`.toLowerCase();
    if (
      parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === "github.com" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname.toLowerCase().startsWith(prefix)
    ) {
      return parsed.toString();
    }
  } catch {
    // Fall back to the already validated PR URL.
  }
  return fallback;
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

function compareFindings(left: GreptileFinding, right: GreptileFinding): number {
  const severity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severity !== 0) return severity;
  const leftFile = left.file ?? "\uffff";
  const rightFile = right.file ?? "\uffff";
  if (leftFile !== rightFile) return leftFile < rightFile ? -1 : 1;
  const line = (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER);
  if (line !== 0) return line;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function normalizeInlineFinding(
  comment: GitHubReviewComment,
  ref: GitHubPullRequestRef,
  pullRequestUrl: string,
  maxBodyChars: number,
): GreptileFinding | null {
  const body = boundedRedacted(comment.body, maxBodyChars);
  if (body.length === 0) return null;
  return {
    id: `review-comment:${comment.id}`,
    source: "review_comment",
    file: boundedRedacted(comment.path, 1_000),
    line: comment.line,
    severity: inferSeverity(body),
    body,
    url: commentUrl(comment.url, ref, pullRequestUrl),
  };
}

function normalizeTopLevelFinding(
  source: "review" | "issue_comment",
  id: number,
  bodyValue: string,
  url: string,
  ref: GitHubPullRequestRef,
  pullRequestUrl: string,
  maxBodyChars: number,
): GreptileFinding | null {
  const body = boundedRedacted(bodyValue, maxBodyChars);
  if (body.length === 0 || !materialBody(body)) return null;
  return {
    id: `${source.replace("_", "-")}:${id}`,
    source,
    file: null,
    line: null,
    severity: inferSeverity(body),
    body,
    url: commentUrl(url, ref, pullRequestUrl),
  };
}

function asReviewError(error: unknown): GreptileReviewError {
  if (error instanceof GreptileReviewError) return error;
  if (error instanceof GitHubRestError) {
    if (error.code === "aborted") {
      return new GreptileReviewError("aborted", "Greptile review was aborted");
    }
    return new GreptileReviewError(
      "github_request_failed",
      "Authenticated GitHub review request failed",
      {
        ...(error.status === undefined ? {} : { status: error.status }),
        retryable: !error.ambiguous && (error.status === 429 || (error.status ?? 0) >= 500),
      },
    );
  }
  return new GreptileReviewError("github_request_failed", "Authenticated GitHub review request failed");
}

export class GreptileReviewService {
  readonly #github: GitHubReviewBoundary;
  readonly #timeoutMs: number;
  readonly #initialPollIntervalMs: number;
  readonly #maxPollIntervalMs: number;
  readonly #backoffFactor: number;
  readonly #maxFindings: number;
  readonly #maxFindingBodyChars: number;
  readonly #greptileLogins: ReadonlySet<string>;
  readonly #now: () => number;
  readonly #sleep: ReviewSleep;
  readonly #inFlight = new Map<string, Promise<GreptileReviewFeedback>>();

  constructor(options: GreptileReviewServiceOptions) {
    if (!options.github) {
      throw new GreptileReviewError("invalid_options", "A GitHub review boundary is required");
    }
    this.#timeoutMs = integerOption(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 1, 30 * 60_000);
    this.#initialPollIntervalMs = integerOption(
      options.initialPollIntervalMs ?? DEFAULT_INITIAL_POLL_MS,
      "initialPollIntervalMs",
      1,
      60_000,
    );
    this.#maxPollIntervalMs = integerOption(
      options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_MS,
      "maxPollIntervalMs",
      this.#initialPollIntervalMs,
      120_000,
    );
    this.#maxFindings = integerOption(options.maxFindings ?? DEFAULT_MAX_FINDINGS, "maxFindings", 1, 100);
    this.#maxFindingBodyChars = integerOption(
      options.maxFindingBodyChars ?? DEFAULT_MAX_BODY_CHARS,
      "maxFindingBodyChars",
      100,
      50_000,
    );
    const factor = options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
    if (!Number.isFinite(factor) || factor < 1 || factor > 4) {
      throw new GreptileReviewError("invalid_options", "backoffFactor must be between 1 and 4");
    }
    const logins = options.greptileAuthorLogins ?? DEFAULT_GREPTILE_LOGINS;
    if (
      logins.length === 0 ||
      logins.some((login) => typeof login !== "string" || login.length === 0 || /[\r\n]/.test(login))
    ) {
      throw new GreptileReviewError("invalid_options", "At least one valid Greptile author login is required");
    }
    this.#github = options.github;
    this.#backoffFactor = factor;
    this.#greptileLogins = new Set(logins.map((login) => login.toLowerCase()));
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  review(input: GreptileReviewInput): Promise<GreptileReviewFeedback> {
    const invocation = this.#validateInput(input);
    const inFlight = this.#inFlight.get(invocation.idempotencyDigest);
    if (inFlight !== undefined) return inFlight;
    const operation = this.#run(invocation).finally(() => {
      if (this.#inFlight.get(invocation.idempotencyDigest) === operation) {
        this.#inFlight.delete(invocation.idempotencyDigest);
      }
    });
    this.#inFlight.set(invocation.idempotencyDigest, operation);
    return operation;
  }

  #validateInput(input: GreptileReviewInput): ValidatedInvocation {
    const parsedUrl = parseGitHubPullRequestUrl(input.pullRequestUrl);
    const expected = parseRepository(input.repository);
    if (!sameRepository(`${parsedUrl.owner}/${parsedUrl.repo}`, expected.fullName)) {
      throw new GreptileReviewError(
        "repository_mismatch",
        "Pull request URL does not match the expected repository",
      );
    }
    if (
      typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey.length < 1 ||
      input.idempotencyKey.length > 256 ||
      input.idempotencyKey.trim() !== input.idempotencyKey ||
      /[\u0000-\u001f\u007f]/.test(input.idempotencyKey)
    ) {
      throw new GreptileReviewError(
        "invalid_idempotency_key",
        "Idempotency key must be 1 to 256 printable characters",
      );
    }
    if (input.signal?.aborted) {
      throw new GreptileReviewError("aborted", "Greptile review was aborted");
    }
    const identity = triggerIdentity(expected.fullName, parsedUrl.number, input.idempotencyKey);
    return {
      ref: { owner: expected.owner, repo: expected.repo, number: parsedUrl.number },
      repository: expected.fullName,
      pullRequestUrl: parsedUrl.url,
      idempotencyDigest: identity.digest,
      marker: identity.marker,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }

  async #snapshot(ref: GitHubPullRequestRef, signal?: AbortSignal): Promise<PollSnapshot> {
    const [issueComments, reviewComments, reviews] = await Promise.all([
      this.#github.listIssueComments(ref, signal),
      this.#github.listReviewComments(ref, signal),
      this.#github.listPullReviews(ref, signal),
    ]);
    return { issueComments, reviewComments, reviews };
  }

  #isGreptile(login: string): boolean {
    return this.#greptileLogins.has(login.toLowerCase());
  }

  async #run(invocation: ValidatedInvocation): Promise<GreptileReviewFeedback> {
    let pullRequest;
    let initialSnapshot: PollSnapshot;
    try {
      pullRequest = await this.#github.getPullRequest(invocation.ref, invocation.signal);
      initialSnapshot = await this.#snapshot(invocation.ref, invocation.signal);
    } catch (error) {
      if (error instanceof GitHubRestError && error.status === 404) {
        throw new GreptileReviewError("pull_request_not_found", "GitHub pull request was not found", {
          status: 404,
        });
      }
      throw asReviewError(error);
    }
    const returnedUrl = parseGitHubPullRequestUrl(pullRequest.url);
    if (
      pullRequest.number !== invocation.ref.number ||
      !sameRepository(pullRequest.repository, invocation.repository) ||
      !sameRepository(`${returnedUrl.owner}/${returnedUrl.repo}`, invocation.repository) ||
      returnedUrl.number !== invocation.ref.number
    ) {
      throw new GreptileReviewError(
        "repository_mismatch",
        "GitHub pull request identity did not match the requested repository",
      );
    }

    const initial = baseline(initialSnapshot);
    const priorTriggers = initialSnapshot.issueComments
      .filter((comment) => comment.body.includes(invocation.marker))
      .sort((left, right) => left.id - right.id);
    let triggerComment = priorTriggers[0];
    const deduplicated = triggerComment !== undefined;
    if (triggerComment === undefined) {
      try {
        triggerComment = await this.#github.createIssueComment(
          invocation.ref,
          `@greptileai\n\n${invocation.marker}`,
          invocation.signal,
        );
      } catch (error) {
        if (error instanceof GitHubRestError && error.ambiguous) {
          throw new GreptileReviewError(
            "trigger_outcome_unknown",
            "Greptile trigger outcome is unknown; the trigger was not retried",
            error.status === undefined ? {} : { status: error.status },
          );
        }
        throw asReviewError(error);
      }
    }

    const triggerTimestamp = Date.parse(triggerComment.createdAt);
    const deadline = this.#now() + this.#timeoutMs;
    let pollInterval = this.#initialPollIntervalMs;
    let latestFindings: GreptileFinding[] = [];

    for (;;) {
      if (invocation.signal?.aborted) {
        throw new GreptileReviewError("aborted", "Greptile review was aborted");
      }
      if (this.#now() >= deadline) {
        return this.#feedback(
          "timed_out",
          invocation,
          pullRequest.headSha,
          triggerComment,
          deduplicated,
          latestFindings,
        );
      }

      let current: PollSnapshot;
      try {
        current = await this.#snapshot(invocation.ref, invocation.signal);
      } catch (error) {
        throw asReviewError(error);
      }
      const changedReviews = current.reviews.filter((review) =>
        this.#isGreptile(review.author.login) &&
        changedReview(review, initial, deduplicated, triggerTimestamp)
      );
      const changedInline = current.reviewComments.filter((comment) =>
        this.#isGreptile(comment.author.login) &&
        changedReviewComment(comment, initial, deduplicated, triggerTimestamp)
      );
      const changedIssues = current.issueComments.filter((comment) =>
        this.#isGreptile(comment.author.login) &&
        changedIssueComment(comment, initial, deduplicated, triggerTimestamp)
      );

      const inlineFindings = changedInline
        .map((comment) => normalizeInlineFinding(
          comment,
          invocation.ref,
          invocation.pullRequestUrl,
          this.#maxFindingBodyChars,
        ))
        .filter((finding): finding is GreptileFinding => finding !== null);
      const fallbackFindings = inlineFindings.length > 0 ? [] : [
        ...changedReviews.map((review) => normalizeTopLevelFinding(
          "review",
          review.id,
          review.body,
          review.url,
          invocation.ref,
          invocation.pullRequestUrl,
          this.#maxFindingBodyChars,
        )),
        ...changedIssues.map((comment) => normalizeTopLevelFinding(
          "issue_comment",
          comment.id,
          comment.body,
          comment.url,
          invocation.ref,
          invocation.pullRequestUrl,
          this.#maxFindingBodyChars,
        )),
      ].filter((finding): finding is GreptileFinding => finding !== null);
      latestFindings = [...inlineFindings, ...fallbackFindings].sort(compareFindings);

      const summaryComplete = changedIssues.some((comment) => /\bGreptile Summary\b/i.test(comment.body));
      if (changedReviews.length > 0 || summaryComplete) {
        return this.#feedback(
          "completed",
          invocation,
          pullRequest.headSha,
          triggerComment,
          deduplicated,
          latestFindings,
        );
      }

      const remaining = deadline - this.#now();
      if (remaining <= 0) continue;
      try {
        await this.#sleep(Math.min(pollInterval, remaining), invocation.signal);
      } catch (error) {
        if (
          invocation.signal?.aborted ||
          (error instanceof GreptileReviewError && error.code === "aborted")
        ) {
          throw new GreptileReviewError("aborted", "Greptile review was aborted");
        }
        throw asReviewError(error);
      }
      pollInterval = Math.min(
        this.#maxPollIntervalMs,
        Math.max(pollInterval, Math.ceil(pollInterval * this.#backoffFactor)),
      );
    }
  }

  #feedback(
    status: "completed" | "timed_out",
    invocation: ValidatedInvocation,
    headSha: string,
    triggerComment: GitHubIssueComment,
    deduplicated: boolean,
    allFindings: GreptileFinding[],
  ): GreptileReviewFeedback {
    const findings = allFindings.slice(0, this.#maxFindings);
    return {
      version: 1,
      provider: "greptile",
      status,
      pullRequest: {
        url: invocation.pullRequestUrl,
        repository: invocation.repository,
        number: invocation.ref.number,
        headSha: boundedRedacted(headSha, 128),
      },
      trigger: {
        commentId: triggerComment.id,
        url: commentUrl(triggerComment.url, invocation.ref, invocation.pullRequestUrl),
        idempotencyDigest: invocation.idempotencyDigest,
        deduplicated,
      },
      findings,
      remediation: {
        maxPasses: 1,
        findingLimit: this.#maxFindings,
        truncated: allFindings.length > findings.length,
      },
    };
  }
}
