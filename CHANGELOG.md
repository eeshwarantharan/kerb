# Changelog

All notable changes to Kerb. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-10-02

Milestone D of [docs/KERB-V2.md](docs/KERB-V2.md), "Instant answers and last green". Still a preview.

### Added

- **Instant answers:** a static check (tsc, ESLint, `prettier --check`, `ruff check`, mypy, `go vet`, `cargo check`/`clippy`, `deno lint`/`check`, or a test command listed in policy `hermetic_commands`) about to run on the same files and environment as a recorded run is answered from that run instead of running again: `kerb: cached`, the recorded result and exit code, a `cached_answer` event, counted in the recap and report. Policy `cache_ttl` (24 h by default).
- **Last green and restore:** `kerb green [--key K] [--test T]` finds the newest state where a check or a single test passed and what changed since; `kerb restore <state> --patch` writes a patch back to it (applying nothing), `--keep-except <finding>` reverts only a cause finding's culprit hunks, and `--in-place` (human-only) backs up your changes with `git stash` and restores the state.

### Fixed

- Policy `check_commands` written with a path (`./run-tests.sh`) never matched.

## [0.4.0] - 2026-10-02

Milestone C of [docs/KERB-V2.md](docs/KERB-V2.md), "Insight". Still a preview.

### Added

- **Deltas:** after a test run, one block says what changed since the last run of the same command: tests fixed, still failing, newly failing and flaky (passed and failed on the same files). Flaky tests no longer count toward `breaker_open`. In `kerb run` the delta replaces the generic footer; `kerb why <run>` lists every failing test.
- **Verification status:** green, red, stale (with the files changed since) or never, per check command, in `kerb status`, the status line and at Stop. Policy `stop_gate` (`warn` by default, `block`, `off`); `block` keeps the agent working once per state, then yields. Policy `verify_keys` tracks commands that haven't run yet.
- **Convergence:** `kerb progress` shows the failing count per command since its last success and the trend (converging, stalled, oscillating, diverging, green); the status line shows the series. A new refusal, `oscillating`, names the states an agent keeps cycling between and the files that differ.
- **Attempt ledger:** `kerb ledger`, and the ledger injected at session start and after compaction or resume, for every enforced agent that has a channel for it; `.kerb/ledger.md` for the others.
- **Delivery:** one block of context per moment, within size limits, verified per agent: Claude Code, Codex, Gemini CLI (PreCompress and BeforeAgent hooks, installed by `kerb init --refresh`), Copilot, Cursor and OpenCode (context now appended to the tool output, and the ledger added to the compaction prompt).

## [0.3.0] - 2026-10-02

Milestone B of [docs/KERB-V2.md](docs/KERB-V2.md), "Truth". Still a preview.

### Added

- **State model:** check runs are identified by states built from git trees (through a copy of the index, so the real index is never touched), or outside git by the walk hash plus a content-addressed blob store. Post-states are kept as `state` records with refs under `refs/kerb/states/` (never pushed by default; `kerb doctor` warns about mirror remotes, and the hook notes `git push --mirror`). States can be materialized as a worktree or a patch, without touching the working tree. `kerb gc` applies retention.
- **Kerb Execution Record (KER) v1:** JSON Schemas for every record type, published in [docs/KER.md](docs/KER.md); `session` records; rebuildable indexes in `.kerb/index/` and `kerb reindex`.
- **Test-level results:** parsers for Vitest (including its agent reporter), Jest, pytest, go test, cargo test and Node's test runner, JUnit XML report files, and tsc, ESLint, Ruff, mypy and Clippy diagnostics as pseudo-tests. Check runs record `framework`, `tests_summary` and one `test_result` per test.

### Changed

