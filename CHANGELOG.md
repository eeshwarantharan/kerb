# Changelog

All notable changes to Kerb. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Milestone G of [docs/KERB-V2.md](docs/KERB-V2.md), "Proof", in progress: the benchmark (section 15), and what running it found.

### Added

- **Benchmark v2** in [`bench/`](bench/): 35 tasks across Node, Python and Go (seeded regressions with ground truth, a TLS-inspecting proxy, slow suites, a compaction-length task, a 100,000-file monorepo), each with a reference solution and validated; a four-arm harness (plain, skill-only, Kerb v1, Kerb v2) reading attempts, tokens and time to green from transcripts; refusals and cached answers judged by replay; the launch gate with paired bootstrap confidence intervals. The cause-isolation benchmark and hook latency have been run (results in `bench/results/`); the agent runs have not.

### Security

- Worker jobs are signed with a per-user secret when queued, and unsigned jobs never run: a cloned repo that ships a `.kerb/jobs/` folder could otherwise have had Kerb run a command of its choosing after the next check, without the agent's permission prompt.
- Kept states are validated before a worktree is built from them: a planted walk-mode state with `../` paths could otherwise have written files outside the repo. Commit ids, content hashes, scopes and dependency link names are checked too.
- A validly signed org bundle older than the cached one is refused (rollback by replaying an old response).
- Fixes merged from git notes are type- and length-checked.
- `kerb doctor` warns when git tracks files under `.kerb/`.

### Fixed

- Cause isolation never started when the test command names only failing tests (`pytest -q`, Jest's and Vitest's default reporters): a green run without names now counts as every test passing.
- `pytest -q` output (no header, totals without `===`) wasn't parsed.
- Two processes breaking the same stale lock could delete a fresh one, and a slow holder whose lock was broken deleted its successor's on release, so a summary update could be lost (the event log itself was safe: appends are atomic). The worker's lock had the same race, which could start two workers.
- Tests and benchmark scripts left their temp directories behind (tens of thousands per run, some holding a 100,000-file repo), which filled a developer's disk. Test temp directories are now removed when each test process exits (`KERB_TEST_KEEP=1` keeps them); benchmark sandboxes are removed after each run, on Ctrl-C too (`--keep` keeps them); the 100,000-file tasks run only with `--large`; and a run stops before the disk is nearly full.
- Cause isolation could confirm an innocent edit for a flaky test: confirmation now needs the state without the culprit to pass twice and the culprit alone to fail.
- A probe whose build failed (for example an unused Go import with only some edits applied) counted as the test failing; it now counts as "didn't run".

## [0.7.0] - 2026-10-02

Milestone F of [docs/KERB-V2.md](docs/KERB-V2.md), "Platform". Still a preview.

### Added

- **`kerb query`:** read-only answers from the records as JSON: `runs`, `tests`, `verification`, `progress`, `fixes`, `findings`, `states`, with filters (`--key`, `--since`, `--state`, `--status`, `--test`, `--fingerprint`, `--green`). Each result has a published JSON Schema in [docs/KER.md](docs/KER.md).
- **`kerb export --format ker`:** the records as KER NDJSON for memory tools, dashboards and research, redacted again; `--no-text` keeps only ids, counts, codes and hashes.
- **MCP server:** `kerb mcp` speaks MCP over stdio (the 2026-07-28 revision and the earlier `initialize` handshake) with nine read-only tools: `verification_status`, `progress`, `attempts`, `test_history`, `known_fixes`, `last_green`, `cause`, `boundaries`, `explain`. Each answer is at most 2 KB with pointers for more. `kerb init` registers it for Claude Code (`.mcp.json`), Cursor, VS Code and Gemini CLI, and prints the command for Codex, OpenCode and Copilot CLI.
- **Plugins:** ES modules listed with their SHA-256 in policy or the managed config; repo-listed ones need `kerb plugins approve` (human-only). Handlers for `run.end`, `refusal`, `finding` and `session.start` get a read-only query object and may return a note, shown as `kerb: note · [name] …`, and nothing else; each has 50 ms, and timeouts and errors are counted, never raised. `kerb plugins` lists them.
- **Skills pack:** `kerb` (updated), `kerb-diagnose` (a debugging loop over Kerb's records) and `kerb-before-done` (never claim tests pass unless verification is green), installable as a Claude Code plugin from this repository's marketplace or with `npx skills`; `server.json` describes the MCP server for the MCP registry. See [docs/SKILLS.md](docs/SKILLS.md).
- `kerb cause [test]` shows the latest cause finding; `kerb why <run>` names the narrow command that reproduces the first failing test; the ledger points to a known fix for the current failure.

### Changed

- `kerb init` adds `.mcp.json` to `.gitignore` when it creates it (the file holds this machine's paths).

## [0.6.0] - 2026-10-02

Milestone E of [docs/KERB-V2.md](docs/KERB-V2.md), "Cause and proof". Still a preview.

### Added

- **Background worker:** `kerb worker` starts on demand, one per repo, niced, one job at a time within a per-job probe budget and an hourly budget, and exits after 60 s idle. It never touches the working tree: probes run in worktrees under `.kerb/worktrees/`. `kerb worker status|stop`, `kerb jobs`. Config `worker` (`auto`, off in CI; `on`; `off`; `manual`).
- **Narrowing:** a command that runs only one test, for Vitest, Jest, pytest, go test, cargo test and Node's runner.
- **Cause isolation:** when a test that passed starts failing, the worker reproduces it in isolation, searches the hunks between the two states with delta debugging, confirms the culprit with one more probe, and reports it at your next command: `kerb: cause · "logout clears session" broke at attempt 4`, the culprit lines, and the `kerb restore … --keep-except` patch that reverts just them. Static checks by default; tests once you run `kerb config set cause on`. Never applied automatically.
- **Proven fixes:** a failure turned green is recorded as a fix (and minimised to the hunks that matter, in the background); when the same failure comes back, one hint points to it (`kerb show fix:<id>`), or to a similar one, labelled as not the same error. Commits are attached once the fix is committed.
- **Sharing fixes:** with `share_fixes` on (human-only), committed fixes are written to `refs/notes/kerb` (fingerprints and test ids only); `kerb sync` merges a team's notes, and `kerb sync --push` (human-only) publishes yours.

### Fixed

- The Node test reporter missed the test file when the command quoted it.

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

[0.7.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.7.0
[0.6.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.6.0
[0.5.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.5.0
[0.4.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.4.0
[0.3.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.3.0
[0.2.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.2.0
[0.1.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.1.0
