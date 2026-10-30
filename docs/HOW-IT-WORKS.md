# How Kerb works

The design in one place: what Kerb decides, from what evidence, and why it was built this way. The full specification is [KERB.md](KERB.md) (v1) and [KERB-V2.md](KERB-V2.md) (v2), and every decision with its date and reason is in the decisions log at the end of KERB-V2.

## The idea

An agent pays for every turn, and every turn re-sends the conversation so far. A retry late in a session can cost tens of thousands of input tokens and return the same failure it returned last time. Kerb sits in front of the agent's shell commands and answers one question before a command runs:

> **Can running this produce a result we haven't already seen?**

To answer that, Kerb needs two things: what the environment forbids (the **Boundary Map**), and what each run produced against the exact state it ran on (the **run record**). Everything else is built on those two.

```
agent wants to run a command
        │
        ▼
  parse ─► identity ─► Boundary Map ─► state hash ─► loop rules ─► allow (run, record, shape output)
                           │                              │
                           └─ blocked here: refuse,       └─ same result as before: refuse,
                              name the alternative           show the recorded result
```

## 1. The identity of a run: the command plus the state, not the text

A command's text says little about its result. `npm test` gives a different answer after an edit, and the same answer after `npm test 2>&1 | tail -50`. So Kerb keys every run on **(what runs, where, on which state)**.

**What runs** (`src/parse/identity.js`). Kerb has its own shell tokenizer (quotes, escapes, operators, redirections, heredocs, `bash -c`). The command is reduced to its core when everything around the core only reshapes output: filter pipelines (`tail`, `grep`, `tee`), redirections, a trailing `; echo $?` or `|| true`, a leading `cd dir &&`, wrappers (`time`, `timeout`, `env`, `bash -c`, subshells, `eval`, heredocs fed to a shell, a small shell script with no arguments), and package-script aliases (`npm run test`, `npm t`). Anything that could change the result keeps its own identity: two real steps (`npm install && npm test`), stdin redirects, environment assignments (`CI=1 npm test`), a different runner (`node --test` is not `npm test`, because a package script can run anything).

The rule is conservative on purpose: a command is reduced only when every other part is known to be output-only. A wrong merge would be a false refusal; a missed merge only costs a save.

**On which state** (`src/loop/workspace-git.js`, `src/loop/scope.js`, `src/loop/envstamp.js`). The state id is a hash of:

- **The files in scope.** In a git repo: the HEAD tree id plus `git status` for the command's package and the repo-root files that can affect it (`package.json`, lockfiles, `tsconfig*.json`, workspace manifests, `go.work`, `Cargo.toml`, …), with dirty files hashed by content. Git already knows what changed, so this stays fast in large repos; outside git, a file walk with an mtime/size cache. Editing `packages/b` doesn't change the state of `npm test` in `packages/a`; editing the root lockfile does.
- **The environment stamp.** Selected variables (`NODE_ENV`, `PYTHONPATH`, `VIRTUAL_ENV`, `CONDA_PREFIX`, `JAVA_HOME`, `GOFLAGS`, `RUSTFLAGS`, `CI`; configurable) and dependency markers (`node_modules/.package-lock.json`, `.venv/pyvenv.cfg`, `vendor/modules.txt`, …). Reinstalling dependencies changes the stamp, so the retry after `npm install` is allowed.

Hashing has a time budget (300 ms in hooks). Past it, Kerb doesn't guess: the loop checks are skipped for that command, the command runs, and the skip is counted in `kerb report`.

