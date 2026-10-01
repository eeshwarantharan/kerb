<p align="center">
  <img src="https://raw.githubusercontent.com/eeshwarantharan/kerb/main/docs/assets/kerb-logo.png" alt="Kerb" width="520">
</p>

<h3 align="center">Keeps your coding agent on the road.</h3>

<p align="center">
  Kerb stops AI coding agents from wasting turns on actions your environment forbids<br>
  and on retries that cannot help, and shows you every save.
</p>

<p align="center">
  <a href="https://github.com/eeshwarantharan/kerb/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/eeshwarantharan/kerb/ci.yml?branch=main&label=ci&style=flat-square"></a>
  <a href="https://www.npmjs.com/package/kerb-cli"><img alt="npm" src="https://img.shields.io/npm/v/kerb-cli?style=flat-square&color=162640"></a>
  <img alt="Dependencies: 0" src="https://img.shields.io/badge/dependencies-0-2ea44f?style=flat-square">
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>
</p>

<p align="center">
  <a href="#install"><b>Install</b></a> ·
  <a href="#works-with"><b>Works with</b></a> ·
  <a href="#boundaries"><b>Boundaries</b></a> ·
  <a href="#for-platform-teams"><b>Platform teams</b></a> ·
  <a href="docs/KERB.md"><b>Spec</b></a> ·
  <a href="#faq"><b>FAQ</b></a>
</p>

---

Two refusals, as the agent sees them. Each one is three lines, arrives before the command runs, and names the next step:

```
kerb: policy_blocked · registry.npmjs.org is blocked here
      source: org policy v42 · Public registries are blocked; use the internal mirror.
      next: use https://npm.corp.internal instead

kerb: identical_retry · nothing relevant changed since this failed
      matches run 0muomskqv002xs (ordinary) · FAIL src/cart.test.js › applies the discount
      next: change something first, or run `kerb diff` to compare attempts
```