- The loop rules compare state ids instead of v1 workspace hashes, with the same results (v1's W tests pass unchanged). A state id includes the HEAD commit, so a commit still makes a retry legitimate.

## [0.2.0] - 2026-10-01

Milestone A of [docs/KERB-V2.md](docs/KERB-V2.md), "try it safely". Still a preview.

### Added

- **Shadow mode:** `kerb init` starts a 7-day shadow period per repo. Hooks, `kerb run` and `kerb wait-for` record `would_refuse` events instead of refusing; the recap, status line and `kerb report` show what Kerb would have stopped, and the recap asks once for a review after 7 days or 20 events. `kerb mode`, `kerb review-shadow` (each event with its evidence and what happened when the command ran anyway) and human-only `kerb enforce`. A managed config can set `mode: enforce`; `kerb config set insights off` silences hints.
- **`kerb scan`:** replays past Claude Code, Codex and Gemini CLI sessions in this repo from their local transcripts: identical re-runs, retries against blocked hosts, environment failures, hangs, output beyond the budget and polling, labelled "replayed", with tokens measured from the transcripts' usage records when present. Reads only, writes nothing. `kerb card --scan` draws it; `kerb init` offers it.
- **Environment classifier:** TLS interception, corporate proxy block pages (Squid's stock page so far) and expired credentials are recorded as `failure_kind: environment` with a subtype, never count toward loop refusals, and come with a fix line: the per-tool CA setting pointed at `tls.ca_bundle` (managed config, org policy or user config, never repo policy), or a sanctioned fix from policy `environment_fixes`. Kerb never suggests disabling verification.
- **`kerb doctor tls`:** finds company root CAs in the OS trust store and, after the human's code, writes `~/.kerb/ca-bundle.pem` and sets `tls.ca_bundle`.
- **Progressive help:** `kerb --help` shows six commands; `kerb help all` lists the rest in groups.
- README rewritten around one headline per audience, with `kerb scan` output as the hero (`scripts/hero.js` regenerates it from the sample transcripts).

### Changed

- `kerb enforce` joins the human-only commands the hooks refuse.
- The benchmark's Kerb arm runs in enforce mode.

## [0.1.0] - 2026-10-01

First public preview. Everything in [docs/KERB.md](docs/KERB.md) is implemented and tested on macOS and Linux; Windows is experimental.

### Added

- **Boundary Map:** refuses blocked hosts, implicit registries (npm, pip, uv, Go, Cargo), programs, command globs and protected `git push` targets before they run, naming the approved alternative. Learns walls from real policy denials (confirmed or suspected, 14-day expiry). `kerb map`, `kerb forget`.
- **Loopbreaker:** `identical_retry`, `deja_vu` and `breaker_open`, judged by package-scoped workspace hashes (git or walk mode) and an environment stamp, with transient and dependency-unavailable failure kinds, cooldowns and a hash budget that fails open. Human-only `kerb ack` and `kerb reset`.
- **`kerb run`** with a process-group supervisor (total and idle timeouts, tree kill, orphan reaping), streaming output shaping and redaction, and records with checksums. **`kerb check`**, **`kerb wait-for`**.
- **Native adapters** for Claude Code, GitHub Copilot (CLI and VS Code), Cursor, Codex CLI, Gemini CLI and OpenCode, each verified against the agent's current hooks documentation; `kerb init`, `kerb uninstall` (byte-exact), `kerb doctor`; instructions block, boundaries briefing and skill.
- **Visibility:** status line, session recap, `kerb report` (measured and estimated, labelled apart), `kerb status`, `why`, `history`, `diff`, `card`, `watch`.
- **Platform teams:** Ed25519-signed org policy bundle with managed config and locked settings, `kerb policy keygen|sign|verify|lint`, `export-denials` and `review`, OTLP telemetry (off by default), a policy repository template.
- **Distribution:** standalone binaries (Node single-executable), npm package `kerb-cli`, Homebrew tap, checksums, build-provenance attestations and a CycloneDX SBOM.

### Known limitations

- Windows: `kerb run` is still being fixed; CI on Windows is non-blocking.
- The task benchmark has not been run yet, so there are no savings figures.
- Hook latency is borderline against the 100 ms target for check commands after a failure (see `bench/results/`).

[0.5.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.5.0
[0.4.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.4.0
[0.3.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.3.0
[0.2.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.2.0
[0.1.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.1.0
