# Changelog

## 1.5.0 - 2026-09-01

- Grouped internal subagent usage under its root user task instead of showing hundreds of repeated task rows.
- Added native keyword search across task titles and privacy-filtered user prompt excerpts.
- Added debounced local search with Enter-to-search and Escape-to-clear keyboard controls.
- Split native task models and search behavior into focused source modules.
- Added a self-contained Windows quick-start file; the packaged widget needs no Node.js, address, port, or configuration file.

## 1.4.0 - 2026-09-01

- Added saved Codex task titles beside anonymous task numbers when available.
- Added privacy-filtered user prompt excerpts to native per-turn rows.
- Filtered injected environment, browser, plugin, and handoff context from displayed prompts.
- Added a native “小窗关注” mode that shows one selected task turn in the compact bar.
- Added compact-bar arrows, mouse-wheel navigation, left-side mode switching, and tray display controls.

## 1.3.0 - 2026-09-01

- Added native task rankings and per-turn usage details to the expanded Windows floating panel.
- Added Overview and Tasks views without changing the 260×68 compact reading bar.
- Added mouse-wheel navigation, on-demand turn loading, back navigation, and retry feedback.
- Added summary-only and single-task API responses so the widget never downloads every turn during routine refreshes.

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
