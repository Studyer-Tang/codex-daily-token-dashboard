# Changelog

## 1.2.0 - 2026-09-01

- Added privacy-preserving usage totals for each task and conversation turn.
- Grouped modern `token_count` events using `task_started` and `task_complete` boundaries while retaining legacy-log compatibility.
- Added expandable task rankings with input, cached input, output, totals, and high-usage markers.
- Rendered large task and turn lists in batches to keep long histories responsive.
- Kept raw session IDs, turn IDs, paths, prompts, and responses out of the browser payload.

## 1.1.0 - 2026-09-01

- Isolated large Codex log scans in a worker so health checks remain responsive.
- Added bounded request timeouts, safe error details, automatic service recovery, and rotating local logs.
- Added single-instance window activation, clean Windows shutdown handling, and orphan-process cleanup.
- Moved aggregate cache data to the per-user application-data directory with legacy-cache migration.
- Added a self-contained Windows ZIP with bundled Node.js and a SHA-256 checksum.
- Replaced committed binaries with reproducible GitHub Actions build artifacts.
- Expanded automated coverage for cumulative logs, duplicate archives, worker stalls, port conflicts, and parent-process exit.
- Replaced the decorative blue-purple compact card with a default 260×68 flat, neutral reading companion.
