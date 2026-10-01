# Changelog

All notable changes to Kerb. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

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

[0.2.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.2.0
[0.1.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.1.0
