import type {
  GitHubIssueComment,
  GitHubPullRequestRef,
  GitHubPullRequestSnapshot,
  GitHubPullReview,
  GitHubReviewBoundary,
  GitHubReviewComment,
} from "./types.js";

export const GITHUB_REST_API_VERSION = "2026-03-10";
const GITHUB_API_ROOT = "https://api.github.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PAGES = 10;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type GitHubFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type GitHubRestErrorCode =
  | "network_failure"
  | "request_timeout"
  | "http_error"
  | "invalid_response"
  | "pagination_limit"
  | "aborted";

export class GitHubRestError extends Error {
  readonly code: GitHubRestErrorCode;
  readonly status: number | undefined;
  readonly ambiguous: boolean;

  constructor(
    code: GitHubRestErrorCode,
    message: string,
    options: { status?: number; ambiguous?: boolean } = {},
  ) {
    super(message);
    this.name = "GitHubRestError";
    this.code = code;
    this.status = options.status;
    this.ambiguous = options.ambiguous ?? false;
  }
}

export interface GitHubRestReviewClientOptions {
  token: string;
  fetch?: GitHubFetch;
  requestTimeoutMs?: number;
  maxPages?: number;
  userAgent?: string;
}

interface JsonResponse {
  json: unknown;
  headers: Headers;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubRestError("invalid_response", "GitHub returned an invalid response");
  }
  return value as JsonRecord;
}

function stringField(value: JsonRecord, field: string, allowEmpty = false): string {
  const result = value[field];
  if (typeof result !== "string" || (!allowEmpty && result.length === 0)) {
    throw new GitHubRestError("invalid_response", "GitHub returned an invalid response");
  }
  return result;
}

function nullableStringField(value: JsonRecord, field: string): string {
  const result = value[field];
  if (result === null) return "";
  return stringField(value, field, true);
}

function positiveIntegerField(value: JsonRecord, field: string): number {
  const result = value[field];
  if (!Number.isSafeInteger(result) || (result as number) < 1) {
    throw new GitHubRestError("invalid_response", "GitHub returned an invalid response");
  }
  return result as number;
}

function nullablePositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function timestampField(value: JsonRecord, field: string): string {
  const result = stringField(value, field);
  if (!Number.isFinite(Date.parse(result))) {
    throw new GitHubRestError("invalid_response", "GitHub returned an invalid response");
  }
  return result;
}

function author(value: JsonRecord): { login: string } {
  return { login: stringField(record(value.user), "login") };
}

function parseIssueComment(value: unknown): GitHubIssueComment {
  const item = record(value);
  return {
    id: positiveIntegerField(item, "id"),
    body: nullableStringField(item, "body"),
    author: author(item),
    createdAt: timestampField(item, "created_at"),
    updatedAt: timestampField(item, "updated_at"),
    url: stringField(item, "html_url"),
  };
}

function parseReviewComment(value: unknown): GitHubReviewComment {
  const item = record(value);
  const parsed = parseIssueComment(item);
  const line = nullablePositiveInteger(item.line) ??
    nullablePositiveInteger(item.original_line) ??
    nullablePositiveInteger(item.start_line) ??
    nullablePositiveInteger(item.original_start_line);
  return {
    ...parsed,
    reviewId: nullablePositiveInteger(item.pull_request_review_id),
    path: stringField(item, "path"),
    line,
  };
}

function parsePullReview(value: unknown): GitHubPullReview {
  const item = record(value);
  return {
    id: positiveIntegerField(item, "id"),
    body: nullableStringField(item, "body"),
    author: author(item),
    submittedAt: timestampField(item, "submitted_at"),
    state: stringField(item, "state"),
    url: stringField(item, "html_url"),
  };
}

function validRef(ref: GitHubPullRequestRef): void {
  if (
    typeof ref.owner !== "string" || ref.owner.length === 0 ||
    typeof ref.repo !== "string" || ref.repo.length === 0 ||
    !Number.isSafeInteger(ref.number) || ref.number < 1
  ) {
    throw new TypeError("A valid GitHub pull request reference is required");
  }
}

