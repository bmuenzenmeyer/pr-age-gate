# PR Age Gate - Fork Test

Verifies that a pull request has been open for a configurable minimum
number of hours. Two ways to use it, from one repo, sharing the same
underlying code:

- **As a GitHub Action.** A thin wrapper around the same library that
  also *writes* a check run back to the PR (writing needs a token). The
  check stays **red** until the minimum age is met, then flips **green**
  on its own via an hourly schedule; no new commit required.
- **As a CLI/library** (`pr-age-gate` on npm). A standalone verifier that
  works against **any public repo with no token at all**: it just reads
  `pulls/{number}`, which GitHub serves unauthenticated (rate limited to
  60 req/hr instead of 5000/hr). Independently runnable by anyone: a
  contributor, a bot, or a third party auditing a claim, not just the
  repo owner.

![A screenshot of the PR status checks](/.github/status.png)

and details...

![A screenshot of the action succeeding after configured PR age is met.](/.github/success.png)

## As a GitHub Action

```yaml
name: PR Age Gate

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
  schedule:
    - cron: "0 * * * *" # hourly, re-evaluates every open PR

permissions:
  checks: write
  pull-requests: read

jobs:
  age-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: bmuenzenmeyer/pr-age-gate@v1
        with:
          min-hours: "48"
          bypass-labels: "urgent,hotfix" # optional
          bypass-paths: "docs/**,*.md"   # optional, costs one extra API call per PR, only made if this is set
```

Both triggers point at the **same workflow**, intentionally:

- `pull_request` events give fast feedback the moment a PR is opened or
  pushed to.
- `schedule` has no single PR in context, so it re-evaluates every open
  PR in the repo. That's what actually flips a PR from red to green once
  enough wall-clock time has passed, since nothing else about the PR
  needs to change for that.

Add the check's name (`pr-age-gate` by default) as a required status
check in your branch protection rules to actually block merging on it.

### Action inputs

| Input | Default | Description |
|---|---|---|
| `min-hours` | `48` | Minimum hours a PR must stay open before this check passes. |
| `check-name` | `pr-age-gate` | Name of the check run. Change this if you want more than one age gate (e.g. different thresholds) on the same repo. |
| `bypass-labels` | *(none)* | Comma-separated PR labels that make this check pass immediately, regardless of age. |
| `bypass-paths` | *(none)* | Comma-separated glob patterns. If every file the PR changes matches one, the check passes immediately regardless of age. |
| `github-token` | `${{ github.token }}` | Token used to list PRs and create/update check runs. The default Actions token is sufficient; needs `checks: write` and `pull-requests: read` permissions (see example above). |

## As a CLI

```sh
npx pr-age-gate --owner facebook --repo react --pr 12345 --min-hours 48
```

```json
{
  "passes": false,
  "ageHours": 2.1,
  "minHours": 48,
  "remainingHours": 45.9,
  "bypassed": false,
  "owner": "facebook",
  "repo": "react",
  "pullNumber": 12345,
  "headSha": "...",
  "createdAt": "2026-08-18T01:00:00Z"
}
```

Exit codes: `0` = passes (old enough, or bypassed), `1` = fails (too
young), `2` = couldn't determine at all (bad arguments, network/API
error). Kept distinct from 0/1 so a caller can tell "the gate failed"
apart from "the check itself broke."

Flags or environment variables, either works:

| Flag | Env var | Default |
|---|---|---|
| `--owner` | `PR_AGE_GATE_OWNER` | *(required)* |
| `--repo` | `PR_AGE_GATE_REPO` | *(required)* |
| `--pr` | `PR_AGE_GATE_PR` | *(required)* |
| `--min-hours` | `PR_AGE_GATE_MIN_HOURS` | `48` |
| `--token` | `PR_AGE_GATE_TOKEN` / `GITHUB_TOKEN` | *(none, unauthenticated)* |
| `--bypass-labels` | `PR_AGE_GATE_BYPASS_LABELS` | *(none)*; comma-separated, e.g. `urgent,hotfix` |
| `--bypass-paths` | `PR_AGE_GATE_BYPASS_PATHS` | *(none)*; comma-separated globs, e.g. `docs/**,*.md` |
| *(no flag)* | `GITHUB_API_URL` | `https://api.github.com`; set it for GitHub Enterprise Server (`https://HOSTNAME/api/v3`) |

## As a library

```ts
import { checkPrAge } from "pr-age-gate";

const result = await checkPrAge({
  owner: "facebook",
  repo: "react",
  pullNumber: 12345,
  minHours: 48,
  // token: optional, omit for public repos
  bypassLabels: ["urgent"], // optional
  bypassPaths: ["docs/**"], // optional, costs one extra API call, only made if this is set
  // apiBaseUrl: optional, for GitHub Enterprise Server ("https://HOSTNAME/api/v3")
});

if (!result.passes) {
  console.log(`Needs ${result.remainingHours.toFixed(1)} more hours`);
} else if (result.bypassed) {
  console.log(`Passed via bypass: ${result.bypassReason}`);
}
```

## How it decides pass vs. fail

```
ageHours = now − pr.created_at
passes   = ageHours >= minHours
```

That's it, deliberately simple. It only reads `created_at`. It doesn't
look at draft status, review state, or CI: this is meant to compose with
those as an independent check, not duplicate what they already cover.

## Bypassing the age check

Two independent ways a PR can pass immediately, regardless of age.
Available identically as `bypassLabels`/`bypassPaths` (library),
`--bypass-labels`/`--bypass-paths` (CLI), and `bypass-labels`/
`bypass-paths` (Action inputs):

- **By label.** If the PR has any label in the configured list, it
  passes. Free: labels are already present on the same API response used
  for everything else, no extra request.
- **By path.** If *every* file the PR changes matches at least one
  configured glob pattern, it passes. A PR that touches one doc file and
  one source file is **not** bypassed just because part of it looked
  docs-only. Costs one extra API call per PR (`GET .../pulls/{n}/files`),
  only made when `bypass-paths` is actually set.

The glob support is deliberately minimal (see `src/bypass.ts`), no
external dependency for it:

- `*` matches within one path segment (`*.md` matches `readme.md`, not
  `docs/readme.md`)
- `**` matches across any number of segments, including zero (`docs/**`
  matches `docs/readme.md` and `docs/sub/readme.md`; `**/*.md` matches
  `readme.md` *and* `docs/readme.md`)
- No brace expansion (`{a,b}`), no character classes (`[abc]`), no
  negation

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, tests, and publishing.

## License

MIT. See [LICENSE](./LICENSE).