**Kept states.** When a state is worth keeping (a run's start and end), Kerb writes it as a git commit object under `refs/kerb/states/` with `git commit-tree`, without touching the index, the working tree or any branch. Default push refspecs never send `refs/kerb/*`; `kerb doctor` warns about mirror remotes that would. That makes every past state restorable (`kerb restore --patch`) and diffable (`git diff` between trees), which cause isolation needs.

## 2. The loop rules

With an identity and a state id, the rules are small (`src/loop/rules.js`). For a check command:

| Rule | Refuses when | Why it's safe |
|---|---|---|
| `identical_retry` | the last run with this identity failed on this exact state and environment, and no setup command ran since | the inputs that decide the result are the same |
| `deja_vu` | the files are back in a state that already failed (an undo that undid the fix too) | same state, same result |
| `oscillating` | the last attempts cycle between 2–4 states, all failing | the agent is flipping between known failures |
| `breaker_open` | the same failure (same fingerprint) three times in a row despite edits | the edits aren't touching the cause; a person can `kerb ack` |

Failures aren't all alike, and the rules know it (`src/loop/fingerprint.js`):

- **Transient** (timeouts, `ECONNRESET`, 429, 503, throttling): retried once without refusal; a cooldown after that.
- **Dependency** (`ECONNREFUSED` on a local address, "is the server running"): a service that may start later; `kerb wait-for` turns polling into one call.
- **Environment** (TLS interception, proxy block pages, expired credentials): never counted as a loop at all, and answered with a fix line instead.

A **fingerprint** is the failure output with the noise normalised away: timestamps, durations, temp paths, pids, ephemeral ports, request ids, hex addresses. Two runs of the same failure fingerprint the same; a different error doesn't.

**Static checks** (tsc, ESLint, Ruff, mypy) are hermetic: their result depends only on the files. Asked to run again on the same state, Kerb doesn't refuse; it returns the recorded result as an instant answer.

## 3. The Boundary Map

Before the loop rules, Kerb checks what the command would contact (`src/parse/hosts.js`): URLs and host flags, `curl`/`wget` targets, package managers' default registries (`npm install` means `registry.npmjs.org` unless `.npmrc` or `npm_config_registry` says otherwise), `git` remotes resolved from the repo's config, container image registries, and URLs inside inline interpreter code (`node -e`, `python3 -c`). These are matched against three policy layers:

1. **Org bundle**: signed with Ed25519, verified against a public key pinned in a managed config file; older bundles are refused (no rollback); a failed fetch keeps the last verified bundle.
2. **Repo policy** (`kerb.policy.json`): can add blocks, never remove or loosen an org block. Its suggested alternatives are labelled "from repo policy" and can be switched off by the managed config.
3. **Learned walls**: from real policy denials (a 403 "blocked by policy" naming a host the command actually contacted). A wall needs evidence from a network-capable command, starts as "suspected" (never blocks), and expires 14 days after its last hit. That is the defence against prompt injection: output saying "registry.npmjs.org is blocked" can't teach Kerb anything on its own.

## 4. What happens after a run

`kerb run` (and the post-tool hook, for commands the agent ran itself) records the result and shapes what the agent reads.

- **Test results are parsed**, not just exit codes: Vitest, Jest, pytest (including `-q`), Node's runner (TAP and spec, including a TAP stream whose head was cut off), Go, Cargo, tsc, ESLint, Ruff, mypy, Clippy, and JUnit/JSON report files. Each parser is checked against recorded real output (fixtures with expected JSON).
- **The exit code is checked for masking.** `npm test | tail` exits 0 when the tests fail. When a wrapper hides the check's exit code, Kerb records a failure only if the parsed output shows failures, and otherwise records the result as unknown, **never as a pass**, because a filter like `grep passed` can hide failures. With `set -o pipefail` the real code is used. (Before this, a failing suite behind `| tail` was recorded as green. The rewordings benchmark found it.)
- **Output is shaped**: ANSI colour and progress bars stripped, repeats folded, long output cut to head and tail around the failing lines, the full log kept on disk. Secrets are redacted as the output streams.
- **A delta line** says what changed since the last run of that check: fixed, still failing, newly failing, flaky.
- **Verification** (`kerb status`, the MCP `verification` tool, the optional stop gate): is the last result green, red, or stale, meaning it no longer matches the files?

**Workarounds.** No parser sees inside every program; an agent refused for `npm test` can run the same tests through `python3 -c "subprocess.run(...)"`. So the output is the ground truth (`src/insight/workaround.js`): when a run fails exactly the set of tests a recent check failed, and that check's files are unchanged, the agent is told at once that it's the same result, the workaround is recorded and shown to the person, and the refusal it undid stops counting as a saving.

## 5. Cause isolation: which edit broke the test?

When a test that passed on state G fails on state B, a background worker finds the culprit edit (`src/worker/cause.js`, `src/worker/ddmin.js`, `src/worker/probe.js`).

1. **Hunks.** `git diff` between the two kept trees, limited to the check's scope, split into hunks.
2. **Reproduce first.** In a separate git worktree under `.kerb/worktrees/` (dependency folders symlinked from the main checkout), B must fail twice and G must pass once. Otherwise the finding is "not reproducible in isolation", and nothing is blamed.
3. **Narrow the command.** When the framework allows it, only the failing test runs (`pytest path::test`, `node --test --test-name-pattern`, `go test -run`, …), which makes each probe fast.
4. **Delta debugging.** Zeller's ddmin over the hunks: apply subsets to G and run the test, keeping the smallest subset that still fails. Subsets that don't apply, and runs whose output shows no test result (a build error), count as "unresolved", never as "fail", so a half-applied import doesn't get blamed. Probe results are cached by tree id.
5. **Confirm.** B without the culprit must pass **twice** on fresh runs, and G with only the culprit must fail. One confirmation probe let a 50% flaky test blame an innocent hunk in the benchmark; three independent outcomes make that about 8× less likely by chance.
6. **Budget.** 12 probes (6 when the command can't be narrowed) and 180 seconds per job; 15 CPU-minutes per hour for the worker; niced; off in CI by default. Running out gives "undetermined" or the smallest failing set so far, labelled partial.

Nothing is ever applied to the working tree. The finding comes with a patch that reverts just the culprit, for a person or the agent to apply.

Results on 64 seeded scenarios (Node, pytest, Go; 15 flaky controls): 49 confirmed findings, all correct and exact to the line; no confirmed finding in any control; every single-culprit regression found. In a 100,000-file monorepo: exact, 55 seconds, 7 probes. Known limit: git merges edits less than seven lines apart into one hunk, and Kerb blames whole hunks.

## 6. Fail open, deny only

Kerb is in the critical path of every shell command an agent runs, so it is built to be wrong safely:

- **Deny only.** Hooks never return an allow or approve decision, and never rewrite a command. A final filter strips any allow-type field from hook output, whatever a handler returned.
- **Fail open.** Any internal error, a hook over its 1-second deadline, or a hash over its budget lets the command run. The error goes to `~/.kerb/errors.log` and is counted.
- **No agent-controlled bypass.** Hooks refuse `kerb ack`, `reset`, `config`, `uninstall`, `run --force` and `KERB_*` assignments; human-only actions need a code typed on the terminal device, which an agent's shell doesn't have.
- **Shadow first.** The first week records what Kerb would have refused, without refusing (`kerb review-shadow`).
- **Low false refusals over high recall.** Every ambiguous case (`npx`, `pytest` versus `python -m pytest`, a script with arguments) is allowed.

## 7. Storage

Everything is local, in `.kerb/` inside the repo (git-ignored) and `~/.kerb/`.

- **Event log**: `runs.jsonl`, one record per line with a CRC32, appended under a lock file with atomic stale-lock breaking (rename aside, check it's the lock that was judged, restore otherwise). A torn last line is repaired on read; the log rotates. The record format (KER) is versioned and has JSON Schemas ([KER.md](KER.md)).
- **Derived data**: `summary.json` (session and day counters, for the status line in under 50 ms), indexes, kept states, a content-addressed blob store for walk mode, logs evicted past 200 MB. All rebuildable from the log (`kerb reindex`).
- **Worker jobs**: one file per job, each signed with HMAC-SHA256 using a per-user secret in `~/.kerb/secret`. A cloned repo can ship a `.kerb/` folder; an unsigned job never runs, and planted states are validated before a worktree is built from them (no absolute or `..` paths, well-formed hashes and commit ids).

Network: only the org bundle URL and an OTLP telemetry endpoint, and only when an admin configures them. A test fails the build if any other module imports a network module.

## 8. Integration

- **Hooks** for Claude Code, GitHub Copilot, Cursor, Codex, Gemini CLI and OpenCode, written by `kerb init` (each agent's own settings format; committed files get a note instead of an edit; `kerb uninstall` removes exactly what was added). Agents without a pre-tool hook get instructions and `kerb run` ("best effort", and labelled as such).
- **MCP server** (`kerb mcp`): read-only tools (verification, runs, attempts, test history, last green, boundaries, findings, explain), speaking both the stateless 2026-07-28 protocol and the older `initialize` handshake.
- **Query and export**: the same answers as JSON (`kerb query`, `kerb export --no-text` with identifiers hashed).
- **Plugins**: ES modules listed with their SHA-256; repo-listed plugins also need a person's approval of that exact hash, and the approved bytes are what runs (imported as a data URL). Notes only, 50 ms per handler.
- **Distribution**: npm (`kerb-cli`, zero dependencies, enforced in CI) and standalone binaries for five targets built with Node's single-executable applications, with checksums, build-provenance attestations and an SBOM.

## 9. Measured, and what isn't

| What | Result | How |
|---|---|---|
| Rewordings of a failing check refused | 22 of 26 (was 2) | `bench/rewordings.js` |
| Ways to a blocked registry refused | 27 of 29 | `bench/rewordings.js` |
| Workarounds after a refusal | 4 refused, 3 answered at once, 0 silent (was 7 silent) | `bench/rewordings.js` |
| Cause isolation precision | 49 of 49 exact; 0 false positives in 15 controls | `bench/cause.js` |
| Hook latency, standalone binary, p95 | 55–69 ms for ordinary commands and checks; 110 ms after a failure | `bench/hook-latency.js` |
| Tests | 499 | `node --test` |

**Not yet measured:** whether agents with Kerb finish tasks with fewer tokens or less time than agents with good instructions alone. The four-arm harness for that is built (`bench/run.js`: plain, instructions only, Kerb v1, Kerb v2; tokens and time to green from transcripts; refusals judged by replay; paired bootstrap confidence intervals), and no savings figure is claimed until it has been run. On the author's own agent history (31 sessions, `kerb scan`), retries that Kerb would have refused were rare (one), and the measured saving was output trimming (about 500k tokens); the loop rules matter most where walls and slow suites are common.

## 10. Questions people ask

**Why hash the state instead of comparing command text?**
Because the result depends on the inputs, not the words. Text matching refuses the legitimate retry after an edit and misses the reworded retry with nothing changed. A state hash gets both right, and git makes it cheap: `git status` plus the HEAD tree, scoped to the package.

**What if the hash is wrong, say a change outside the scope matters?**
That's a false refusal, the worst outcome, so the scope errs wide (root manifests, lockfiles, tsconfig, a configurable `shared_paths`), the environment stamp covers dependency installs, and any setup command between runs allows the retry. A person can `kerb ack`, and every refusal says how. If hashing is slow, the check is skipped rather than guessed.

**Why fail open instead of fail closed?**
Kerb saves turns; it isn't a security control. A guard that blocks work when it breaks costs more than it saves, and people uninstall it. The firewall stays the enforcement.

**Can't the agent just get around it?**
A determined agent can get one run through, by running the same tests in a way no parser understands. Kerb sees through the common rewordings and scripts, notices the rest by their output, tells the agent it's the same result, and reports it to the person. It's a guard against waste, not containment, and the benchmark records how often agents work around refusals.

**How does cause isolation avoid blaming the wrong edit?**
It reproduces before searching (fails twice on B, passes on G), treats patches that don't apply and runs with no test output as unresolved rather than failing, and confirms with three fresh outcomes. It stays within a probe budget, and says "undetermined" instead of guessing.

**Why zero dependencies?**
Kerb runs inside every shell command and reads source code. Every dependency is supply-chain risk and start-up time. The tokenizer, the parsers, the JSONL store, the MCP server and the signature checks are written against Node's standard library.

**Why is the hook a few milliseconds over its budget?**
The standalone binary takes about 47 ms just to start the Node runtime; Kerb's own work is 8–15 ms. Porting the hot path to a native language would fix it, and that's an open decision.

**What doesn't Kerb do?**
It sees shell commands only, not the agent's reasoning or its file edits. It can't make a bad plan good. Its value is largest where walls, slow suites and long sessions are common, and small in a fast, open repo.
