---
name: playwright-test-results
description: Query Playwright CI test results from the aggregated DuckDB database. Answers questions about flaky tests, failure rates, slow tests, and per-run/SHA/PR results without hunting through GitHub artifacts.
user_invocable: true
---

# Playwright Test Results (DuckDB)

CI test results from the `tests 1`, `tests 2`, `tests others`, and `MCP`
workflows are aggregated into a single DuckDB file, refreshed every few hours by
the `Update test results DB` workflow. Use it to answer the easy questions fast;
each row keeps enough metadata to fetch the full blob report when you need the
step-by-step detail.

## Get the database

Download the latest `test-results-db` artifact — it lands at the fixed,
gitignored path `utils/test-results-db/test-results.duckdb`:

```bash
cd utils/test-results-db
npm ci                       # first time only
GITHUB_TOKEN=$(gh auth token) node src/cli.ts download
```

The downloaded file can be **trailing** — the maintaining workflow only runs
every few hours, so the newest runs may not be in it yet. To bring it fully up
to date locally, run `update` after downloading (needs a token; it merges any
runs missing from the file):

```bash
GITHUB_TOKEN=$(gh auth token) node src/cli.ts update --lookback-days 3
```

Then query it with the `duckdb` CLI (or any DuckDB client) — this package's CLI
does **not** query, it only maintains the file:

```bash
duckdb utils/test-results-db/test-results.duckdb "SELECT count(*) FROM test_results"
# interactive:
duckdb utils/test-results-db/test-results.duckdb
```

## Schema

Single table `test_results`, one row per test result (**one row per retry**):

| Column | Meaning |
| --- | --- |
| `run_id`, `run_attempt` | GitHub Actions run identity |
| `workflow_name` | `tests 1` / `tests 2` / `tests others` / `MCP` |
| `event` | `push` / `pull_request` |
| `head_sha`, `head_branch`, `pr_number` | what was tested |
| `bot_name` | e.g. `Ubuntu chromium` — the CI bot (recovered from the merge-injected tag) |
| `project_name` | Playwright project, e.g. `chromium`, `webkit` |
| `test_id` | stable id of the test case |
| `test_title` | full title path (`file > describe > test`) |
| `file`, `line` | source location |
| `expected_status` | `passed` / `skipped` / ... |
| `status` | actual result: `passed` / `failed` / `timedOut` / `skipped` / `interrupted` |
| `retry` | 0 = first attempt |
| `duration_ms` | result duration |
| `error_message` | first error, ANSI-stripped, truncated to ~2000 chars |
| `tags` | space-joined, e.g. `"@slow @flaky"` (LIKE to filter) |
| `result_started_at`, `run_started_at` | timestamps |
| `ingested_at` | debug only — when this row was imported (will be dropped later) |

Notes:
- **Flakiness is derived**, not stored — a test is flaky in a run when its
  retries mix `failed`→`passed` (see query below).
- The db is size-capped: the oldest whole runs are evicted over time, so it holds
  a recent window, not full history.

## Canonical queries

### Flaky tests (failed then passed within the same run)

```sql
SELECT run_id, project_name, test_title,
       count(*) FILTER (WHERE status = 'passed') AS passed,
       count(*) FILTER (WHERE status IN ('failed', 'timedOut')) AS failed
FROM test_results
GROUP BY run_id, project_name, test_id, test_title
HAVING passed > 0 AND failed > 0
ORDER BY failed DESC
LIMIT 50;
```

### Most-flaky tests across the retained window

```sql
SELECT project_name, test_title, count(DISTINCT run_id) AS flaky_runs
FROM (
  SELECT run_id, project_name, test_id, test_title
  FROM test_results
  GROUP BY run_id, project_name, test_id, test_title
  HAVING count(*) FILTER (WHERE status = 'passed') > 0
     AND count(*) FILTER (WHERE status IN ('failed', 'timedOut')) > 0
)
GROUP BY project_name, test_title
ORDER BY flaky_runs DESC
LIMIT 25;
```

### Failure rate per project (final attempt per test)

```sql
WITH final AS (
  SELECT run_id, project_name, test_id,
         argMax(status, retry) AS final_status
  FROM test_results
  GROUP BY run_id, project_name, test_id
)
SELECT project_name,
       count(*) AS results,
       count(*) FILTER (WHERE final_status IN ('failed', 'timedOut')) AS failing,
       round(100.0 * count(*) FILTER (WHERE final_status IN ('failed', 'timedOut')) / count(*), 2) AS fail_pct
FROM final
GROUP BY project_name
ORDER BY fail_pct DESC;
```

### Slowest tests

```sql
SELECT project_name, test_title, round(avg(duration_ms)) AS avg_ms, count(*) AS samples
FROM test_results
WHERE status = 'passed'
GROUP BY project_name, test_title
HAVING samples >= 3
ORDER BY avg_ms DESC
LIMIT 25;
```

### What failed on a specific SHA or PR

```sql
SELECT workflow_name, project_name, test_title, status, error_message, bot_name, run_id
FROM test_results
WHERE head_sha = '<sha>'          -- or: pr_number = <n>
  AND status IN ('failed', 'timedOut')
ORDER BY project_name, test_title;
```

### Tests carrying a tag

```sql
SELECT DISTINCT project_name, test_title
FROM test_results
WHERE tags LIKE '%@slow%';
```

## Fetching the full blob report

The db stores summaries. For the full step tree / attachments / stdio of a
result, fetch the original blob artifact. A row identifies it by `run_id` +
`bot_name`: the run's artifact is named `blob-report-<bot_name>`.

```bash
# List the run's blob artifacts and find the one for this bot_name:
gh api /repos/microsoft/playwright/actions/runs/<run_id>/artifacts \
  --jq '.artifacts[] | select(.name | startswith("blob-report")) | {id, name}'

# Download it (name == "blob-report-<bot_name>"):
gh api /repos/microsoft/playwright/actions/artifacts/<artifact_id>/zip > blob.zip
# unzip blob.zip -> inner report-*.zip -> report.jsonl (the full tele event stream)
```

Blob artifacts have a 7-day retention, so this works only for recent runs; the
db itself retains summaries longer (until size-cap eviction).
