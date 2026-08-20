import { test } from "node:test";
import assert from "node:assert/strict";
import {
  githubRequest,
  fetchPullRequest,
  listOpenPullRequests,
  fetchChangedFiles,
  GitHubApiError,
} from "../src/github-fetch.ts";
import { withMockServer } from "./test-helpers.ts";

test("retries a transient 503 and succeeds once the server recovers", async () => {
  let attempts = 0;
  const mock = await withMockServer((req, res) => {
    attempts++;
    if (attempts < 3) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "unavailable" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  const result = await githubRequest<{ ok: boolean }>("/thing", { apiBaseUrl: mock.url });
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
  await mock.close();
});

test("retries a network-level failure (connection error), not just a bad HTTP status", async () => {
  // Point at a server that isn't listening at all — every attempt throws
  // (ECONNREFUSED) rather than resolving with a bad status, exercising
  // fetchWithRetry's catch branch instead of its res.ok-false branch.
  const closedPort = 1; // reserved/unlikely-to-be-listening low port
  await assert.rejects(
    () => githubRequest("/thing", { apiBaseUrl: `http://127.0.0.1:${closedPort}` }),
    /ECONNREFUSED|fetch failed/i
  );
});

test("does not retry a 404 — fails immediately", async () => {
  let attempts = 0;
  const mock = await withMockServer((req, res) => {
    attempts++;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });

  await assert.rejects(() => githubRequest("/missing", { apiBaseUrl: mock.url }));
  assert.equal(attempts, 1);
  await mock.close();
});

test("sends no Authorization header when no token is given", async () => {
  const mock = await withMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hasAuth: "authorization" in req.headers }));
  });

  const result = await githubRequest<{ hasAuth: boolean }>("/x", { apiBaseUrl: mock.url });
  assert.equal(result.hasAuth, false);
  await mock.close();
});

test("sends an Authorization header when a token is given", async () => {
  let sawAuth: string | undefined;
  const mock = await withMockServer((req, res) => {
    sawAuth = req.headers.authorization;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });

  await githubRequest("/x", { apiBaseUrl: mock.url, token: "secret-token" });
  assert.equal(sawAuth, "Bearer secret-token");
  await mock.close();
});

test("fetchPullRequest maps the raw response into a PullRequestTarget, including labels", async () => {
  const mock = await withMockServer((req, res) => {
    assert.equal(req.url, "/repos/acme/widgets/pulls/7");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        number: 7,
        head: { sha: "abc123" },
        created_at: "2026-01-01T00:00:00Z",
        labels: [{ name: "bug" }, { name: "urgent" }],
      })
    );
  });

  const pr = await fetchPullRequest("acme", "widgets", 7, { apiBaseUrl: mock.url });
  assert.deepEqual(pr, {
    number: 7,
    headSha: "abc123",
    createdAt: "2026-01-01T00:00:00Z",
    labels: ["bug", "urgent"],
  });
  await mock.close();
});

test("fetchPullRequest defaults labels to an empty array when the response has none", async () => {
  const mock = await withMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ number: 1, head: { sha: "a" }, created_at: "2026-01-01T00:00:00Z" }));
  });
  const pr = await fetchPullRequest("acme", "widgets", 1, { apiBaseUrl: mock.url });
  assert.deepEqual(pr.labels, []);
  await mock.close();
});

test("listOpenPullRequests stops paginating once a page returns fewer than per_page items", async () => {
  const mock = await withMockServer((req, res) => {
    const page = new URL(req.url ?? "", "http://x").searchParams.get("page");
    res.writeHead(200, { "content-type": "application/json" });
    if (page === "1") {
      res.end(JSON.stringify([{ number: 1, head: { sha: "a" }, created_at: "2026-01-01T00:00:00Z", labels: [] }]));
    } else {
      res.end("[]");
    }
  });

  const prs = await listOpenPullRequests("acme", "widgets", { apiBaseUrl: mock.url });
  assert.equal(prs.length, 1);
  assert.equal(mock.calls.filter((c) => c.url.includes("page=1")).length, 1);
  assert.equal(mock.calls.filter((c) => c.url.includes("page=2")).length, 0); // page=1 returned <100, no second page fetched
  await mock.close();
});

test("listOpenPullRequests fetches a second page when the first page is exactly full", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => ({
    number: i + 1,
    head: { sha: `sha-${i + 1}` },
    created_at: "2026-01-01T00:00:00Z",
    labels: [],
  }));
  const mock = await withMockServer((req, res) => {
    const page = new URL(req.url ?? "", "http://x").searchParams.get("page");
    res.writeHead(200, { "content-type": "application/json" });
    if (page === "1") res.end(JSON.stringify(fullPage));
    else if (page === "2") res.end(JSON.stringify([{ number: 101, head: { sha: "sha-101" }, created_at: "2026-01-01T00:00:00Z", labels: [] }]));
    else res.end("[]");
  });

  const prs = await listOpenPullRequests("acme", "widgets", { apiBaseUrl: mock.url });
  assert.equal(prs.length, 101);
  assert.equal(mock.calls.filter((c) => c.url.includes("page=2")).length, 1);
  await mock.close();
});

test("fetchChangedFiles returns filenames from the PR files endpoint", async () => {
  const mock = await withMockServer((req, res) => {
    assert.equal(req.url, "/repos/acme/widgets/pulls/9/files?per_page=100&page=1");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ filename: "docs/a.md" }, { filename: "src/index.ts" }]));
  });

  const files = await fetchChangedFiles("acme", "widgets", 9, { apiBaseUrl: mock.url });
  assert.deepEqual(files, ["docs/a.md", "src/index.ts"]);
  await mock.close();
});

test("githubRequest throws a GitHubApiError carrying the status, so callers can branch without regexing the message", async () => {
  const mock = await withMockServer((_req, res) => {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Resource not accessible by integration" }));
  });

  await assert.rejects(
    () => githubRequest("/repos/acme/widgets/check-runs", { method: "POST", apiBaseUrl: mock.url }),
    (err: unknown) => {
      assert.ok(err instanceof GitHubApiError);
      assert.equal(err.status, 403);
      assert.match(err.message, /403 Forbidden/);
      return true;
    }
  );
  await mock.close();
});