function endpoint(ref: GitHubPullRequestRef, suffix: string): URL {
  validRef(ref);
  return new URL(
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}${suffix}`,
    GITHUB_API_ROOT,
  );
}

function hasNextPage(headers: Headers): boolean {
  return /<[^>]+>;\s*rel="next"/.test(headers.get("link") ?? "");
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new GitHubRestError("invalid_response", "GitHub response exceeded the size limit");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new GitHubRestError("invalid_response", "GitHub response exceeded the size limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class GitHubRestReviewClient implements GitHubReviewBoundary {
  readonly #token: string;
  readonly #fetch: GitHubFetch;
  readonly #requestTimeoutMs: number;
  readonly #maxPages: number;
  readonly #userAgent: string;

  constructor(options: GitHubRestReviewClientOptions) {
    if (
      typeof options.token !== "string" ||
      options.token.length === 0 ||
      options.token.trim() !== options.token ||
      /[\u0000-\u001f\u007f\s]/.test(options.token)
    ) {
      throw new TypeError("A valid GitHub token is required");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
      throw new RangeError("GitHub request timeout must be between 1 and 120000 milliseconds");
    }
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
      throw new RangeError("GitHub pagination limit must be between 1 and 100 pages");
    }
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxPages = maxPages;
    this.#userAgent = options.userAgent ?? "dex-greptile-review";
  }

  async getPullRequest(
    ref: GitHubPullRequestRef,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestSnapshot> {
    const { json } = await this.#request(endpoint(ref, `/pulls/${ref.number}`), "GET", undefined, signal);
    const item = record(json);
    const base = record(item.base);
    const baseRepo = record(base.repo);
    const head = record(item.head);
    return {
      owner: ref.owner,
      repo: ref.repo,
      number: positiveIntegerField(item, "number"),
      url: stringField(item, "html_url"),
      repository: stringField(baseRepo, "full_name"),
      headSha: stringField(head, "sha"),
      state: stringField(item, "state"),
    };
  }

  listIssueComments(
    ref: GitHubPullRequestRef,
    signal?: AbortSignal,
  ): Promise<GitHubIssueComment[]> {
    return this.#list(ref, `/issues/${ref.number}/comments`, parseIssueComment, signal);
  }

  async createIssueComment(
    ref: GitHubPullRequestRef,
    body: string,
    signal?: AbortSignal,
  ): Promise<GitHubIssueComment> {
    if (typeof body !== "string" || body.length === 0) {
      throw new TypeError("A non-empty GitHub comment body is required");
    }
    const response = await this.#request(
      endpoint(ref, `/issues/${ref.number}/comments`),
      "POST",
      JSON.stringify({ body }),
      signal,
    );
    try {
      return parseIssueComment(response.json);
    } catch (error) {
      if (error instanceof GitHubRestError) {
        throw new GitHubRestError(error.code, error.message, {
          ...(error.status === undefined ? {} : { status: error.status }),
          ambiguous: true,
        });
      }
      throw error;
    }
  }

  listReviewComments(
    ref: GitHubPullRequestRef,
    signal?: AbortSignal,
  ): Promise<GitHubReviewComment[]> {
    return this.#list(ref, `/pulls/${ref.number}/comments`, parseReviewComment, signal);
  }

  listPullReviews(
    ref: GitHubPullRequestRef,
    signal?: AbortSignal,
  ): Promise<GitHubPullReview[]> {
    return this.#list(ref, `/pulls/${ref.number}/reviews`, parsePullReview, signal);
  }

  async #list<T>(
    ref: GitHubPullRequestRef,
    suffix: string,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= this.#maxPages; page += 1) {
      const url = endpoint(ref, suffix);
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const response = await this.#request(url, "GET", undefined, signal);
      if (!Array.isArray(response.json)) {
        throw new GitHubRestError("invalid_response", "GitHub returned an invalid response");
      }
      items.push(...response.json.map(parse));
      if (!hasNextPage(response.headers)) return items;
    }
    throw new GitHubRestError(
      "pagination_limit",
      "GitHub comment history exceeded the configured pagination limit",
    );
  }

  async #request(
    url: URL,
    method: "GET" | "POST",
    body?: string,
    signal?: AbortSignal,
  ): Promise<JsonResponse> {
    if (signal?.aborted) {
      throw new GitHubRestError("aborted", "GitHub request was aborted");
    }
    const controller = new AbortController();
    const requestSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, signal]);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new GitHubRestError("request_timeout", "GitHub request timed out", {
          ambiguous: method === "POST",
        }));
      }, this.#requestTimeoutMs);
    });
    const headers = new Headers({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.#token}`,
      "user-agent": this.#userAgent,
      "x-github-api-version": GITHUB_REST_API_VERSION,
    });
    if (body !== undefined) headers.set("content-type", "application/json");

    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.#fetch(url, {
            method,
            headers,
            redirect: "error",
            signal: requestSignal,
            ...(body === undefined ? {} : { body }),
          }),
          timeout,
        ]);
      } catch (error) {
        if (error instanceof GitHubRestError) throw error;
        if (signal?.aborted && !timedOut) {
          throw new GitHubRestError("aborted", "GitHub request was aborted", {
            ambiguous: method === "POST",
          });
        }
        throw new GitHubRestError("network_failure", "GitHub request failed", {
          ambiguous: method === "POST",
        });
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new GitHubRestError("http_error", "GitHub request was rejected", {
          status: response.status,
          ambiguous: method === "POST" && response.status >= 500,
        });
      }
      let json: unknown;
      try {
        const text = await boundedResponseText(response);
        json = JSON.parse(text) as unknown;
      } catch (error) {
        if (error instanceof GitHubRestError) {
          if (method === "POST" && !error.ambiguous) {
            throw new GitHubRestError(error.code, error.message, {
              ...(error.status === undefined ? {} : { status: error.status }),
              ambiguous: true,
            });
          }
          throw error;
        }
        throw new GitHubRestError("invalid_response", "GitHub returned an invalid response", {
          ambiguous: method === "POST",
        });
      }
      return { json, headers: response.headers };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