> [!NOTE]
> **0.1 is a preview.** Everything in the [spec](docs/KERB.md) is built and tested on macOS and Linux. Windows is experimental: hooks and pre-checks are expected to work, and `kerb run` is still being fixed. A full hooked dogfooding session and the savings benchmark come before 1.0. Please [report any false refusal](https://github.com/eeshwarantharan/kerb/issues/new?template=false-refusal.md).

## Demo

A recording lands here with the first tagged release. Until then, the scripted scenario is in [`demo/`](demo/): a blocked registry, a test database that starts late, a real test failure, and the recap. Run it yourself:

```bash
sh demo/setup.sh /tmp/kerb-demo && cd /tmp/kerb-demo && kerb init
```

## Why

Agents burn paid turns hitting walls (blocked registries, hosts and protected branches), going in circles (re-running a failing test with nothing changed, or returning to a state that already failed), drowning in noise (progress bars and 50,000-line logs) and hanging (watch modes, prompts, servers). Every retry re-sends the whole conversation, so these are the most expensive tokens an agent spends, and they buy nothing. Kerb refuses the call before it runs, says why in one line, and names the next step.

## What it does

| | |
|---|---|
| **Boundary Map** | Knows what your environment forbids (registries, hosts, programs, protected branches), refuses before the command runs, and names the approved alternative. Learns new walls from real policy denials, so each one is hit once. |
| **Loopbreaker** | Judges retries by the actual state of your files and environment, not by the command text. Refuses re-runs that can't change the result, returns to a state that already failed, and the same failure over and over despite edits. Lets legitimate retries through. |
| **`kerb wait-for`** | Turns polling into one call: retries inside Kerb and returns once, instead of the agent spending a turn per poll. |
| **Output shaping** | Strips colour codes and progress bars, folds repeats, trims long output to a head and tail, and keeps the full log on disk. |
| **Supervisor** | Total and idle timeouts that kill the whole process tree, so watch modes, prompts and stuck servers don't hang the agent. |
| **Visible saves** | A status line, a session recap and a shareable card, with measured and estimated numbers always labelled apart. |
| **Org policy** | A signed, versioned policy bundle so a platform team can give every agent the company's current rules. |

## Install

```bash
brew install eeshwarantharan/tap/kerb   # macOS and Linux
# or download a binary from Releases (checksums and build provenance attached)
# or: npm install -g kerb-cli           # Node 20+; the command is still `kerb`

cd my-repo
kerb init                             # detects agents, installs hooks, status line, skill, AGENTS.md block
kerb doctor                           # everything green, or the exact fix
```

`kerb init` prints every file it changed, which agents are **enforced** (native hook) or **best effort** (instructions only), and how to undo it (`kerb uninstall`). The standalone binary is the recommended install: hooks call it by absolute path, so Node version managers never get in the way, and it starts faster (see [Honest numbers](#honest-numbers)).

## What you'll see

Nothing, until Kerb saves something. Then (example output):

- **A status line** in agents that have one: `kerb · 3 re-runs avoided · 1.2 MB noise trimmed · 4 walls known`
- **A recap** when the agent finishes a turn with new saves:

  ```
  kerb recap · this session (enforced via Claude Code hooks)
    re-runs avoided   3  (saved 2m 14s of run time, ≈ 11k tokens of output)
    polls folded      9 attempts in 1 call
    noise trimmed     1.2 MB → 38 KB shown
    walls             1 new, learned from a policy denial
    hangs killed      1
  ```

- **A card** you can share: `kerb card --week` writes an SVG and an HTML page (and a PNG where `rsvg-convert` or macOS `qlmanage` exists). Measured numbers only; a dollar figure appears only if you set a price, and it is marked "est.".
- **A live view**: `kerb watch` in a second terminal.

## Boundaries

Put a `kerb.policy.json` at the repo root:

```json
{
  "version": 1,
  "boundaries": [
    { "kind": "host", "pattern": "registry.npmjs.org", "alternative": "https://npm.corp.internal", "why": "Public registries are blocked; use the internal mirror." },
    { "kind": "host", "pattern": "*.pypi.org", "alternative": "https://pypi.corp.internal/simple" },
    { "kind": "program", "pattern": "docker", "why": "Docker is not available in this environment." },
    { "kind": "command", "pattern": "terraform apply*", "why": "Applies run only in CI." },
    { "kind": "git_push", "pattern": "main", "why": "main is protected; open a pull request." }
  ]
}
```

Kerb checks every segment of a command before it runs: URLs and registry flags, the registry `npm install` or `pip install` would use implicitly (it reads `.npmrc`, `pip.conf`, `GOPROXY` and friends), `git push` targets, program names and command globs.

**Learning.** When a command fails with a real policy denial (for example `blocked by policy: a.example` or `CONNECT tunnel failed, response 403`) *and* that line names a host the command actually contacted, Kerb records the wall and refuses the next attempt before it runs. DNS failures are recorded as *suspected* and never block until they are seen from two different commands. Learned walls expire 14 days after their last hit, never name alternatives, and can be removed with `kerb forget <host>`.

## Works with

| Agent | How Kerb sees commands | Tier |
|---|---|---|
| Claude Code | Native hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SessionStart`, `SessionEnd`) | Enforced |
| GitHub Copilot CLI and VS Code agent | Native hooks (`.github/hooks/kerb.json`) | Enforced |
| Cursor | Native hooks (`.cursor/hooks.json`) | Enforced |
| OpenAI Codex CLI | Native hooks (`.codex/hooks.json`; trust them once in `/hooks`) | Enforced |
| Gemini CLI | Native hooks (`.gemini/settings.json`) | Enforced |
| OpenCode | Generated plugin (`.opencode/plugins/kerb.js`) | Enforced |
| Anything else | `AGENTS.md` instructions: run commands as `kerb run -- <command>` | Best effort |

**Enforced** means Kerb sees every shell command through a native hook. **Best effort** means the agent is asked to use `kerb run` and may not always do so, especially deep in a debugging spiral; `kerb status` says so plainly. Loop refusals need the exit code, which Copilot and VS Code only expose inside the tool output: when it isn't there, Kerb records the run as "exit unknown" and never counts it as a failure.

## Waiting and polling

Don't let the agent re-run a command turn after turn while a database starts. One call does the polling:

```bash
kerb wait-for --max 3m -- npm test               # retries inside one call, returns once
kerb wait-for --until output:ready -- curl -s localhost:8080/health
```

## For platform teams

- **Org bundle.** Keep the policy in a repo ([template](templates/agent-policy/)), sign it in CI with `kerb policy sign` (Ed25519), and publish it. A managed config deployed by MDM (`/Library/Application Support/Kerb/managed.json`, `/etc/kerb/managed.json`, `%ProgramData%\Kerb\managed.json`) points at the bundle and pins your public key. Kerb fetches at session start, verifies the signature, and caches for 24 hours; an unverified bundle is never used. Lower layers can add blocks but never remove one.
- **Locked settings.** The managed config sets defaults and can lock them, and can ignore alternatives named by repo policies (`lock_repo_alternatives`).
- **Review.** `kerb export-denials` (no command text or output) from each machine; `kerb review --denials …` keeps hosts seen on 3+ machines and writes a policy patch plus a Markdown summary with three choices per host.
- **Telemetry** is off by default. With an OTLP endpoint in the managed config and telemetry switched on, Kerb sends one metrics batch per session to your collector, never commands, output, paths or usernames.

The full specification is [docs/KERB.md](docs/KERB.md).

## Commands and exit codes

| Command | What it does |
|---|---|
| `kerb run [--timeout d] [--idle d] [--budget n] [--key k] [--class c] -- <cmd>` | Pre-check, run supervised, shape output, record |
| `kerb wait-for [--until …] [--interval 5s] [--max 3m] [--backoff] -- <cmd>` | Poll inside one call |
| `kerb check -- <cmd>` | Pre-check only; never runs anything |
| `kerb init` / `kerb uninstall` / `kerb doctor` | Set up, remove, diagnose |
| `kerb status` / `kerb why [id]` / `kerb history` / `kerb diff a b` / `kerb map` | Look around |
| `kerb report [--since 7d] [--estimate]` / `kerb recap` / `kerb statusline` / `kerb card` / `kerb watch` | See the saves |
| `kerb ack` / `kerb reset` / `kerb forget` / `kerb config set` | Human-only: each asks you to type a code at the terminal |
| `kerb policy keygen\|sign\|verify\|lint`, `kerb export-denials`, `kerb review` | Platform teams |

Every command takes `--json` (one JSON object), `--cwd <dir>` and `--no-color`.

| Exit code | Meaning |
|---|---|
| the command's own | It ran; passed through unchanged |
| 75 | Refused by Loopbreaker |
| 77 | Refused by the Boundary Map (or a human-only action) |
| 124 / 125 | Total / idle timeout; the whole process tree was killed |
| 64 / 70 / 71 | Usage error / internal error / state file damaged |

Exit codes can collide with a tool's own codes, so **trust the `kerb:` line** (or `"refused": true` in JSON), not the code alone.

## Honest numbers

`kerb report` has two sections, labelled.

- **Measured:** runs by class and tier, refusals by reason, re-runs avoided (refusals whose matched run exists), the run time and output those runs took, polls folded (attempts, not turns), bytes trimmed, hangs killed, walls learned, and loop checks skipped for the hash budget.
- **Estimated**, only if you set a price (or pass `--estimate`): tokens × your input price, with the formula and every assumption printed. A refusal still costs the agent a turn to read, so Kerb never reports "turns saved".

What we have measured so far, on one Apple Silicon laptop (8 cores, a 5,000-file git repo, warm, end to end including process start; raw results in [`bench/results/`](bench/results/)): the `PreToolUse` hook takes p95 69 ms for an ordinary command and 98 ms for a check command with a previous failure (which must hash the workspace) with the standalone binary; with `npm install` on Node 20 the same cases take 82 ms and 136 ms, of which ~44 ms is Node's own start-up. The task benchmark (success rate, turns and tokens with and without Kerb) has not been run yet; its harness is in [`bench/`](bench/), and no savings figure will appear here until it has.

## Security

- **Deny-only.** Kerb can make an agent do less. Its hooks never return "allow" or "approve", never rewrite a command, and never suggest a way around a block.
- **No agent bypass.** There is no flag or variable an agent can set to switch Kerb off. The hook refuses `kerb ack|reset|forget|config|uninstall`, `run --force` and any `KERB_*` variable, and those actions need a code typed at your terminal.
- **Fail open.** If Kerb breaks or runs out of time, the command runs and the problem is logged and counted (`kerb doctor` shows it).
- **No surprise network.** The only network calls are to an org bundle URL or telemetry endpoint an admin configured.
- **Not a security boundary.** Kerb reduces waste; your firewall and platform policy remain the enforcement.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## FAQ

**Will it block legitimate retries?** It tries very hard not to. Kerb judges by the actual state of the files in the command's package and of the environment, not by the command text. Any setup command in between (an install, a server start, a migration) makes a retry legitimate, so do changed dependency markers (`node_modules`, virtualenvs) and selected environment variables. One retry of a flaky network failure is always allowed, and "service not up yet" failures get a cooldown and a pointer to `kerb wait-for`. Cloud CLIs are never loop-refused. If it ever refuses wrongly, `kerb why` shows the evidence; please [report it](.github/ISSUE_TEMPLATE/false-refusal.md), since every false refusal becomes a regression test.

**Is it fast in a big monorepo?** Check commands hash only their own package plus root-level shared files, using `git status` (with fsmonitor and the untracked cache when your repo enables them). On a 100,000-file repo with both enabled that took about 80 ms warm in our test. If hashing ever exceeds its budget (300 ms in hooks), Kerb skips loop checks for that call and lets the command run; `kerb doctor` reports how often that happens.

**Does it send data anywhere?** No, unless an admin configures an org bundle URL or a telemetry endpoint. Everything else stays in `.kerb/` in your repo and `~/.kerb/`.

**How is it different from RTK?** RTK compresses the output of 100+ CLI commands. Kerb stops the command from running at all when it can't help, and its output shaping is generic. They compose: "RTK saves tokens inside each call. Kerb saves the calls that shouldn't happen."

**Why not a flag to skip it?** Because an agent in a debugging spiral would set it on every command. Legitimate retries are handled by Kerb's own rules; a person can run `kerb ack` or `kerb run --force` at their terminal.

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md); it explains how to add a denial signature, a transient pattern or an agent adapter.

## License

[Apache-2.0](LICENSE)
