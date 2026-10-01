# Changelog

All notable changes to Kerb. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/eeshwarantharan/kerb/releases/tag/v0.1.0
