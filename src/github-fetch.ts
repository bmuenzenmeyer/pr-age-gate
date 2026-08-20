// Low-level GitHub REST client — plain fetch, no Octokit (see README for
// why). Shared by everything in this package: the CLI/library's
// unauthenticated public-repo reads and the Action's authenticated
// check-run writes both go through githubRequest() below, so both get
// retry behavior for free from one place.

// Overridable for GitHub Enterprise Server (whose REST API lives at
// https://HOSTNAME/api/v3) and for local testing against a mock server.
// Read fresh on every call (not frozen into a module-level const) so
// setting it programmatically — e.g. per-test — actually takes effect;
// a top-level `const` here would only ever see the value present at
// module import time.
function defaultApiBase(): string {
  return process.env.GITHUB_API_URL || "https://api.github.com";
}

const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries transient failures (5xx, network errors) with exponential
 * backoff. Deliberately does NOT retry 4xx — a bad token or a genuinely
 * missing PR isn't fixed by trying again, so those fail immediately
 * instead of wasting ~3.5s of retries on an error that will never change.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt === MAX_RETRIES) {
        return res;
      }
      lastError = new Error(`Retryable status ${res.status} ${res.statusText}`);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) throw err;
    }
    await sleep(BASE_DELAY_MS * 2 ** attempt);
  }
  // Unreachable given the loop above always returns or throws on the last
  // attempt, but keeps TypeScript's control-flow analysis happy.
  throw lastError;
}

function authHeaders(token?: string): Record<string, string> {
  const base: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // Omitted entirely (not sent empty/blank) when there's no token: public
  // repo reads work fine unauthenticated, just at a lower rate limit
  // (60/hr per IP instead of 5000/hr per token).
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

/**
 * Carries the HTTP status alongside the message so callers can branch on
 * it. The Action needs to tell an expected 403 — a fork PR's downgraded
 * token cannot write check runs — apart from a genuine failure, and
 * regex-matching the message string would be a fragile way to do that.
 * The message format is unchanged from a plain Error.
 */
export class GitHubApiError extends Error {
  // An explicit field, not a `readonly status` constructor parameter
  // property: parameter properties aren't erasable, and this package's
  // source is executed directly under Node's type stripping.
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export interface RequestOptions extends Omit<RequestInit, "headers"> {
  token?: string;
  apiBaseUrl?: string;
  headers?: Record<string, string>;
}

export async function githubRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { token, apiBaseUrl, headers, ...init } = options;
  const base = apiBaseUrl ?? defaultApiBase();
  const res = await fetchWithRetry(`${base}${path}`, {
    ...init,
    headers: { ...authHeaders(token), ...headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GitHubApiError(
      res.status,
      `GitHub API ${init.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText} ${body}`
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface PullRequestTarget {
  number: number;
  headSha: string;
  createdAt: string;
  /** Label names — free on this response, used for the bypass-labels feature. */
  labels: string[];
}

interface RawPullRequest {
  number: number;
  head: { sha: string };
  created_at: string;
  labels?: { name: string }[];
}

function toPullRequestTarget(pr: RawPullRequest): PullRequestTarget {
  return {
    number: pr.number,
    headSha: pr.head.sha,
    createdAt: pr.created_at,
    labels: (pr.labels ?? []).map((l) => l.name),
  };
}

/** A single PR by number — works unauthenticated for public repos. */
export async function fetchPullRequest(
  owner: string,
  repo: string,
  pullNumber: number,
  options: Omit<RequestOptions, "method" | "body"> = {}
): Promise<PullRequestTarget> {
  const pr = await githubRequest<RawPullRequest>(`/repos/${owner}/${repo}/pulls/${pullNumber}`, options);
  return toPullRequestTarget(pr);
}

/** Every open PR in the repo — used on the scheduled (cron) trigger, which has no single PR to react to. */
export async function listOpenPullRequests(
  owner: string,
  repo: string,
  options: Omit<RequestOptions, "method" | "body"> = {}
): Promise<PullRequestTarget[]> {
  const results: PullRequestTarget[] = [];
  let page = 1;
  for (;;) {
    const batch = await githubRequest<RawPullRequest[]>(
      `/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`,
      options
    );
    for (const pr of batch) {
      results.push(toPullRequestTarget(pr));
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return results;
}

interface RawChangedFile {
  filename: string;
}

/**
 * Filenames changed by a PR — only fetched when a bypass-paths config is
 * actually set, since it's an extra request per PR that most setups won't
 * need. Works unauthenticated for public repos, same as the reads above.
 */
export async function fetchChangedFiles(
  owner: string,
  repo: string,
  pullNumber: number,
  options: Omit<RequestOptions, "method" | "body"> = {}
): Promise<string[]> {
  const results: string[] = [];
  let page = 1;
  for (;;) {
    const batch = await githubRequest<RawChangedFile[]>(
      `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      options
    );
    for (const file of batch) results.push(file.filename);
    if (batch.length < 100) break;
    page += 1;
  }
  return results;
}
