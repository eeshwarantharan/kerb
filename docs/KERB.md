# KERB.md

**Kerb keeps your coding agent on the road.** It stops AI coding agents from wasting turns on actions the environment forbids, and on retries that cannot help, and it shows developers every save.

This one document is the whole project: product context, the behaviour contract, the architecture, the build plan, the acceptance tests, and the launch plan. It lives in the repo at `docs/KERB.md` and stays the source of truth for the life of the project.

---

## 0. How to use this document

**For the human:** read sections 1 and 2 to understand the product. Section 12 is the launch plan.

**For the building agent** (Claude Opus or similar):

1. Create an empty folder, run `git init`, and save this file as `docs/KERB.md`. Commit it first.
2. Read the whole document before writing code. Section 4 (the spec) wins over everything else, including your own judgement. Section 10 is the order of work; section 11 lists the checks that define "done".
3. Where the spec says **VERIFY**, read the current official documentation of that agent or tool before implementing. If reality differs from the spec, use the fallback the spec names, and record what you found in section 13 (Decisions log), with the date and the doc URL.
4. If the spec is ambiguous, choose the simplest reading that keeps false refusals low, write it in section 13, and continue. Never stop to ask unless an action is irreversible.
5. After each build step: run `node --test`, then commit with a message naming the step. Keep this file in the repo and keep it up to date.

---

## 1. Product

### 1.1 The problem

Coding agents burn paid turns in four quiet ways:

1. **Hitting walls.** In locked-down environments, agents try blocked registries, hosts, tools and protected branches. They fail, and often retry, because nothing told them the boundary in advance. Public evidence: one week of GitHub's own agent workflows had 611 of 2,019 requests (30.3%) blocked, and one run died after seven permission-denied retries.
2. **Going in circles.** Re-running a failing test without changing anything, editing back into a state that already failed, hitting the same failure again and again despite edits, or polling a service by re-running a command turn after turn.
3. **Drowning in noise.** Progress bars, colour codes and 50,000-line logs poured into the context window.
4. **Hanging.** Watch modes, password prompts and servers that never exit.

Every retry re-sends the whole conversation, so these are the most expensive tokens an agent spends, and they buy nothing.

### 1.2 What Kerb is

A zero-dependency command guard that sits between any coding agent and its shell.

- **Boundary Map:** knows what this environment forbids, refuses it *before* it runs, and names the approved alternative. Learns new boundaries from real policy denials, so each wall is hit once.
- **Loopbreaker:** knows what was already tried, judged by the actual state of files and environment, and refuses retries that cannot help.
- **`kerb wait-for`:** turns polling into one call. Kerb retries internally and returns once.
- **Output shaping:** strips noise, trims long output to a head and tail, and keeps the full log.
- **Supervisor:** timeouts and idle timeouts that kill the whole process tree.
- **Visible saves:** a status line, a session recap and a shareable card show the developer what Kerb did, with honest numbers.
- **Org policy:** a signed, versioned policy bundle lets a platform team give every agent the company's current rules.

### 1.3 Who it is for

| Persona | What they want | What Kerb gives them |
|---|---|---|
| Individual developer using Claude Code, Copilot, Codex or Cursor | Agents that don't waste time and money, without setup | `kerb init`, then silence until it saves something |
| Developer in a locked-down enterprise | Agents that respect company rules instead of fighting them | Boundaries up front, approved alternatives, no retries against walls |
| Platform or developer-tools team | Safe, governable agent use across hundreds of developers | Signed org policy, learned-denial review, OpenTelemetry to their own collector |

Adoption starts with individual developers. The org features pay off once a platform team maintains a policy repo, so the individual experience (section 2) must stand on its own.

### 1.4 Principles

1. **False refusals are the enemy.** One wrong refusal costs more trust than ten saves earn. When unsure, allow and record.
2. **Deny-only.** Kerb can make an agent do less. It never grants access, never auto-approves anything, and never suggests a way around a block.
3. **No agent-controlled bypass.** Anything an agent can set to switch Kerb off, an agent in a debugging spiral will set. Legitimate retries are handled by Kerb's own rules (setup commands, environment changes, cooldowns, `wait-for`), never by a flag the agent controls.
4. **Silent until useful.** No output when nothing happens. One sentence when something does.
5. **Honest numbers.** Measured and estimated numbers are always labelled differently. Nothing is claimed that wasn't measured.
6. **Zero dependencies, no surprise network.** The only network calls are ones an admin explicitly configured (org bundle, telemetry endpoint).
7. **Fail open.** If Kerb itself breaks or runs out of time, commands still run and the problem is reported.

### 1.5 Non-goals

- Blocking dangerous commands for security (tools like GuardRail do that; Kerb can run beside them).
- Command-specific output compression for 100+ tools (RTK does that; Kerb's shaping is generic and composes with it).
- Model routing, orchestration, or running agents.
- Being a security boundary against a hostile agent. Kerb reduces waste; the firewall and platform policy remain the enforcement.

### 1.6 Landscape and positioning

| Tool | What it does | How Kerb differs |
|---|---|---|
| RTK | Compresses output of 100+ CLI commands | Kerb stops the command from running at all when it can't help |
| context-mode | Keeps MCP and tool output out of context | Complementary, different layer |
| Loop detectors in Kilocode, OpenRouter SDK, pi-anti-doom-loop | Block repeated identical tool calls by comparing arguments | Kerb judges by file and environment state, so it catches déjà vu and repeated failures despite edits, and allows legitimate repeats |
| GuardRail, policy gateways, MCP allowlists | Enforce what agents may do, for admins | Kerb tells the *agent* its boundaries before it tries, and learns them across a team |

**Tagline:** "RTK saves tokens inside each call. Kerb saves the calls that shouldn't happen."

---

## 2. Experience

### 2.1 First five minutes

```bash
brew install eeshwarantharan/tap/kerb   # or download a binary, or: npm install -g kerb-cli
cd my-repo
kerb init                  # detects agents, installs hooks, status line, skill, AGENTS.md block
kerb doctor                # everything green, or exact fixes
```

`kerb init` prints what it changed, file by file, whether each agent is **enforced** (native hook) or **best effort** (instructions only), and how to undo it (`kerb uninstall`).

### 2.2 The moments the developer sees

1. **The save.** A refusal is three short lines with a distinct `kerb:` marker. Coloured when the output is a terminal, plain otherwise.

   ```
   kerb: policy_blocked · registry.npmjs.org is blocked here
         source: org policy v42
         next: use https://npm.corp.internal instead
   ```

2. **The status line.** Always visible in agents that support one:

   ```
   kerb · 3 re-runs avoided · 1.2 MB noise trimmed · 4 walls known
   ```

3. **The recap.** When the agent session stops:

   ```
   kerb recap · this session (enforced via Claude Code hooks)
     re-runs avoided   3  (saved 2m 14s of run time, ≈ 11k tokens of output)
     polls folded      9 attempts in 1 call
     noise trimmed     1.2 MB → 38 KB shown
     walls             1 new, learned from a policy denial
     hangs killed      1
   ```

4. **The card.** `kerb card --week` renders an SVG and an HTML page the developer can share. Measured numbers plainly; estimates marked "est.".

5. **The live view.** `kerb watch` in a second terminal shows commands as they run, with refusals highlighted.

### 2.3 Message style

- Lower-case reason code, a middle dot, one plain sentence.
- Evidence line: the run it matches, the source of the rule, or the files involved.
- `next:` line: one concrete action. Never a workaround to a block.
- No exclamation marks, no emoji, no "please", no apologies.

---

## 3. Concepts

| Term | Meaning |
|---|---|
| Command | What the agent asked to run, as one shell string |
| Segment | One simple command inside a compound command (split on `&&`, `\|\|`, `;`, `\|`, newlines) |
| Key | The identity of a command for loop tracking (4.7.1) |
| Class | `check` (test, build, lint, typecheck), `query` (grep, ls, cat, diff…), `background`, or `other` |
| Scope | The part of the repo a check command depends on: its package, plus root-level shared files (4.7.2) |
| Workspace hash | A hash of the content and exec bit of all non-ignored files in scope |
| Env stamp | A hash of selected environment variables and dependency markers (4.7.3) |
| Fingerprint | A hash of normalised output, so two failures with the same meaning match |
| Transient failure | A failure caused by a flaky network, a timeout, throttling or a gateway error; one identical retry is always allowed |
| Dependency-unavailable failure | A failure because a local service or database isn't up yet; identical retries are allowed again after a cooldown |
| Boundary | A rule saying something is blocked here, with an optional alternative |
| Refusal | Kerb declining to run a command, with a reason, evidence and a next step |
| Save | A refusal, a folded poll, a trimmed output, or a killed hang |
| Tier | **Enforced** when Kerb sees commands through a native hook; **best effort** when it relies on the agent following instructions |

---

## 4. Specification

### 4.1 Commands

| Command | Behaviour |
|---|---|
| `kerb run [opts] -- <command>` | Pre-check, run under the supervisor, shape output, record |
| `kerb wait-for [opts] -- <command>` | Pre-check once, then run the command repeatedly until a condition holds (4.7.8) |
| `kerb check [--json] -- <command>` | Pre-check only. Never runs anything. Exit 0 if it would run |
| `kerb init [--agent <name>] [--dry-run] [--refresh]` | Detect agents and wire Kerb in (4.10). Idempotent. `--refresh` rewrites hook paths after an upgrade |
| `kerb uninstall` | Remove everything `init` added, using the markers it wrote |
| `kerb doctor` | Check installation, hook paths, policy, signature, state health, hashing speed. Print fixes |
| `kerb status` | Tier per agent, boundaries in effect, open breakers, last 5 runs, session totals, coverage |
| `kerb why [run-id]` | Explain a refusal (default: the latest) with evidence |
| `kerb history [-n N] [--key K]` | Recent runs, newest first |
| `kerb diff <runA> <runB>` | Files that differ between two runs' snapshots, and whether fingerprints match |
| `kerb map` | Every boundary with source, status, hits and expiry |
| `kerb report [--since 7d]` | Measured and estimated savings (4.12) |
| `kerb recap` | Session recap (4.11.3) |
| `kerb statusline` | One status line for agents that render one (4.11.2) |
| `kerb card [--week\|--session] [--out dir]` | Shareable SVG and HTML card (4.11.4) |
| `kerb watch` | Live view of runs in this repo (4.11.5) |
| `kerb ack [key]` | Human-only: allow one more trial for an open breaker (4.7.7) |
| `kerb reset [key]` | Human-only: clear loop state for a key or all keys |
| `kerb forget <pattern>` | Human-only: remove a learned boundary |
| `kerb policy keygen\|sign\|verify\|lint` | Tools for platform teams (4.8.4) |
| `kerb export-denials [--since 7d]` | Export learned boundaries for team review (4.8.5) |
| `kerb review --denials <file…>` | Turn exported denials into a policy patch for admin review (4.8.5) |
| `kerb hook <agent> <event>` | Hook handler entry point (4.10) |
| `kerb config get\|set <key> [value]` | User settings (4.13) |

Global flags: `--json` (exactly one JSON object on stdout, nothing else), `--cwd <dir>`, `--no-color`.

`run` options: `--timeout <dur>`, `--idle <dur>`, `--budget <bytes>`, `--key <name>`, `--class <check|query|other>`, `--force` (human-only).

### 4.2 Exit codes

| Code | Meaning |
|---|---|
| child's code | The command ran; passed through unchanged |
| 75 | Refused by Loopbreaker |
| 77 | Refused by Boundary Map |
| 124 | Total timeout, or `wait-for` gave up; process tree killed |
| 125 | Idle timeout; process tree killed |
| 64 | Usage error |
| 70 | Internal Kerb error (the hook never surfaces this; see 4.10.1) |
| 71 | State corrupt mid-file; nothing modified |

Exit codes can collide with a child's own codes (for example 77 means "skip" in automake harnesses). **The authoritative signal is the `kerb: <reason>` line on stderr, or `"refused": true` in JSON.** Agent instructions say so explicitly. A refusal never runs the child, so a refusal line and a child exit code never appear together. Codes 75 and 77 are configurable (`KERB_EXIT_LOOP`, `KERB_EXIT_POLICY`, set by the human or managed config).

### 4.3 Refusal format

Human form, on stderr:

```
kerb: <reason> · <summary>
      <evidence>
      next: <action>
```

JSON form: `{"refused":true,"reason":"…","key":"…","summary":"…","evidence":{…},"next":"…","exit":75,"run":"<matched run id or null>"}`.

All three lines are templates filled with validated fields: hosts, run ids, file paths (max 10, relative), counts, durations. Raw command output never appears in a refusal, except the redacted first failing line (max 120 characters) in loop evidence.

### 4.4 Command parsing

Kerb parses each command into segments with a small tokenizer (no dependencies):

1. Respect single quotes, double quotes and backslash escapes. On a parse failure, treat the whole command as one opaque segment of class `other` (allow; never refuse on a parse failure).
2. Split on unquoted `&&`, `||`, `;`, `|`, `&` and newlines. Record whether the command ends with `&` (background).
3. Per segment, strip leading `VAR=value` assignments and these wrappers, repeatedly: `sudo` (with its flags), `env` (with its assignments), `nohup`, `time`, `command`, `exec`, `nice`, `timeout <dur>`.
4. Unwrap one level of `bash -c "…"`, `sh -c "…"`, `zsh -c "…"` and parse the inner string.
5. Track `cd <dir>` segments so later segments resolve relative paths (used for `.npmrc` lookup and package scope) against the new directory.
6. The first remaining word is the segment's **program**; the rest are its **args**.

**Command class** (first match wins, per segment; the command's class is the "strongest" segment: background > check > other > query):

- `background`: the command ends with `&`, uses `nohup` or `setsid`, or the agent marked it as background (for example `run_in_background`).
- `check`: matches the default check list or policy `check_commands`. Defaults: `npm|pnpm|yarn|bun (run )?(test|build|lint|typecheck|check)`, `npx|pnpm dlx (jest|vitest|mocha|tsc|eslint|prettier --check)`, `jest`, `vitest`, `mocha`, `tsc`, `eslint`, `pytest`, `python -m pytest|unittest|mypy`, `mypy`, `ruff check`, `go test|build|vet`, `cargo test|build|check|clippy`, `make` (any target), `mvn test|verify|package`, `gradle(w)? test|build|check`, `dotnet test|build`, `swift test|build`, `rspec`, `bundle exec rspec|rake`, `phpunit`, `deno test|lint|check`.
- `query`: `grep`, `rg`, `ag`, `find`, `ls`, `cat`, `head`, `tail`, `wc`, `diff`, `cmp`, `test`, `[`, `which`, `command -v`, `type`, `stat`, `file`, `pwd`, `echo`, `printf`, `sleep`, `git status|diff|log|show|branch|rev-parse|ls-files`, `jq`.
- otherwise `other`.

Cloud and infrastructure CLIs (`aws`, `gcloud`, `az`, `terraform`, `kubectl`, `docker`) are `other` by default, so Loopbreaker never refuses their retries. Teams can opt specific ones into `check_commands`.

### 4.5 Supervisor

1. stdin is `/dev/null`. The child runs via `/bin/sh -c <command>` in its own process group (`detached: true`) on macOS and Linux.
2. **Background commands are never supervised or shaped.** `kerb run` on a background-class command execs it directly with the agent's normal behaviour, after the pre-check only, and records it with class `background`.
3. **Timeouts.** Total default: when invoked from a hook that knows the agent's tool timeout, that timeout minus 10 seconds; otherwise 30 minutes. Idle default: 10 minutes without any output. On expiry: SIGTERM to the process group, wait 3 seconds, SIGKILL the group. This must kill grandchildren that trap SIGTERM.
4. **Signals to Kerb.** On SIGINT, SIGTERM or SIGHUP, Kerb forwards SIGTERM to the group, escalates as above, records the run as `aborted`, and exits 130, 143 or 129.
5. **Orphan reaping.** Every `start` record stores the child's PGID. At the start of every Kerb invocation, for any `start` without an `end` whose Kerb PID is dead, Kerb records it as `aborted` and, if its process group still exists, sends SIGTERM then SIGKILL to it. (This covers Kerb itself being SIGKILLed by the agent's own timeout.)
6. **Concurrent runs of the same key** are allowed. Loop checks only consider finished runs. If a run of the same key with the same workspace hash is already in progress, print one note (`kerb: note · the same command is already running as <run>`) and continue.
7. **Windows.** Spawn with `shell: true`; kill the tree with `taskkill /pid <pid> /T /F`; skip the exec bit in hashes. Idle timeout, shaping and all checks behave the same.

### 4.6 Output shaping

Streaming, bounded memory: Kerb never holds more than `budget + 64 KB` of output in memory, regardless of output size.

Pipeline, applied to stdout and stderr interleaved in arrival order:

1. **Raw log:** every chunk is redacted (4.14.3) and appended to `.kerb/logs/<run-id>.log`. Redaction is streaming-safe: keep a 512-byte carry-over between chunks so a secret split across two chunks is still caught.
2. **Binary:** if the first 8 KB contain a NUL byte, stop shaping; show only `[kerb] binary output, <N> bytes · log <path>`.
3. **Strip** ANSI CSI and OSC escape sequences.
4. **Carriage returns:** within each line, keep only the text after the last `\r`.
5. **Repeats:** 3 or more identical consecutive lines become the line plus `[kerb] previous line repeated <N> more times`.
6. **Budget** (default 12,000 bytes): keep a head buffer (first 25% of the budget) and a ring buffer of lines for the tail (last 75%). Cuts are at line boundaries and never inside a UTF-8 character. The join line is `[kerb] <N> lines omitted · log <path>`.
7. **Footer** on stderr, **only when** output was cut, the command failed, it timed out, or Kerb has a note: `kerb: exit <code> · <duration> · <raw> → <shown> · log <path>`. Successful, uncut commands get no footer, so small commands cost zero extra tokens.

### 4.7 Loopbreaker

#### 4.7.1 Key

`key` = `--key` if given; otherwise the repo-relative cwd, `::`, and the command with runs of whitespace collapsed to one space and leading `VAR=value` assignments kept (they change behaviour).

#### 4.7.2 Workspace hash

**Scope.** A check command depends on its own package, not the whole repo:

- The **package root** is the nearest ancestor of the segment's cwd (stopping at the repo root) that contains a project manifest: `package.json`, `pyproject.toml`, `setup.py`, `setup.cfg`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `*.csproj`, `*.sln`, `Gemfile`, `composer.json`, `deno.json`, `Package.swift`.
- The **scope** is the package root plus these repo-root files if present: the root manifest and workspace config (`package.json`, `pnpm-workspace.yaml`, `go.work`, `Cargo.toml`, `nx.json`, `turbo.json`, `lerna.json`), root lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `Cargo.lock`, `go.work.sum`, `poetry.lock`, `uv.lock`), root `tsconfig*.json`, and policy `shared_paths`.
- A command run at the repo root has the whole repo as scope. Policy `hash_scope: "repo"` forces whole-repo scope everywhere.

**Git mode** (default inside a git repo):

- Base: the tree id of the scope at `HEAD` (`git rev-parse HEAD:<package path>`, or `HEAD^{tree}` at the root), plus the blob ids of the root shared files at `HEAD`.
- Dirty set: `git status --porcelain=v2 -z --untracked-files=all -- <scope paths>`. Git compares its index stat data, including ctime by default, so an edit with its mtime restored is still reported. It also uses the file-system monitor and untracked cache when the repo enables them, which is what keeps this fast in large repos.
- For each dirty path: `sha256(path \0 status \0 exec-bit \0 content-hash)`; deletions hash as `path \0 deleted`.
- Workspace hash: `sha256(base ‖ sorted dirty hashes)`.
- If the repo has `core.trustctime=false`, content hashes of files git reports as unchanged are not rechecked; `kerb doctor` warns about this setting.
- Always exclude `.kerb/` and paths matched by `.kerbignore` (gitignore syntax: `*`, `**`, `?`, trailing `/`, leading `!`).

**Walk mode** (outside git): walk the scope, skipping `.git`, `node_modules`, `.venv`, `.kerb` and `.kerbignore` matches. Per file: `sha256(path \0 exec-bit \0 content-hash)`; workspace hash is `sha256` of the sorted per-file hashes. Content hashes are cached in `.kerb/wscache.json`, keyed by path and valid only while size, mtimeMs, ctimeMs and inode all match.

**Both modes:**

- Files over 5 MB: content hash is `sha256(size ‖ first 1 MB ‖ last 1 MB)`.
- **Pre-hash and post-hash.** Every run records the hash before it starts and after it ends. Comparisons use the failed run's **post-hash** (tests that write snapshot or coverage files would otherwise never match).
- **Snapshots** per run: in git mode, the base ids plus the dirty map; in walk mode, path → content hash. Used by `kerb diff` (in git mode, `git diff --name-only` between bases plus the dirty maps) and for listing changed files.
- **Cost control:** hashes are computed only for `check`-class commands, and in a hook only when the key already has a recorded failure or is check class.
- **Hash budget:** if computing a hash takes longer than `hash_budget_ms` (default 300 ms in hooks, 2,000 ms in `kerb run`), stop, skip loop checks for this call, allow the command, and record `loop_skipped: "hash_budget"`. `kerb doctor` reports how often this happens and, for git repos, suggests `git config core.fsmonitor true` and `git config core.untrackedCache true`.
- Targets: under 100 ms for a 5,000-file repo with a warm cache; under 300 ms for a 100,000-file git repo with fsmonitor and untracked cache enabled.

#### 4.7.3 Env stamp

`sha256` of:

- the values of environment variables in policy `env_keys` (default: `NODE_ENV`, `PYTHONPATH`, `VIRTUAL_ENV`, `CONDA_PREFIX`, `JAVA_HOME`, `GOFLAGS`, `RUSTFLAGS`, `CI`);
- size and mtime of dependency markers that exist under the package root or repo root: `node_modules/.package-lock.json`, `node_modules/.modules.yaml`, `node_modules/.yarn-state.yml`, `.venv/pyvenv.cfg`, `.venv/lib` (directory mtime), `vendor/modules.txt`, `target/.rustc_info.json`, `.gradle`, plus policy `env_markers`.

So `npm install` or a new virtualenv changes the stamp, and the next test run is allowed.

#### 4.7.4 Fingerprint and failure kinds

Normalise the ANSI-stripped, redacted output, then `sha256` it. Replacements:

| Pattern | Replaced with |
|---|---|
| ISO-8601 timestamps; `HH:MM:SS` with optional fraction; common log date prefixes | `<TS>` |
| A duration (`\d+(\.\d+)?\s?(ms\|s\|sec\|secs\|m\|min\|h)`) **only** when inside parentheses, after `in `, `took `, `after `, `time:`, `duration:`, `elapsed`, `Time:`, or when it is the last token on its line | `<DUR>` |
| `0x` followed by 6 or more hex digits | `<ADDR>` |
| Paths under `/tmp/`, `/private/tmp/`, `/var/folders/`, `$TMPDIR`, `os.tmpdir()` | `<TMP>/<basename>` |
| `pid <n>`, `PID: <n>`, `process <n>` | `<PID>` |
| Ports in `localhost:<n>` / `127.0.0.1:<n>` when `n` ≥ 49152 | `<PORT>` |
| AWS-style request ids (`RequestId: <uuid>`, `x-amz-request-id`) and any UUID on a line that also contains `request` | `<REQ>` |
| Trailing whitespace; the Kerb footer | removed |

Never normalised: line and column numbers in `file:line:col`, test names, assertion values, exit codes, ordinary numbers. A test named "handles 10s timeout" keeps its text.

**Failure kinds** (checked in this order on the redacted output; first match wins):

1. **Transient:** matches any default transient pattern or policy `transient_patterns`, or ended in a Kerb timeout or idle timeout. Defaults: `ETIMEDOUT`, `ECONNRESET`, `ESOCKETTIMEDOUT`, `EAI_AGAIN`, `socket hang up`, `502 Bad Gateway`, `503 Service Unavailable`, `504 Gateway Time-?out`, `429 Too Many Requests`, `TooManyRequests(Exception)?`, `ThrottlingException`, `Throttling:`, `RequestLimitExceeded`, `SlowDown`, `ProvisionedThroughputExceededException`, `rate limit exceeded`, `RESOURCE_EXHAUSTED`, `UNAVAILABLE: ` (gRPC status). Deliberately not transient: `500 Internal Server Error` and "does not exist"-style messages, which are usually real bugs.
2. **Dependency-unavailable:** matches `ECONNREFUSED`, `connection refused`, `could not connect to server`, `is the server running`, `Can't connect to (local )?MySQL server`, `Connection to .* refused`, `no route to host` on a local or private address, or policy `dependency_patterns`.
3. **Ordinary:** everything else.

Policy patterns are regular expressions of at most 200 characters, at most 50 per list, validated by `kerb policy lint`, and applied only to lines of at most 4 KB (to bound regex cost).

#### 4.7.5 What counts as a failure

A finished run counts as a **failure** when all hold:

- exit code is nonzero;
- class is `check` (only check-class runs are loop-tracked; query, other and background runs are recorded but never refused by Loopbreaker);
- it is not classified as a policy denial;
- it is not `aborted`.

Each failure carries its kind: transient, dependency-unavailable or ordinary.

#### 4.7.6 Refusal rules

Evaluated before running a check-class command, over finished runs of the same key since the latest `ack`, `reset` or success:

1. **identical_retry.** All must hold:
   - the latest finished run R of this key is a failure;
   - current workspace hash = R's post-hash, and current env stamp = R's env stamp;
   - **no other command of class `check` or `other` has finished in this repo since R ended** (a `npm install`, a server start, a migration or any setup step in between makes a retry legitimate);
   - and, by R's kind:
     - **ordinary:** always refuse;
     - **transient:** refuse only if there has already been one identical retry after R that also failed transiently (one retry of a transient failure is always allowed);
     - **dependency-unavailable:** refuse only if less than `retry_cooldown` (default 60 s) has passed since R ended. After the cooldown, one identical retry is allowed; the cooldown then restarts from that retry.

   Evidence: R's id, its kind, and its first failing line. Next, by kind:
   - ordinary: "change something first, or run `kerb diff` to compare attempts";
   - transient: "this failed twice on a flaky dependency; wait or check it before retrying";
   - dependency-unavailable: "a service this needs looks unavailable; start it, or poll with `kerb wait-for -- <command>` (retry allowed in <n> s)".
2. **deja_vu.** Some ordinary failure F of this key, older than the latest run, has F's post-hash = current workspace hash and the same env stamp, and the latest run of this key differs in workspace hash from F. Evidence: F's id and "N attempts ago". Next: "your files match a state that already failed; try a different fix".
3. **breaker_open.** The last K finished runs of this key (K = policy `breaker_threshold`, default 3) are all ordinary failures with the same fingerprint, with at least two distinct post-hashes. Transient and dependency-unavailable failures are skipped when counting. Evidence: the union of changed files across those runs (max 10). Next: "same failure K times despite edits; step back and rethink, or ask the user to run `kerb ack`".
4. Rule order: identical_retry, then deja_vu, then breaker_open. The first match refuses.
5. If the call's loop checks were skipped for the hash budget (4.7.2), no rule applies.

#### 4.7.7 Human-only actions

`ack`, `reset`, `forget`, `config`, `uninstall` and `run --force` need a human:

1. The hook refuses any agent command that invokes `kerb ack`, `kerb reset`, `kerb forget`, `kerb config`, `kerb uninstall`, uses `--force` on `kerb run`, sets any `KERB_*` variable, or runs Kerb through `script`, `expect` or `unbuffer`. Reason: `human_only`. Next: "ask the user to run this in their own terminal".
2. The command itself opens `/dev/tty` (on Windows, `CONIN$`) and asks the human to type a 4-character code it prints. No TTY, or a wrong code: exit 64 with the `human_only` message.
3. After `ack`, exactly one run of the key is allowed regardless of rules 1 to 3. If that run fails with the same fingerprint, the breaker is open again immediately.
4. `--force` skips Loopbreaker only, never the Boundary Map.

#### 4.7.8 `kerb wait-for`

Polling is legitimate; spending a turn per poll is not. `wait-for` folds a whole polling loop into one call.

```
kerb wait-for [--until success|exit:<n>|output:<regex>] [--interval 5s] [--max 3m] [--backoff] -- <command>
```

1. The Boundary Map pre-check and human-only check run once, before the first attempt. Loopbreaker rules are not applied between attempts.
2. Each attempt runs under the supervisor with a per-attempt timeout of the remaining time. Between attempts, sleep `--interval` (±10% jitter). `--backoff` doubles the interval each attempt, capped at 60 s.
3. Stop when the condition holds (default `success`: exit 0), or when `--max` is reached.
4. Limits: `--interval` at least 1 s; `--max` at most 30 minutes, and in a hook-aware invocation at most the agent's tool timeout minus 10 seconds. Out-of-range values are a usage error (64).
5. Output: only the final attempt's shaped output, then one summary line:
   - `kerb: wait-for · condition met after 7 attempts in 41s`, exit 0;
   - `kerb: wait-for · gave up after 36 attempts in 3m; last output above`, exit 124.
6. Recording: one `wait` record with attempts, total duration and the final result. For Loopbreaker, it counts as one run of the command's key with the final attempt's result, so a successful wait clears the key.
7. `wait-for` is available to agents. It doesn't bypass anything: it can only stop sooner than the agent would, never run something Kerb would block.

### 4.8 Boundary Map

#### 4.8.1 Layers (strictest wins)

| Layer | Location | Written by | May name alternatives? |
|---|---|---|---|
| Managed config | `/etc/kerb/managed.json` (Linux), `/Library/Application Support/Kerb/managed.json` (macOS), `%ProgramData%\Kerb\managed.json` (Windows) | MDM | n/a (points to the org bundle, pins its key, sets locked options) |
| Org bundle | fetched from `org.bundle_url`, cached in `~/.kerb/org/` | platform team, signed | yes |
| Repo policy | `kerb.policy.json` at the repo root | repo maintainers | yes, shown as "from repo policy"; ignored when the managed config sets `lock_repo_alternatives: true` |
| Learned | `~/.kerb/learned.jsonl` | Kerb's classifier | never |

Lower layers can only add blocks; they can never remove or loosen a block from a higher layer. For list settings (`transient_patterns`, `dependency_patterns`, `check_commands`), layers are merged; for numeric settings (`breaker_threshold`, `retry_cooldown`), the higher layer wins.

#### 4.8.2 Policy format

```json
{
  "version": 1,
  "breaker_threshold": 3,
  "retry_cooldown": "60s",
  "hash_scope": "package",
  "shared_paths": ["config/shared/**"],
  "check_commands": ["just test", "bazel test *"],
  "transient_patterns": ["AccessDeniedException: .* is not authorized .* \\(propagation\\)"],
  "dependency_patterns": ["waiting for localstack"],
  "env_keys": ["DATABASE_URL"],
  "env_markers": [".tox"],
  "boundaries": [
    { "kind": "host", "pattern": "registry.npmjs.org", "alternative": "https://npm.corp.internal", "why": "Public registries are blocked; use the internal mirror." },
    { "kind": "host", "pattern": "*.pypi.org", "alternative": "https://pypi.corp.internal/simple", "why": "Use the internal PyPI mirror." },
    { "kind": "program", "pattern": "docker", "why": "Docker is not available in this environment." },
    { "kind": "command", "pattern": "terraform apply*", "why": "Applies run only in CI." },
    { "kind": "git_push", "pattern": "main", "why": "main is protected; open a pull request." },
    { "kind": "git_push", "pattern": "release/*", "why": "Release branches are protected." }
  ],
  "fixes": [
    { "key_contains": "npm test", "output_contains": "ECONNREFUSED 127.0.0.1:5432", "hint": "Start the database first: make db-up" }
  ]
}
```

Kinds:

- `host`: a hostname glob (`*` matches one or more labels at that position).
- `program`: matches any segment whose program equals the pattern (so `docker` matches `docker`, `docker ps`, and `sudo docker run …`).
- `command`: a glob over a segment's full normalised text (program + args).
- `git_push`: a glob over the target branch of `git push`.

`fixes` are hints appended to a failure's footer when both conditions match: institutional knowledge the agent sees at the moment it's useful.

`kerb policy lint` validates the schema, regular expressions and limits, and reports unknown keys.

#### 4.8.3 Pre-check

For every segment:

- **Hosts:** hosts from `http(s)://`, `ssh://`, `git@host:` URLs; values of `--registry`, `-i`, `--index-url`, `--extra-index-url`; the remote host of `git clone|fetch|pull|push|ls-remote`; `curl`/`wget` positional URLs; `docker pull|run` image registries (the host part if it contains a dot or colon, else `docker.io`).
- **Implicit registries:** for `npm|pnpm|yarn|bun install|i|add|ci|update`, the registry from `.npmrc` (segment cwd upward to root, then `~/.npmrc`, then `npm_config_registry`), else `registry.npmjs.org`. For `pip|pip3|python -m pip install` and `uv pip install|uv add`: `PIP_INDEX_URL` / `UV_INDEX_URL`, then `pip.conf` / `pip.ini`, else `pypi.org`. For `go get|go mod download`: `GOPROXY` hosts, else `proxy.golang.org`. For `cargo add|fetch|build` with network: `crates.io`.
- **git_push:** the explicit refspec's destination, else the current branch (`git rev-parse --abbrev-ref HEAD`).
- **program / command:** as defined above.

On a match: refuse with `policy_blocked`. Summary names the blocked thing. Evidence: the layer and version of the rule, and its `why`. Next: "use <alternative> instead" when one exists; otherwise "this is blocked here; tell the user what you need and why". Kerb never suggests proxies, public mirrors or other routes around a block.

Learned entries with status `suspected` never block. They add one line to the output of a matching command: `kerb: note · <host> may be blocked here (seen 1 time)`.

#### 4.8.4 Org bundle

- Managed config fields: `org.bundle_url`, `org.public_key` (Ed25519, base64), `org.max_cache_hours` (default 24), `lock_repo_alternatives`, `telemetry.otlp_endpoint`, `defaults` (overrides for user config), `locked` (keys users can't change).
- On each session start (the agent's session-start hook, or the first Kerb call in 15 minutes), Kerb fetches the bundle with `If-None-Match` using Node's built-in `fetch`, with a 2-second timeout. A new bundle is used only if its Ed25519 signature verifies against the pinned key (Node `crypto.verify`, no dependencies).
- Offline or failed fetch: use the last verified cached bundle up to `max_cache_hours` past its fetch time, and say so in `kerb status`. Never fall back to "no rules" silently: if the cache has expired, keep using it and warn in the status line.
- Platform-team tools: `kerb policy keygen` (writes a key pair), `kerb policy sign <policy.json>` (writes a bundle with version, timestamp and signature), `kerb policy verify`, `kerb policy lint`. A CI template for signing and publishing ships in `templates/agent-policy/`.

#### 4.8.5 Learning from denials

After any failed run, the classifier scans the redacted output. A denial is recorded only when **all** hold:

1. The run's command contains at least one network-capable segment: a segment with extracted hosts, or a program in `curl wget npm pnpm yarn bun pip pip3 uv poetry go cargo git gh docker podman apt apt-get brew gem bundle mvn gradle dotnet composer`.
2. A signature line matches:

   | Signature (case-insensitive, one line) | Strength |
   |---|---|
   | `blocked by (network )?policy`, `not permitted by policy`, `policy_denied`, `denied by (organization\|enterprise\|egress )?policy` | strong |
   | `firewall` and `block` on the same line | strong |
   | `CONNECT tunnel failed, response 403` | strong |
   | `403` and `proxy` on the same line | strong |
   | `ENOTFOUND <host>`, `getaddrinfo EAI_AGAIN <host>`, `Could not resolve host: <host>` | weak |

3. The **signature line itself names a host** that is also one of the command's extracted or implicit hosts. If the line names no host, or names a host the command didn't contact, nothing is learned.

Strong signature → status `confirmed`. Weak → `suspected`. A suspected entry becomes confirmed after 2 hits from different keys within its lifetime. Entries expire 14 days after their last hit. Each entry stores `{kind:"host", pattern, status, first_seen, last_seen, hits, keys, evidence_run}`.

The run is recorded with `class_result: "policy_denial"` and is never counted as a loop failure. Output ends with: `kerb: note · recorded a policy block for <host>; it will be refused before running next time`.

`kerb export-denials [--since 7d]` writes the confirmed and suspected entries as JSONL (no command text, no output). `kerb review --denials <file…>` aggregates exports from many developers (or from the telemetry collector), keeps entries seen from 3 or more machines, and writes a proposed policy patch plus a Markdown summary for the admin, with three choices per host: open it in the firewall, add an alternative, or confirm the block with a reason.

### 4.9 Recording

Every run writes a `start` record before spawning and an `end` record after. Fields:

- `start`: `id` (sortable, time-based), `ts`, `key`, `class`, `cmd` (redacted), `cwd`, `scope`, `pre_hash`, `env_stamp`, `kerb_pid`, `pgid`, `agent`, `tier`, `session`.
- `end`: `id`, `ts`, `exit`, `signal`, `duration_ms`, `post_hash`, `fingerprint`, `failure_kind` (`transient` | `dependency` | `ordinary` | null), `class_result` (`ok` | `failure` | `policy_denial` | `timeout` | `idle` | `aborted`), `raw_bytes`, `shown_bytes`, `first_fail_line`, `loop_skipped` (null or reason).
- `refusal`: `id`, `ts`, `key`, `reason`, `matched_run`, `avoided_duration_ms`, `avoided_output_bytes`.
- `wait`: `id`, `ts`, `key`, `attempts`, `duration_ms`, `result`, `final_exit`.

### 4.10 Agent integration

#### 4.10.1 Hook rules (all agents)

- **Fail open.** Any internal error in a hook handler (exception, corrupt state, timeout): allow the tool call, write the error to `~/.kerb/errors.log`, and increment an error counter shown by `kerb status` and `kerb doctor`. A hook never blocks because Kerb is broken.
- **Speed.** Hook handlers finish in under 100 ms on a warm cache. They compute hashes only when 4.7.2 requires it, within the hash budget. Hard internal deadline: 1 second, then fail open.
- **Deny-only.** Hooks may deny a call. They must never return an "allow" or "approve" decision, and never change the user's permission behaviour.
- **Never rewrite by default.** Rewriting commands to `kerb run --` breaks users' allow rules (for example `Bash(npm test:*)` no longer matches) and, in some agents, returning modified input also approves the call. Rewriting is available only as opt-in `kerb config set claude.rewrite true`, and only if VERIFY confirms the agent can modify input without granting permission.
- **Absolute paths.** Hooks call Kerb by absolute path, written at `kerb init`: the standalone binary's path, or for npm installs the absolute path of the Node executable plus the absolute path of Kerb's entry script. This keeps hooks working when `nvm`, `fnm`, `volta` or `asdf` switch the active Node version per project. `kerb doctor` checks the path exists and matches the running version; `kerb init --refresh` rewrites it after an upgrade or a Node change.

#### 4.10.2 Claude Code (observe mode, the default)

**VERIFY** against the current Claude Code hooks documentation: event names, the stdin JSON fields for `PreToolUse` and `PostToolUse` on the `Bash` tool (command, timeout, background flag, tool use id, output, exit status), how a hook denies a call and returns a reason to the model, the status line configuration, and the `Stop` / `SessionEnd` hook output that reaches the user.

Design:

1. `PreToolUse` (matcher `Bash`) → `kerb hook claude pre`: parse the command; run the human-only check (4.7.7), the Boundary Map pre-check, and for check-class commands the Loopbreaker rules. On refusal: deny with the three-line refusal as the reason (via the documented deny mechanism; exit code 2 with stderr is the fallback). Otherwise: store a pending record `.kerb/pending/<tool_use_id>.json` (pre-hash, env stamp, start time, class) and exit 0 with no decision.
2. `PostToolUse` (matcher `Bash`) → `kerb hook claude post`: load the pending record, compute the post-hash if check class, take the exit status and output from the payload, fingerprint, classify the failure kind and any denial, write start and end records.
   - If the payload has no exit status: infer failure only from an explicit error flag in the payload; otherwise record `exit: null`, and runs with a null exit never count as failures. Record this finding in the Decisions log.
3. Background calls (the payload's background flag, or a trailing `&`): pre-check only.
4. The Bash tool's own timeout, if present in the payload, is passed to Kerb as the agent timeout (4.5.3, 4.7.8) for commands the agent runs through `kerb run` or `kerb wait-for`.
5. Status line: `kerb init` adds `kerb statusline` as the status line command **only if** the user has none; if they have one, `init` prints how to append Kerb's segment to it (`kerb statusline --segment`).
6. `Stop` or `SessionEnd` → `kerb hook claude stop`: print the recap (4.11.3) through the documented channel for user-visible hook output.
7. `SessionStart` → `kerb hook claude start`: refresh the org bundle and regenerate the boundaries briefing (4.10.5).

#### 4.10.3 Other agents and tiers

For each agent: **VERIFY** whether it has pre- and post-command hooks, a status line, and a stop event. Where hooks exist, implement an adapter with the same design as Claude Code; the agent is then **enforced**. Where they don't, `kerb init` installs the instructions block (4.10.4) and, where the agent supports skills, the skill (4.10.6); the agent is then **best effort**, because an agent deep in a debugging spiral may stop prefixing commands with `kerb run --`, and Kerb cannot see commands it isn't given.

| Agent | Expected integration (VERIFY each) | Target tier |
|---|---|---|
| Claude Code | Native hooks | Enforced |
| GitHub Copilot in VS Code | Hook files under `.github/hooks/` | Enforced if hooks confirmed |
| GitHub Copilot CLI | Hooks if available; else `.github/copilot-instructions.md` block | Enforced or best effort |
| Cursor | Hooks before and after shell execution | Enforced if hooks confirmed |
| OpenAI Codex CLI | Hooks if available; else `AGENTS.md` block | Enforced or best effort |
| Gemini CLI | Hooks if available; else `GEMINI.md` block | Enforced or best effort |
| OpenCode, Pi | Plugin or extension event on tool call; else `AGENTS.md` | Enforced or best effort |
| Anything else | `AGENTS.md` block + `kerb run --` | Best effort |

Build native adapters before relying on instructions. Each adapter lives in `src/adapters/<agent>.js`, with contract tests using recorded sample payloads in `test/fixtures/hooks/<agent>/`.

**Tier is always visible:** `kerb init`, `kerb status`, the recap and the README all say which tier each agent is in. In best-effort mode, `kerb status` says plainly: "Kerb only sees commands run through `kerb run`."

**Coverage** (enforced agents): `kerb status` reports the share of shell commands the hooks observed that were fully recorded (pre and post), and how many loop checks were skipped for the hash budget. A falling number points to a broken hook.

#### 4.10.4 Instructions block

`kerb init` writes this between `<!-- kerb:start -->` and `<!-- kerb:end -->` markers into `AGENTS.md` (created if missing), plus `CLAUDE.md`, `GEMINI.md` and `.github/copilot-instructions.md` when they exist. It's idempotent and regenerated when boundaries change.

~~~markdown
## Running commands with Kerb
This repo uses Kerb. When your agent has no Kerb hook, run shell commands as `kerb run -- <command>`.
- A line starting `kerb: policy_blocked` means the action is not allowed here. Do not retry it or look for a way around it. Use the alternative Kerb names, or tell the user what you need.
- A line starting `kerb: identical_retry`, `kerb: deja_vu` or `kerb: breaker_open` means running it again cannot help. Change the code or the approach first.
- To wait for a service or poll until something passes, use one call: `kerb wait-for --max 3m -- <command>`. Don't re-run a command turn after turn.
- Trust the `kerb:` line, not the exit code alone.
- Never run `kerb ack`, `kerb reset`, `kerb forget`, `kerb config` or `kerb run --force`, and never set `KERB_*` variables. Those are for the user.
Known boundaries here:
<generated: up to 10 lines, "- <thing>: <why> (use <alternative>)">
~~~

#### 4.10.5 Boundaries briefing

Generated from the merged layers: at most 10 lines and 300 tokens, most-hit first. Regenerated on bundle change, on a new confirmed learned entry, and on `kerb init`.

#### 4.10.6 Skill

`kerb init` installs this as `.claude/skills/kerb/SKILL.md` when `.claude/` exists (and at the equivalent skills path for other agents that support skills). The file starts with `---` on its first line.

~~~markdown
---
name: kerb
description: Use Kerb for shell commands in repos with kerb.policy.json or a .kerb folder, so blocked actions and useless retries are caught before they waste turns.
---

# Using Kerb

If no Kerb hook is active, run shell commands as `kerb run -- <command>`.

## Reading Kerb's answers
- `kerb: policy_blocked`: not allowed here. Don't retry or work around it. Use the named alternative, or tell the user what you need and why.
- `kerb: identical_retry`: nothing relevant changed since this failed. Change something first. If a service isn't up yet, use `kerb wait-for`.
- `kerb: deja_vu`: your files are back in a state that already failed. Try a different fix.
- `kerb: breaker_open`: the same failure keeps happening despite edits. Stop, summarise what you tried, and propose a different approach.
- Exit 124 or 125 with a Kerb footer: the command hung and was killed. Look for watch modes, prompts or servers; use a non-interactive variant or run servers in the background.

## Waiting and polling
- Use `kerb wait-for --max 3m -- <command>` to wait for a database, a server or a deploy. It retries inside one call and returns once.
- `--until output:<regex>` waits for specific output; `--interval` and `--backoff` control pacing.

## Rules
- Trust the `kerb:` line, not the exit code alone.
- Never run `kerb ack`, `kerb reset`, `kerb forget`, `kerb config` or `kerb run --force`, and never set `KERB_*` variables.
- Run `kerb map` at the start of a task to see known boundaries.
- The footer shows the full log path. Read the log only when the shaped output isn't enough.
~~~

### 4.11 Visibility

#### 4.11.1 Summary cache

After every record, Kerb atomically rewrites `.kerb/summary.json` (write to a temp file, then rename) with session and 7-day totals. Status line, recap and card read only this file, so they run in under 50 ms.

#### 4.11.2 Status line

`kerb statusline` prints one line, under 80 characters, from the summary: `kerb · <n> re-runs avoided · <size> noise trimmed · <n> walls known`, with segments dropped when zero. A warning segment appears when the org cache has expired, when Kerb has logged errors, or when loop checks are often skipped for the hash budget (`kerb · hashing slow, run kerb doctor`). With `--segment`, it prints only Kerb's part for appending to an existing status line. If the agent passes status-line JSON on stdin, it's read for the session id.

#### 4.11.3 Recap

`kerb recap` (and the stop hook) prints the session block shown in 2.2, headed with the tier, only if at least one save happened; otherwise nothing. `kerb config set recap off` disables it.

#### 4.11.4 Card

`kerb card --week` writes `kerb-card.svg` and `kerb-card.html` (a standalone page showing the SVG at 1200×628, the LinkedIn link-image size). Contents: repo name (optional, `--anonymous` hides it), re-runs avoided, polls folded, noise trimmed, walls learned, hangs killed, and an estimated dollar figure only if the user set prices, labelled "est.". Fonts are system fonts. If `rsvg-convert` or macOS `qlmanage` exists, also write a PNG; otherwise print "open kerb-card.html and take a screenshot".

#### 4.11.5 Watch

`kerb watch` tails `.kerb/runs.jsonl` and prints one line per event: time, class, exit, duration, shown/raw bytes, and refusals in colour. It handles file rotation and exits on Ctrl-C.

#### 4.11.6 Colour

Colour only when the stream is a TTY, `NO_COLOR` is unset, and `--no-color` isn't given. Refusals: yellow for `policy_blocked`, cyan for loop reasons. Notes: dim.

### 4.12 Report

`kerb report [--since 7d] [--json]` prints two clearly labelled sections.

**Measured**
- runs by class and tier; refusals by reason;
- re-runs avoided (refusals whose matched run exists);
- run time avoided: the sum of the matched runs' durations;
- output avoided: the sum of the matched runs' shown bytes, and ≈ tokens at 4 bytes per token (labelled "estimated at 4 bytes per token");
- polls folded: attempts inside `wait-for` calls beyond the first;
- noise trimmed by shaping: raw bytes minus shown bytes;
- hangs killed; walls learned (confirmed, suspected);
- loop checks skipped for the hash budget.

**Estimated** (only if the user has set prices, or with `--estimate`)
- `output tokens avoided × input price` plus `tokens trimmed × input price`, using `price.input_per_mtok` (default when estimating: $3) from config;
- the formula and every assumption printed below the number.

A refusal still costs the agent a turn to read it, so Kerb never reports "turns saved". It reports what was actually avoided: the re-run, its time and its output. Folded polls are reported as attempts, not turns, because the agent might have polled fewer times on its own.

### 4.13 Configuration

`~/.kerb/config.json`, set with `kerb config set` (human-only). Keys: `recap` (on|off), `statusline` (on|off), `color` (auto|always|never), `budget`, `timeout`, `idle`, `hash_budget_ms`, `price.input_per_mtok`, `claude.rewrite` (false), `telemetry` (off). The managed config's `defaults` override user values, and its `locked` list prevents changes.

### 4.14 Storage and safety

#### 4.14.1 Layout

```
<root>/.kerb/               mode 0700, added to .gitignore by init
  runs.jsonl                append-only records
  summary.json              atomic
  wscache.json              atomic (walk mode and content-hash cache)
  snapshots/<run-id>.json
  logs/<run-id>.log         mode 0600
  pending/<id>.json         hook handoff, deleted after post
  lock
~/.kerb/                    mode 0700
  learned.jsonl, config.json, org/, errors.log
```

#### 4.14.2 Durability

- Every record line: `{…fields, "crc": <crc32 of the JSON without crc>}`.
- Appends take an exclusive lock (`fs.openSync('.kerb/lock','wx')`, retry with jitter up to 2 s, break a lock whose holder PID is dead or that is older than 30 s). 20 concurrent writers yield 20 intact record pairs.
- On read: a bad **last** line is a torn write, so truncate it and continue. A bad line anywhere else: exit 71 with the line number and change nothing. Hooks fail open instead (4.10.1).
- Logs are evicted oldest-first when `logs/` exceeds 200 MB (configurable). Records are kept. `runs.jsonl` rotates to `runs.<n>.jsonl` at 50 MB; readers read the current file plus the previous one.

#### 4.14.3 Redaction

Applied to logs, recorded commands and first-fail lines, streaming-safe (4.6). Patterns: AWS access keys `AKIA[0-9A-Z]{16}`, AWS secret keys after `aws_secret_access_key`, GitHub tokens `gh[pousr]_[A-Za-z0-9]{36,}` and `github_pat_[A-Za-z0-9_]{50,}`, Slack tokens `xox[baprs]-[A-Za-z0-9-]+`, OpenAI and Anthropic keys `sk-(ant-)?[A-Za-z0-9_-]{20,}`, JWTs `eyJ[\w-]+\.[\w-]+\.[\w-]+`, private key blocks, `Bearer <token>`, URL credentials `://user:pass@`, and `(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+`. Replacement: `[REDACTED]`.

#### 4.14.4 Network

Kerb makes network requests only to `org.bundle_url` and `telemetry.otlp_endpoint`, and only when a managed or user config sets them. No other code path imports `node:http`, `node:https`, `node:net`, `node:dns` or calls `fetch`.

#### 4.14.5 Telemetry (off by default)

When `telemetry.otlp_endpoint` is set: at session end, send one OTLP/HTTP JSON batch of metrics (runs, refusals by reason, bytes trimmed, polls folded, walls learned, hash-budget skips) and denial events (host, status, count). Never commands, output, file paths or usernames, unless the managed config sets `telemetry.include_commands: true`. Timeout 2 s; failures are dropped silently and counted.

### 4.15 Security model

| Threat | Mitigation |
|---|---|
| A malicious repo policy names a hostile "alternative" | Shown as "from repo policy"; ignored entirely when the managed config locks repo alternatives |
| A tampered org bundle | Ed25519 signature against a key pinned by MDM; unverified bundles are never used |
| The agent escapes the breaker | No agent-settable bypass exists; the hook refuses human-only commands and `KERB_*` variables; human actions need a code typed on `/dev/tty` |
| The agent edits `.kerb/` or `kerb.policy.json` | Out of scope for a waste guard; documented. `kerb doctor` flags policy files changed since the last commit |
| Prompt injection causes false blocks | Learning requires a network-capable command, a signature line naming a host the command contacted, and expiry; suspected entries never block |
| Regex denial of service through policy patterns | Pattern length and count limits; lines over 4 KB skipped |
| Secrets in logs | Streaming redaction, 0600 files, eviction |
| Hooks break the agent | Fail open, hash budget, 1 s deadline, error counter |
| Hooks resolve the wrong Kerb | Absolute paths; `doctor` checks them |
| Supply chain | No runtime dependencies, provenance-signed npm releases, checksummed and attested binaries, SBOM, reproducible `npm pack` |

---

## 5. Architecture

```
bin/kerb.js                 argument parsing, exit-code mapping
src/
  cli/                      one file per command (run, wait-for, check, init, status, report, …)
  parse/tokenize.js         quotes, operators, wrappers, cd tracking
  parse/classify-cmd.js     check / query / background / other
  parse/hosts.js            host extraction, implicit registries
  run/supervisor.js         spawn, timeouts, group kill, signals, orphan reaping
  run/shape.js              streaming shaper with head buffer + tail ring
  run/redact.js             streaming redaction with carry-over
  run/wait.js               wait-for loop
  loop/scope.js             package root and shared paths
  loop/workspace-git.js     git status based hashing
  loop/workspace-walk.js    walk mode with ctime cache
  loop/envstamp.js
  loop/fingerprint.js       normalisation and failure kinds
  loop/rules.js             identical_retry, deja_vu, breaker_open, cooldown
  bound/policy.js           layers, merge, lint
  bound/org.js              fetch, verify, cache
  bound/precheck.js
  bound/learn.js            denial classifier
  bound/review.js           export and review
  store/jsonl.js            append, lock, crc, recovery, rotation
  store/summary.js
  ui/format.js              refusal and note templates, colour
  ui/statusline.js, ui/recap.js, ui/card.js, ui/watch.js
  adapters/claude.js, copilot.js, cursor.js, codex.js, gemini.js, opencode.js
  init/install.js           settings merge with markers, absolute paths, uninstall
  telemetry/otlp.js
templates/agent-policy/      policy repo template with signing CI
scripts/build-binaries.js    Node SEA build for each platform
bench/                       benchmark harness, tasks, results
test/                        node:test suites, fixtures, recorded hook payloads
docs/KERB.md                 this file
```

**Technology:** Node.js 20+, ES modules, JSDoc types, `node:test`. No runtime or dev dependencies. Startup budget: `kerb check` under 60 ms cold.

**Distribution, three forms, all first-class for 1.0:**

1. **Standalone binaries** built with Node's single-executable application support for macOS (arm64, x64), Linux (x64, arm64) and Windows (x64). No Node installation needed, so version managers never interfere. Published on GitHub Releases with SHA-256 checksums and build-provenance attestations; macOS binaries signed when a certificate is available.
2. **Homebrew tap** (`brew install <you>/tap/kerb`) pointing at the release binaries.
3. **npm package**, for developers who prefer it; hooks still use absolute paths (4.10.1).

The standalone binary solves version-manager conflicts; it does not make Kerb faster (it has the same startup time as Node). **Hook latency is measured in the benchmark (12.3).** If the warm p95 of `kerb hook … pre` exceeds 100 ms on the benchmark machines, port the hook path (`hook`, `check`) to Go or Rust behind the same CLI contract and the same test suite, and record the decision in section 13.

---

## 6. Repository and release engineering

- License: Apache-2.0. `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md` (with guides for adding a denial signature, a transient pattern and an agent adapter), issue templates (bug, false refusal, new signature, new agent).
- CI (GitHub Actions): tests on Ubuntu, macOS and Windows with Node 20 and 22; a performance job with a generated 100,000-file git repo; `npm pack` smoke test; binary builds with the CLI smoke suite run against each binary; a check that `package.json` has no `dependencies` or `devDependencies`.
- Release: tag-triggered workflow that builds binaries, attaches checksums and attestations, updates the Homebrew formula, and runs `npm publish --provenance`. GitHub release notes include the demo recording. SBOM in CycloneDX JSON, generated by a small script.
- Versioning: semver. The policy format has its own `version` field and a compatibility table in the README.

---

## 7. README (required content)

The README must contain, in this order:

1. One-line pitch and the hero block (two refusals, as in 2.2).
2. A GIF or asciinema recording of the demo (12.2).
3. **Why:** the four wastes, in three sentences.
4. **Install:** Homebrew, binary download and npm, then `kerb init` and `kerb doctor`.
5. **What you'll see:** the status line, the recap and the card.
6. **Boundaries:** a `kerb.policy.json` example, and how learning works.
7. **Works with:** the agent table with an explicit tier column. Enforced means Kerb sees every shell command through a native hook; best effort means the agent is asked to use `kerb run` and may not always do so.
8. **Waiting and polling:** `kerb wait-for` in two lines.
9. **For platform teams:** the org bundle, signing, managed config, review flow and telemetry, briefly, linking to `docs/KERB.md`.
10. **Commands and exit codes.**
11. **Honest numbers:** what `kerb report` measures versus estimates.
12. **Security:** the deny-only, no-agent-bypass and fail-open principles; link to `SECURITY.md`.
13. **FAQ:** "Will it block legitimate retries?" (setup commands, env changes, transient errors, cooldowns and `wait-for`), "Is it fast in a big monorepo?" (package scope, git fsmonitor, hash budget), "Does it send data anywhere?", "How is it different from RTK?", "Why not a flag to skip it?".

Only numbers Kerb measured may appear.

---

## 8. Defaults at a glance

| Setting | Default |
|---|---|
| Output budget | 12,000 bytes (25% head, 75% tail) |
| Total timeout | agent tool timeout − 10 s, else 30 min |
| Idle timeout | 10 min |
| Breaker threshold K | 3 |
| Retry cooldown (dependency-unavailable) | 60 s |
| Transient retries allowed | 1 |
| Hash scope | package + root shared files |
| Hash budget | 300 ms in hooks, 2 s in `kerb run` |
| `wait-for` | interval 5 s (min 1 s), max 3 min (cap 30 min or agent timeout − 10 s) |
| Learned entry lifetime | 14 days after last hit |
| Suspected → confirmed | 2 hits from different keys |
| Promotion to admin review | 3 machines |
| Org cache | 24 h |
| Log budget | 200 MB |
| Hook deadline | 1 s (target under 100 ms) |

---

## 9. Out of scope for 1.0

Model routing; a hosted dashboard; MCP-tool boundaries (non-shell tool calls); per-file content exclusions; opt-in `PATH` shims that force best-effort agents through Kerb (candidate for 1.1, off by default because they also affect the human's own commands). All are listed in the README roadmap.

---

## 10. Build plan

Work top to bottom. Each step lists its done-criteria as test groups (section 11). Commit after every step. If a VERIFY finding changes the design, record it in section 13 before coding.

### Milestone 1: The engine

- [x] **1.1 Scaffold.** `git init` (if needed), `package.json` (`"type":"module"`, `bin`, `engines >=20`, `files`, no dependencies, `test` script), `bin/kerb.js` with a hand-written parser, `--help`, `--version`, exit-code mapping. License and repo files. *Done: T0.*
- [x] **1.2 Tokenizer and classes.** `parse/*`. *Done: P1–P13.*
- [x] **1.3 Store.** `store/jsonl.js`, `store/summary.js`, locking, recovery, rotation. *Done: S1–S7.*
- [x] **1.4 Supervisor.** Spawn, stdin, timeouts, group kill, signals, orphan reaping, background passthrough, Windows path. *Done: A1–A9.* (A9, Windows tree kill, runs only in the Windows CI job; not yet observed passing.)
- [x] **1.5 Shaping and redaction.** Streaming, bounded memory, footer rules. *Done: B1–B11, R1–R4.*
- [x] **1.6 `kerb run` and `kerb check`** wired end to end with records. *Done: C1–C3.*

### Milestone 2: Loopbreaker

- [x] **2.1 Scope, git-mode and walk-mode hashing, hash budget, env stamp, snapshots, `kerb diff`.** *Done: W1–W16.*
- [x] **2.2 Fingerprint and failure kinds** (transient, dependency-unavailable, ordinary; policy patterns). *Done: F1–F12.*
- [x] **2.3 Rules, cooldown and human-only actions.** *Done: L1–L22, H1–H6.*
- [x] **2.4 `kerb wait-for`.** *Done: WF1–WF10.*

### Milestone 3: Boundary Map

- [x] **3.1 Policy layers, lint, merge.** *Done: M1–M8.*
- [x] **3.2 Pre-check with hosts, implicit registries, programs, commands, git push.** *Done: X1–X14.*
- [x] **3.3 Learning, expiry, `kerb map`, `kerb forget`.** *Done: D1–D10.*
- [x] **3.4 Org bundle: fetch, verify, cache, `kerb policy *`, template repo.** *Done: O1–O8.*

### Milestone 4: Agents

- [x] **4.1 VERIFY Claude Code hooks; record findings.** Save real sample payloads as fixtures. (Fixtures follow the documented shapes; replace with captured payloads during 7.3.)
- [x] **4.2 Claude Code adapter** (pre, post, start, stop, status line), `kerb init` with absolute paths and `--refresh`, `kerb uninstall`, `kerb doctor`. *Done: K1–K14, I1–I11.*
- [x] **4.3 VERIFY and build the other adapters** in this order: Copilot (VS Code, CLI), Cursor, Codex, Gemini, OpenCode. Native hooks wherever they exist; the instructions-only path otherwise. Record each agent's tier. *Done: G1–G7 per agent.*
- [x] **4.4 Instructions block, briefing and skill.** *Done: N1–N6.*

### Milestone 5: Visibility and reporting

- [x] **5.1 Status line, recap, colour.** *Done: V1–V9.*
- [x] **5.2 `kerb report`, `status` (with tiers and coverage), `why`, `history`.** *Done: Q1–Q9.*
- [x] **5.3 `kerb card` and `kerb watch`.** *Done: V10–V15.*

### Milestone 6: Enterprise

- [x] **6.1 Managed config and locked settings.** *Done: E1–E5.*
- [x] **6.2 `export-denials` and `review`.** *Done: E6–E9.*
- [x] **6.3 OTLP telemetry.** *Done: E10–E13.*

### Milestone 7: Launch readiness

- [ ] **7.1 Hardening.** Run the suite 10 times in shuffled order on all three OSes; fix flakes. Performance checks Z1–Z6.
  Status 2026-10-01: 10 shuffled runs on macOS, seed 20261001: 9 clean, 1 flake (WF2), which exposed a real `wait-for` deadline bug, now fixed with a regression test; Linux and Windows run in the nightly CI job (`scripts/shuffle-tests.js`), not yet observed. Z1–Z6 pass locally (Z1 and W14 in the performance job).
- [ ] **7.2 Distribution.** Standalone binaries for all five targets, checksums, attestations, Homebrew tap, npm with provenance. *Done: Z7–Z9.*
  Status 2026-10-01: build scripts, CI and release workflows done; darwin-arm64 binary built and passes the full suite with no Node on PATH. The other four targets, attestations, the tap and npm publishing run only in the release workflow (not yet run). The npm name `kerb` is taken, see 12.1.
- [ ] **7.3 Dogfood.** Use Kerb with a real agent on a real repo, including one large monorepo, for at least one full working session each. Log every refusal and every hash-budget skip; for each refusal, decide whether it was right. Any false refusal is a bug with a regression test.
  Status 2026-10-01: partial. The building agent ran its own commands through `kerb run` (best effort) on this repo; log in `docs/dogfood.md`. Still to do: a full enforced session with each agent's hooks, and one on a large monorepo.
- [ ] **7.4 Benchmark.** Section 12.3, including hook latency.
  Status 2026-10-01: hook latency measured (`bench/results/`); the 22-task harness, egress proxy and review flow are built and tested with a scripted stand-in, but the task benchmark has not been run with a real agent. Launch gate not yet evaluated.
- [x] **7.5 Docs.** README (section 7), `SECURITY.md`, `CONTRIBUTING.md`, the policy template's README.
- [ ] **7.6 Release.** Release workflow, demo recording, v1.0.0.
  Status 2026-10-01: release workflow and demo script (`demo/`) done; no recording, no tag. v1.0.0 waits for the benchmark gate, the npm name decision and a repository owner.

---

## 11. Acceptance tests

`node:test`, fixtures under `test/fixtures/`. Timing tests use margins of at least 2×. Process death is checked by PID. Every refusal test also asserts the command did **not** run (via a side-effect file). Time-based rules use an injectable clock.

**T. CLI**
- T0 `--help`, `--version`; unknown command exits 64. Every command supports `--json` and prints exactly one JSON object.

**P. Parsing**
- P1 `cd x && npm i left-pad` → 2 segments; the second's cwd is `x`.
- P2 `FOO=1 npm i` → program `npm`.
- P3 `sudo -E docker ps` → program `docker`.
- P4 `env A=1 B=2 pip install x` → program `pip`.
- P5 `bash -c "curl https://a.example"` → host `a.example`.
- P6 `a | b ; c || d` → 4 segments.
- P7 Quoted `"a && b"` stays one argument.
- P8 `npm run dev &` → class background.
- P9 `npm test` → check; `grep x` → query; `npm install` → other.
- P10 `git diff --exit-code` → query.
- P11 Unbalanced quotes → one opaque `other` segment; nothing refused.
- P12 `timeout 5 npm test` → program `npm`, class check.
- P13 `aws s3 ls`, `terraform plan`, `kubectl get pods` → class other.

**S. Store**
- S1 20 parallel `kerb run -- true` → 20 start/end pairs, all crc-valid.
- S2 A truncated last line is repaired.
- S3 A corrupt middle line → exit 71, file byte-identical afterwards.
- S4 Stale lock with a dead PID is broken.
- S5 Rotation at the size limit; readers see both files.
- S6 `summary.json` is never observed half-written (concurrent reader loop).
- S7 Files have mode 0600, directories 0700.

**A. Supervisor**
- A1 Exit codes 0, 1, 42 pass through.
- A2 stdin gives EOF immediately.
- A3 `--timeout 1s` on `sleep 30` → 124 within 6 s.
- A4 `--idle 1s` → 125.
- A5 A TERM-trapping grandchild is dead after timeout.
- A6 SIGTERM to Kerb → group killed, run `aborted`, exit 143.
- A7 SIGKILL to Kerb → the next Kerb invocation records `aborted` and kills the orphaned group.
- A8 `kerb run -- "sleep 5 &"` returns immediately; not shaped; recorded as background.
- A9 Windows: tree kill works (Windows CI only).

**B. Shaping**
- B1 ANSI and OSC removed.
- B2 `50%\r75%\r100%\n` → `100%`.
- B3 10 identical lines → 1 line + repeated note; 2 identical lines unchanged.
- B4 Over budget → head and tail at line boundaries.
- B5 A multi-byte character at the cut stays whole (valid UTF-8).
- B6 NUL in the first 8 KB → binary marker only.
- B7 1 GB of output: peak memory stays under budget + 64 KB + 30 MB baseline.
- B8 No footer for a successful, uncut command.
- B9 Footer for failure, cut, or timeout.
- B10 The raw log equals the redacted child output byte for byte.
- B11 Interleaving of stdout and stderr preserved in the log.

**R. Redaction**
- R1 Each pattern in 4.14.3 is redacted.
- R2 A token split across two chunks is redacted.
- R3 The recorded `cmd` is redacted.
- R4 Ordinary text containing "token" without a value is unchanged.

**C. Run and check**
- C1 `kerb check` never executes (side-effect file absent).
- C2 `kerb run` writes start and end records with all fields in 4.9.
- C3 Refusals write a `refusal` record with avoided duration and bytes.

**W. Scope, workspace and env**
- W1 Editing a file changes the hash; reverting restores it (git mode and walk mode).
- W2 Edit with mtime restored still changes the hash (git mode and walk mode).
- W3 `chmod +x` changes the hash (not on Windows).
- W4 Ignored files (`.gitignore`, `.kerbignore`) don't affect it.
- W5 Non-git directory uses walk mode with the default skips.
- W6 Pre- and post-hash both recorded; a test that writes an unignored snapshot file changes the post-hash.
- W7 `kerb diff` lists exactly the changed files, including across commits in git mode.
- W8 Changing `node_modules/.package-lock.json` changes the env stamp.
- W9 A 5,000-file repo with a warm cache hashes in under 100 ms (CI: under 300 ms).
- W10 Monorepo: for `npm test` in `packages/a`, editing `packages/b/x.js` does not change the hash.
- W11 Monorepo: editing the root lockfile or root `tsconfig.json` does change it.
- W12 `hash_scope: "repo"` makes W10 change the hash.
- W13 A command run at the repo root uses the whole repo as scope.
- W14 A generated 100,000-file git repo with fsmonitor and untracked cache enabled hashes in under 300 ms warm (performance CI job).
- W15 Hash budget exceeded (injected slow hasher) → command allowed, loop checks skipped, `loop_skipped: "hash_budget"` recorded.
- W16 A commit between runs changes the base and therefore the hash; `git stash` and `git stash pop` back to the same content restores it.

**F. Fingerprint and failure kinds**
- F1 Differences only in timestamps, durations in timing context, addresses, temp paths, PIDs, high ports and request ids → same fingerprint.
- F2 Different line number, test name or assertion value → different fingerprint.
- F3 "handles 10s timeout" in a test name is not normalised.
- F4 `(38 ms)` and `in 1.2s` are normalised.
- F5 The Kerb footer doesn't affect the fingerprint.
- F6 `ECONNRESET` → transient.
- F7 Kerb timeout → transient.
- F8 Ordinary assertion failure → ordinary.
- F9 `504 Gateway Timeout`, `ThrottlingException`, `RequestLimitExceeded`, `SlowDown` → transient.
- F10 `500 Internal Server Error` → ordinary.
- F11 `ECONNREFUSED 127.0.0.1:5432` → dependency-unavailable.
- F12 A policy `transient_patterns` entry marks a matching failure transient; a policy `dependency_patterns` entry marks one dependency-unavailable.

**L. Loopbreaker**
- L1 Ordinary failure, rerun with nothing changed → `identical_retry`; not executed.
- L2 Fail → `npm install` (other) → rerun → allowed.
- L3 Fail → start a background server → rerun → allowed.
- L4 Fail → `grep` (query) → rerun → refused.
- L5 Transient failure → first identical retry allowed; a second transient failure then refuses the next retry.
- L6 Fail → change a dependency marker → rerun allowed (env stamp changed).
- L7 Fail in S1, edit to S2 and fail, revert to S1 → `deja_vu` naming the first run.
- L8 Three ordinary failures, same fingerprint, three states → `breaker_open` listing changed files.
- L9 Three failures, same fingerprint, same state → identical_retry fires first, not breaker.
- L10 Different fingerprints → no breaker.
- L11 A success clears the key.
- L12 Keys are independent.
- L13 Query and other classes are never refused by Loopbreaker (`grep` returning 1 three times; `aws` failing three times).
- L14 A policy-denial run is not a failure.
- L15 An aborted run is not a failure.
- L16 Concurrent runs of the same key: both run; one note line.
- L17 Dependency-unavailable failure, rerun at 10 s → refused, and `next:` names `kerb wait-for` and the seconds remaining.
- L18 Same, rerun at 61 s → allowed.
- L19 After an allowed post-cooldown retry fails again the same way, a rerun at 10 s is refused (cooldown restarted).
- L20 Transient and dependency-unavailable failures don't count toward the breaker.
- L21 `deja_vu` ignores transient and dependency-unavailable failures.
- L22 Refusal messages differ by failure kind as specified.

**H. Human-only**
- H1 Hook refuses `kerb ack`, `kerb reset`, `kerb forget`, `kerb config set x`, `kerb uninstall`.
- H2 Hook refuses `KERB_HUMAN=1 kerb ack` and `env KERB_X=1 npm test`.
- H3 Hook refuses `script -q /dev/null kerb ack`.
- H4 `kerb ack` without a TTY exits 64.
- H5 After a correct-code `ack`, exactly one run is allowed; a same-fingerprint failure reopens the breaker.
- H6 `--force` skips loop checks but not boundaries. No agent-reachable flag or variable disables Loopbreaker (scan the CLI options and environment reads).

**WF. wait-for**
- WF1 A command that succeeds on the 4th attempt → exit 0, one summary line, only the final output shown.
- WF2 A command that never succeeds → exit 124 at `--max`, "gave up" line, last output shown.
- WF3 `--interval` is respected within ±10% plus scheduling tolerance.
- WF4 `--backoff` doubles intervals up to 60 s.
- WF5 `--until output:ready` stops when a line matches.
- WF6 A blocked host in the command → `policy_blocked` before any attempt.
- WF7 `--interval 0.5s` or `--max 45m` → exit 64.
- WF8 From a hook-aware invocation, `--max` is capped at the agent timeout minus 10 s.
- WF9 One `wait` record; a successful wait clears the key's loop state.
- WF10 `kerb report` counts folded attempts.

**M. Policy**
- M1 Repo policy loads; lint catches unknown keys and bad kinds.
- M2 Org block can't be removed by repo policy.
- M3 Repo alternative shown as "from repo policy".
- M4 Locked repo alternatives are ignored.
- M5 `check_commands` extends the check class.
- M6 `fixes` hint appears in the footer of a matching failure.
- M7 Lint rejects an invalid regex, a pattern over 200 characters, and more than 50 patterns.
- M8 List settings merge across layers; numeric settings take the higher layer's value.

**X. Pre-check**
- X1 `curl https://blocked.example/x` → 77, not executed.
- X2 `npm install left-pad`, no `.npmrc`, registry blocked → 77 naming the alternative.
- X3 Same with `.npmrc` pointing at the mirror → allowed.
- X4 `cd sub && npm i x` uses `sub/.npmrc`.
- X5 `pip install x` with `PIP_INDEX_URL` set to the mirror → allowed.
- X6 `git push origin main` → 77; `git push origin feature` → allowed.
- X7 `git push` with no refspec on a protected current branch → 77.
- X8 Program `docker` blocks `docker`, `docker ps`, `sudo docker run x`.
- X9 Command glob `terraform apply*` blocks `terraform apply -auto-approve`, allows `terraform plan`.
- X10 Host glob `*.pypi.org` matches `files.pypi.org`, not `pypi.org.evil.example`.
- X11 `bash -c "npm i x"` is checked.
- X12 `docker pull ghcr.io/a/b` extracts `ghcr.io`.
- X13 No refusal message suggests a proxy or workaround (scan all templates).
- X14 Suspected entries add a note and don't block.

**D. Learning**
- D1 `curl` output "blocked by policy: a.example" with host `a.example` → confirmed entry; next call refused.
- D2 The same text from `cat notes.txt` → nothing learned.
- D3 A test suite printing "blocked by policy" for a host it didn't contact → nothing learned.
- D4 Signature line without a host → nothing learned.
- D5 `ENOTFOUND a.example` → suspected; not blocking.
- D6 A second hit from a different key → confirmed.
- D7 Expiry after 14 days (injected clock) → ignored.
- D8 `kerb forget` removes an entry (human-only).
- D9 A two-host command learns only the host named on the signature line.
- D10 The denial run doesn't count for Loopbreaker.

**O. Org bundle**
- O1 `keygen`, `sign`, `verify` round trip.
- O2 A tampered bundle is rejected; the previous verified bundle stays in use.
- O3 ETag 304 → cache used.
- O4 Offline → cached bundle used; status shows it.
- O5 Expired cache → still used, status line warns.
- O6 Fetch takes no more than 2 s (slow local test server).
- O7 No network call is made when `bundle_url` is unset (spy on `fetch`).
- O8 The template repo's CI signs a sample policy in a dry run.

**K. Claude Code adapter** (using recorded payload fixtures)
- K1 Pre with a blocked command → deny with the refusal text.
- K2 Pre with an allowed command → no decision, pending record written.
- K3 Post → start and end records with the payload's exit status.
- K4 Post with no exit status in the payload → `exit: null`, never a failure.
- K5 Background call → pre-check only.
- K6 Any internal error → allow, error logged, counter incremented.
- K7 Handler exceeds 1 s (injected delay) → allow.
- K8 The handler never emits an allow or approve decision (scan all outputs).
- K9 Stop hook prints a recap only when there were saves, headed with the tier.
- K10 Session start refreshes the bundle and the briefing.
- K11 Pre handler runs under 100 ms warm on the 5,000-file fixture.
- K12 Rewrite mode is off by default and only active after `kerb config set claude.rewrite true`.
- K13 Hash budget exceeded in pre → allowed, skip recorded.
- K14 The agent's Bash timeout from the payload caps `kerb run` and `kerb wait-for`.

**I. Init and doctor**
- I1 Merges into existing agent settings without losing keys.
- I2 Running `init` twice changes nothing.
- I3 `uninstall` restores the original files byte for byte (outside markers).
- I4 Existing status line is kept; instructions printed.
- I5 `.kerb/` added to `.gitignore` once.
- I6 Skill installed with frontmatter on line 1.
- I7 `--dry-run` changes nothing and lists the plan.
- I8 `doctor` reports a missing hook with the exact fix.
- I9 Hook commands use absolute paths (the binary's, or Node's plus the script's).
- I10 After switching Node versions (simulated by moving the recorded Node path), `doctor` reports a stale path and `init --refresh` fixes it.
- I11 `init` output states each agent's tier.

**G. Other adapters** (per agent)
- G1 Blocked command denied (hook agents). G2 Allowed command passes with no decision. G3 Results recorded. G4 Fail open. G5 Instructions-only path when hooks are absent, tier recorded as best effort. G6 `init` and `uninstall` idempotent. G7 Recorded payload fixtures from the real agent are in the repo.

**N. Instructions and briefing**
- N1 Block written between markers; re-run updates in place.
- N2 Briefing at most 10 lines and 300 tokens (4 bytes per token).
- N3 Briefing regenerated on a new confirmed boundary.
- N4 Written to `CLAUDE.md`, `GEMINI.md`, `copilot-instructions.md` only when they exist; `AGENTS.md` always.
- N5 Instructions tell agents to trust the `kerb:` line over exit codes.
- N6 Instructions and skill tell agents to use `kerb wait-for` for polling.

**V. Visibility**
- V1 `statusline` under 80 characters, under 50 ms.
- V2 Zero segments dropped.
- V3 Stale-cache, error and slow-hashing warnings appear.
- V4 `--segment` prints only Kerb's part.
- V5 Recap printed only with at least one save.
- V6 `recap off` silences it.
- V7 No colour when not a TTY or `NO_COLOR` is set.
- V8 Refusal colours as specified in a TTY.
- V9 Recap and status show the tier.
- V10 `card --week` writes a valid SVG (parses as XML) and HTML.
- V11 `--anonymous` omits the repo name.
- V12 No dollar figure unless prices are set; if shown, labelled "est.".
- V13 PNG written when a converter exists; otherwise the screenshot hint.
- V14 `watch` prints new events within 1 s.
- V15 `watch` survives log rotation.

**Q. Reporting**
- Q1 Measured and estimated sections are separate and labelled.
- Q2 Output avoided equals the sum of matched runs' shown bytes.
- Q3 Run time avoided equals the sum of matched runs' durations.
- Q4 Never prints "turns saved".
- Q5 Estimated section prints the formula and assumptions.
- Q6 `why` shows the matched run, its failure kind and evidence.
- Q7 `history --key` filters.
- Q8 `status` shows each agent's tier, and for enforced agents the coverage share and hash-budget skips.
- Q9 `report` counts polls folded as attempts, not turns.

**E. Enterprise**
- E1 Managed config found at each OS path.
- E2 Managed `defaults` override user config.
- E3 `locked` keys can't be changed.
- E4 `lock_repo_alternatives` works.
- E5 Managed pinned key cannot be overridden by user config.
- E6 `export-denials` contains no command text or output.
- E7 `review` keeps only entries from 3+ machines.
- E8 `review` writes a valid policy patch and a Markdown summary.
- E9 `review` never proposes loosening a higher-layer block.
- E10 Telemetry off by default: no request (spy).
- E11 When on: one batch at session end, valid OTLP JSON.
- E12 No commands or paths in telemetry unless `include_commands`.
- E13 Telemetry failure is silent and counted.

**Z. Performance, hygiene and distribution**
- Z1 `kerb check` cold start under 60 ms (CI: 150 ms).
- Z2 Shaping throughput at least 50 MB/s.
- Z3 Only `bound/org.js` and `telemetry/otlp.js` import network modules or call `fetch` (check import specifiers and `fetch(` call sites, not URL strings).
- Z4 `package.json` has no `dependencies` or `devDependencies`.
- Z5 Warm p50 and p95 of `kerb hook claude pre` are recorded by the benchmark harness.
- Z6 Policy regexes are only applied to lines up to 4 KB (a 1 MB line doesn't stall matching).
- Z7 Each standalone binary passes the CLI smoke suite with no Node on `PATH`.
- Z8 Checksums and attestations are published for every binary.
- Z9 The Homebrew formula installs the release binary and `kerb doctor` passes.

---

## 12. Launch

### 12.1 Before publishing

- [ ] **Name check:** `npm view kerb`, GitHub, crates.io, Homebrew, a domain. If `kerb` is taken on npm, publish as `@<you>/kerb` and keep the command `kerb`. Fallbacks: `rut`, `lanes`. (Known conflict: `bumper` is an existing Claude Code guardrail; don't use it.)
  Checked 2026-10-01: `kerb` on npm is taken (an unrelated utility library, `0.0.0-rc1`, last modified 2023-10-09), so the npm package is `kerb-cli` (free on 2026-10-01; the command stays `kerb`). Repository: `github.com/eeshwarantharan/kerb`; Homebrew tap: `eeshwarantharan/homebrew-tap`.
- [ ] Repo description: "Stops AI coding agents from wasting turns on blocked actions and retries that can't help."
- [ ] Topics: `ai-agents`, `claude-code`, `github-copilot`, `developer-tools`, `llm`, `cli`, `devex`.
- [ ] Clean-machine install on macOS, Linux and Windows for each distribution form, following the README word for word.
- [ ] Every number in the README and launch posts comes from `kerb report` or the benchmark.

### 12.2 Demo (60 to 90 seconds)

A small repo, `kerb-demo`, with a policy blocking `registry.npmjs.org` (alternative: a local mirror such as Verdaccio), protecting `main`, one failing test, and a test database that takes about 20 seconds to start.

1. Ask the agent: "Add left-pad and make the tests pass."
2. `npm install left-pad` → `policy_blocked`; the agent uses the mirror.
3. The tests fail on the database not being up; the agent reruns immediately → `identical_retry` pointing to `wait-for`; the agent runs `kerb wait-for -- npm test`, which returns once the database is up.
4. A real test failure; the agent reruns without changes → `identical_retry`.
5. The agent fixes the code; the tests pass.
6. The recap appears; the status line shows the saves.
7. `kerb card --session` → show the card.

Record with asciinema or VHS. Use the real numbers on screen.

### 12.3 Benchmark

- Setup: 20 to 30 realistic tasks in sandboxed repos with a restrictive egress allowlist (blocked public registries, a working internal mirror), protected branches, flaky and slow tests, services that start late, and at least one large monorepo (100,000+ files).
- Run the same agent and model on every task, with and without Kerb, three times each.
- Measure: task success rate, turns, input and output tokens, wall time, refusals and whether each was correct, hash-budget skips, and hook latency p50/p95.
- **Launch gate:** success rate with Kerb is no lower than without (within 1 point), and there are zero incorrect refusals on the benchmark.
- **Latency gate:** warm hook p95 under 100 ms; if not, apply the port decision in section 5.
- Publish the harness, the tasks and the raw results in `bench/`.

### 12.4 Posts

**LinkedIn (draft; fill brackets only with measured numbers):**

> AI coding agents waste paid turns in boring ways: they retry blocked registries, re-run failing tests without changing anything, poll a database by re-running tests turn after turn, and edit their way back into states that already failed. Every retry re-sends the whole conversation.
>
> I built Kerb, an open-source guard that sits in front of the agent's shell:
> - It knows your environment's boundaries and refuses blocked actions before they run, naming the approved alternative
> - It learns new blocks from real policy denials, so each wall is hit once
> - It refuses retries that can't help, judged by whether your files or environment actually changed, and still allows the legitimate ones
> - It folds polling into one call and kills hung commands
> - It shows every save in a status line and a session recap
>
> On a [N]-task benchmark: [measured result], with no drop in task success.
>
> Zero dependencies. No network unless your admin configures it. Works natively with Claude Code, and with Copilot, Cursor, Codex and others.
>
> Repo: [link]. If you run agents in a locked-down enterprise, I'd love to hear which walls yours hit most.
>
> #AIagents #DeveloperTools #OpenSource #ClaudeCode #GitHubCopilot

**Show HN:** "Show HN: Kerb – stop coding agents retrying blocked or already-failed commands"

Also: r/ClaudeAI, r/ChatGPTCoding, the Claude Code and Copilot community discussions.

### 12.5 First month

- [ ] Reply to every issue within a day; every false-refusal report gets a regression test.
- [ ] A "signature of the week": add denial signatures and transient patterns people report.
- [ ] Recruit two design-partner teams to try the org bundle and review flow.
- [ ] Publish a follow-up post with community `kerb report` numbers (with permission).

---

## 13. Decisions log

Append one line per decision: date, section, decision, reason, source link.

- 2026-10-01 · 1.4, 4.7 · No agent-settable flag or variable to bypass Loopbreaker. Polling is handled by `kerb wait-for` and cooldowns for dependency-unavailable failures. Reason: an agent in a debugging spiral would set any bypass on every command.
- 2026-10-01 · 4.7.2 · Workspace hashing uses `git status` plus the HEAD tree id, scoped to the command's package plus root shared files, with a hash budget that fails open. Reason: full-repo hashing doesn't scale to large monorepos; git already tracks changes efficiently, including ctime.
- 2026-10-01 · 4.7.4 · Added cloud throttling and gateway errors to transient patterns; `500` and "does not exist" stay ordinary. Reason: those are usually real bugs. Cloud CLIs are class `other`, so their retries are never refused.
- 2026-10-01 · 4.10.3 · Agents are labelled enforced (native hook) or best effort (instructions). Reason: instruction-following degrades in debugging spirals; users must know which guarantee they have.
- 2026-10-01 · 5 · Standalone binaries and Homebrew are first-class for 1.0; hooks use absolute paths. Reason: Node version managers break global npm installs. A Go or Rust port of the hook path is triggered only by measured latency.
- 2026-10-01 · 4.4 · `cd`, `pushd` and `popd` are neutral when computing a command's class, so `cd src && grep x` is a query and `cd pkg && npm test` is a check. Reason: a directory change runs nothing; treating it as `other` would make every `cd … && grep` look like a setup step.
- 2026-10-01 · 4.4 · Command substitutions (`$(…)`, backticks) are kept as literal text and not inspected. Heredoc bodies are skipped. Reason: simplest reading; missing a nested command can only cause fewer refusals, never a false one.
- 2026-10-01 · 4.4 · A policy `check_commands` pattern without `*` also matches the same command with extra arguments (`just test` matches `just test --verbose`). Reason: that is what a team writing `just test` means.
- 2026-10-01 · 4.8.3 · URL hosts are extracted only from segments whose program is network-capable (curl, wget, package managers, git network subcommands, docker, ssh…), and never from config subcommands (`npm config set registry …`, `git remote set-url …`). Reason: `grep https://registry.npmjs.org`, `echo …` or `git commit -m "see https://…"` mention a host without contacting it; refusing them would be a false refusal.
- 2026-10-01 · 4.8.3 · The npm-family registry follows npm's real precedence: `--registry`, then `npm_config_registry`, then the project `.npmrc` (cwd upward), then `~/.npmrc`, then the default. yarn also reads `.yarnrc.yml`/`.yarnrc`, bun reads `bunfig.toml`. When a config file names a registry through an unset `${VAR}`, or uv/cargo configure an index Kerb can't parse, no implicit host is assumed. Reason: the spec's order put env after the files, which would refuse installs npm actually sends to an allowed mirror. Source: https://docs.npmjs.com/cli/v10/configuring-npm/npmrc
- 2026-10-01 · 4.8.3 · `cargo build` does not imply crates.io; only `cargo add` and `cargo fetch` do (unless `--offline`/`--frozen` or a source replacement is configured). Reason: whether a build needs the network depends on the local registry cache, which Kerb can't see; assuming it would refuse offline builds.
- 2026-10-01 · 4.5 · The child runs as `/bin/sh -c 'exec /bin/sh -c "$1" 2>&1'`, so stderr is merged into stdout at the source and the interleaving in the log is exact. Kerb prints shaped output on stdout and its own lines on stderr.
- 2026-10-01 · 4.5 · The `start` record is appended in the same tick right after `spawn()` returns, so it can carry the PGID. Reason: the PGID doesn't exist before spawning; nothing can run between spawn and the write.
- 2026-10-01 · 4.5 · When the main child exits but a background grandchild still holds the output pipe, Kerb drains for 500 ms and returns; it doesn't kill processes that outlive a successful command (only timeouts, idle timeouts and signals kill the group). Reason: `(server &); npm test` must not kill the server or hang until the timeout.
- 2026-10-01 · 4.7.2 · Git mode runs `git --no-optional-locks status --porcelain=v2 -z --untracked-files=normal`, with no pathspec for whole-repo scope, and expands untracked directories with `git ls-files -o --exclude-standard`. Reason: measured on a 100,000-file repo with fsmonitor and untracked cache (git 2.39): any pathspec, even `.`, and `-uall` both bypass the untracked cache (~300–550 ms); this form takes ~80 ms warm. `--no-optional-locks` avoids taking `index.lock` while the agent runs git itself.
- 2026-10-01 · 4.7.2 · Outside git, the "repo root" is the nearest ancestor containing `.kerb` or `kerb.policy.json`, else the current directory.
- 2026-10-01 · 4.7.6 · Loop checks read at most the last 8 MB of `runs.jsonl` (current plus previous rotated file). A run with an unknown exit (`exit: null`), a policy denial or an abort is neither a failure nor a success: it breaks a breaker streak and never triggers a refusal. Reason: bounded hook latency; missing old history can only mean fewer refusals.
- 2026-10-01 · 4.7.6 · "No other command has finished since R" also counts background commands (L3 requires a background server start to make the retry legitimate).
- 2026-10-01 · 4.7.7 · A `human_only` pre-check refusal uses the policy exit code (77); `kerb ack|reset|forget|config set|uninstall` and `run --force` then need the typed code on `/dev/tty` (exit 64 without one). `kerb config get` needs no code. The hook still refuses every `kerb config` call from the agent.
- 2026-10-01 · 4.7.8 · `wait-for` has no `--force` (Loopbreaker rules never apply to it). A `--max` above the agent's tool timeout minus 10 s is capped with a note, not a usage error; values above 30 minutes are a usage error.
- 2026-10-01 · 4.14.2 · If the lock can't be taken within 2 s, the append proceeds without it (appends use `O_APPEND`) and the event is logged to `~/.kerb/errors.log`. Reason: fail open; a stuck lock must not stop commands.
- 2026-10-01 · 4.9 · Records carry a few extra fields beyond 4.9 (`class`, `key`, `session` and `log` on `end`; `start_ts`, `cmd` on `wait`; `learn`, `ack` and `reset` record types). Reason: summary, watch and the rules read them without joining.
- 2026-10-01 · 4.10.2 · VERIFY (Claude Code hooks reference, https://code.claude.com/docs/en/hooks): `PreToolUse` for `Bash` carries `tool_input.{command, description, timeout (ms), run_in_background}` and `tool_use_id`; deny is `hookSpecificOutput.permissionDecision: "deny"` with `permissionDecisionReason` (shown to Claude); exit 2 with stderr is the fallback. `PostToolUse` fires only for successful calls and its Bash `tool_response` is `{stdout, stderr, interrupted, isImage}`, with no exit code. Failed calls fire `PostToolUseFailure` with `error` whose first line is `Exit code N`, plus `is_interrupt` and `duration_ms`. Kerb records `PostToolUse` as exit 0, parses `Exit code N` from failures, and records `exit: null` (never a failure) when a failure has no exit-code line. Hook `timeout` is in seconds.
- 2026-10-01 · 4.10.1 · VERIFY: `updatedInput` is honoured with `"allow"` (auto-approves) or `"ask"` (forces a prompt), and ignored otherwise. There is no way to rewrite a command without changing the user's permission behaviour, so rewrite mode stays unavailable for Claude Code: `claude.rewrite` is accepted in config, the hook never emits `updatedInput`, and `kerb doctor` warns that it is ignored.
- 2026-10-01 · 4.10.2 · VERIFY: `Stop` fires after every assistant turn and shows a top-level `systemMessage` to the user; `SessionEnd` discards JSON output. The recap is therefore sent from `Stop`, and only when the session has saves that weren't in the previous recap. The status line is `statusLine: {type: "command", command}` in settings; Claude's Bash default timeout is 2 minutes (`BASH_DEFAULT_TIMEOUT_MS`), used as the agent timeout when a call sets none. Source: https://code.claude.com/docs/en/statusline, https://code.claude.com/docs/en/tools-reference
- 2026-10-01 · 4.10.2 · Hooks go into `.claude/settings.local.json` (per machine, not committed), because they contain absolute paths. `PreToolUse` notes (suspected walls) and `PostToolUse` notes (a newly learned wall, `fixes` hints) reach Claude through `additionalContext`, which never carries a decision. `SessionStart` also passes the boundaries briefing as `additionalContext`.
- 2026-10-01 · 4.10.1 · The `start` hook gets a 3-second internal deadline instead of 1 second, because the org bundle fetch alone may take 2 seconds; Claude Code runs SessionStart hooks in the background. `pre`, `post` and `stop` keep the 1-second deadline.
- 2026-10-01 · 4.10.2 · The payload fixtures in `test/fixtures/hooks/claude/` follow the documented shapes; they are to be replaced by payloads captured from a real session during dogfooding (7.3).
- 2026-10-01 · 4.10.2 · A `kerb run` / `kerb wait-for` the agent starts through a hooked Bash call finds the pre hook's pending record (matching its inner command, less than 10 minutes old) and takes the agent's timeout, session and the `enforced` tier from it. The hook itself doesn't record Kerb invocations, so there is exactly one record per run.
- 2026-10-01 · 4.10.3 · VERIFY GitHub Copilot (https://docs.github.com/en/copilot/reference/hooks-reference, https://code.visualstudio.com/docs/agents/reference/hooks-reference): Copilot CLI and the VS Code Local agent both read `.github/hooks/*.json`, and both accept the Copilot format (`version: 1`, camelCase events). Kerb writes one file, `.github/hooks/kerb.json` (gitignored: absolute paths), with no matcher, and the adapter handles both payload dialects. Deny is `permissionDecision: "deny"` (top-level for the CLI, inside `hookSpecificOutput` for VS Code); Kerb emits both. A command `preToolUse` hook that exits non-zero *denies* the call, so the handler always exits 0. Copilot CLI payloads carry no call id and no exit code; the exit code is parsed from the tool text (`<exited with exit code N>`) when present, else `null`. VS Code Local has no failure event. Tier: enforced; Loopbreaker works only when the exit code is visible in the payload.
- 2026-10-01 · 4.10.3 · Copilot CLI also reads `.claude/settings.json` and `.claude/settings.local.json`, so with both Claude Code and Copilot installed, one call can reach two Kerb hooks. The pre hook answers a repeat of the same call (same id, or same session + cwd + command without an id) within 3 s from the first answer, and the post hook skips a call already recorded in the last 5 s. The Claude adapter labels payloads in Copilot's dialect (`timestamp`, no `transcript_path`) as `copilot`.
- 2026-10-01 · 4.10.3 · VERIFY Cursor (https://cursor.com/docs/hooks): Kerb uses `preToolUse`, `postToolUse` and `postToolUseFailure` with matcher `Shell` rather than `beforeShellExecution`/`afterShellExecution`, because only the former carry `tool_use_id` and an exit code (`tool_output` is a JSON string with `exitCode`). Deny is `{permission: "deny", user_message, agent_message}`. To allow, the hook prints nothing: Cursor treats "no output" as a hook failure, which fails open unless `failClosed` is set, so Kerb never answers `"allow"`. Cursor's `stop` hook has no user-visible output (`followup_message` would be sent as a user message), so Cursor gets no recap. Hooks go in `.cursor/hooks.json`; Kerb gitignores it only when it created the file, and otherwise warns if it is committed. Tier: enforced; to re-check during dogfooding that empty output doesn't block.
- 2026-10-01 · 4.10.3 · VERIFY Codex CLI (https://developers.openai.com/codex/hooks): Claude-style `.codex/hooks.json`, `PreToolUse`/`PostToolUse` with matcher `Bash`, `tool_use_id`, `tool_input.command`, deny via `hookSpecificOutput.permissionDecision: "deny"`; `PostToolUse` also runs after non-zero exits; hooks are on by default, but project hooks run only after the user trusts them in `/hooks` (init says so). The exit code is read from an exit field or from `Exit code: N` in `tool_response`. Tier: enforced.
- 2026-10-01 · 4.10.3 · VERIFY Gemini CLI (https://geminicli.com/docs/hooks/reference): `.gemini/settings.json` hooks `BeforeTool`/`AfterTool` with matcher `run_shell_command`; deny is `{decision: "deny", reason}`; timeouts are in milliseconds; the shell tool output carries `Exit Code: N`. Kerb drops the `Process Group PGID`, `Background PIDs` and `Directory` lines before fingerprinting, since they differ on every run. `SessionStart` takes `additionalContext`; the recap goes out on `AfterAgent` as `systemMessage`. No call id, so calls are matched by session + cwd + command. Tier: enforced.
- 2026-10-01 · 4.10.3 · VERIFY OpenCode (https://opencode.ai/docs/plugins/, plugin types in `packages/plugin/src/index.ts`): `kerb init` writes `.opencode/plugins/kerb.js` (gitignored), which pipes `tool.execute.before`/`after` for the `bash` tool to `kerb hook opencode pre|post` and throws Kerb's refusal text to block. The exit code comes from `metadata.exit`. Tier: enforced.
- 2026-10-01 · 4.10.3 · `kerb init --agent other` is the instructions-only path (AGENTS.md; tier best effort) for agents without hooks. Every agent Kerb knows today has native hooks, so all are enforced when detected.
- 2026-10-01 · 4.14.5 · Telemetry is on only when an endpoint is set (managed `telemetry.otlp_endpoint`, or user `telemetry.otlp_endpoint`) *and* the `telemetry` setting is `on`. The default is `off`, so an organisation turns it on with managed `defaults: {telemetry: "on"}` and locks it. The batch goes out from a new session-end hook (`kerb hook <agent> end`, installed for Claude Code, Copilot, Cursor, Codex and Gemini), once per session, to `<endpoint>/v1/metrics`. Denial events are sent as data points of `kerb.walls_learned` with `kerb.host` and `kerb.status` attributes. The only identity sent is a pseudonymous machine id (a hash of hostname and home path).
- 2026-10-01 · 4.8.5 · `export-denials` sends pattern, status, hits, the number of distinct commands, first/last seen and a pseudonymous machine id. It never sends command text, output, keys or run ids. `review` counts machines by that id and lists hosts already covered by a non-learned boundary under "already blocked" without proposing anything for them.
- 2026-10-01 · T0 · Every command prints exactly one JSON object with `--json`, except `kerb watch`, which is a stream (one JSON object per event per line with `--json`), and `kerb hook`, which prints whatever the calling agent's protocol requires.
- 2026-10-01 · 4.7.2 · Whole-repo scope takes its base from `git status --branch` (the HEAD commit id), not from a separate `git rev-parse HEAD^{tree}`. That saves one git spawn per check. A new commit with an identical tree now changes the hash, which can only mean fewer refusals.
- 2026-10-01 · 4.10.1 · Hooks hash the workspace before a check command only when that key has a failure in its current window; otherwise no rule can refuse, so the `git status` spawn is skipped. The post hook always records the post-hash for check commands, so the next attempt can still be judged. `kerb run` keeps hashing before and after.
- 2026-10-01 · 5, 12.3 · Hook latency on the dev machine (Apple Silicon, 8 cores, 5,000-file git repo, warm, end to end including process start; `bench/results/`). Standalone binary (Node 24 with V8 code cache): p95 69 ms plain, 71 ms check, 98 ms check after a failure (102.5 ms in an earlier run), 82 ms blocked. npm install on Node 20: p95 82 / 94 (one 446 ms outlier run) / 136 / 113 ms; Node's own start-up is ~44 ms of each. Start-up work done: lazy `node:crypto` (18 ms to load) and `node:child_process`, a pre/post split of the hook observer, and a runner that loads only when a command runs; `kerb check` adds ~20 ms over bare Node. Decision: the binary is the recommended install for hooks. The gate is borderline for "check after a failure", which is dominated by the `git status` spawn. Per section 5, if the CI benchmark machines show warm p95 over 100 ms, the hook path (`hook`, `check`) gets ported to Go or Rust behind the same CLI contract and test suite. That port is not done: no Go or Rust toolchain was available in this build environment, and the gate has to be measured on the benchmark machines first.
- 2026-10-01 · 7.2 · Standalone binaries: `scripts/bundle.js` turns src/ into one CommonJS file (no dependencies; checks for import cycles; handles named/default exports, dynamic `import()` and `import.meta.url`), and `scripts/build-binaries.js` injects it into the official Node v24.21.0 binary for each target with postject (fetched by npx at build time, not a dependency), after verifying the Node archive against nodejs.org's SHASUMS256.txt. The V8 code cache is enabled only when target equals build machine, so CI builds each target on its own runner. The darwin-arm64 binary passes the full test suite (`KERB_TEST_BIN=dist/bin/kerb-darwin-arm64 node --test`) and runs with no Node on PATH.
- 2026-10-01 · 11 (Z1, W14) · Start-up and 100,000-file timing tests run only with `KERB_TEST_PERF=1` (the CI performance job, files one at a time). Under the default parallel `node --test`, other test files saturate the CPU and the timings mean nothing. Measured locally: `kerb check -- ls` adds ~20 ms over bare Node (whose own start-up is 44–57 ms on the dev machine); the spec's 60 ms absolute target assumes a faster Node start-up than this machine has.
- 2026-10-01 · 7.3 · Dogfooding so far is best effort only: the building agent ran its own commands through `kerb run` in this repo (`docs/dogfood.md`). Claude Code's CLI isn't on PATH in this build environment, and starting nested agent sessions would spend the owner's quota unasked, so the full enforced sessions (and the large-monorepo session) are left for the maintainer. This repo now has its own `kerb.policy.json`.
- 2026-10-01 · 7.4 · The task benchmark (22 tasks × with/without × 3 runs) is built (`bench/run.js`, `bench/tasks.js`, egress proxy `bench/proxy.js`) and tested with a scripted stand-in agent (`bench/fake-agent.js`, whose numbers must never be reported), but it has not been run with a real agent: that needs a model budget the owner should approve. The launch gate is therefore not evaluated, and the README states that no savings figure exists yet.
- 2026-10-01 · 12.1 · `kerb` on npm is taken by an unrelated package, and the `kerb-dev` GitHub org used as a placeholder already exists. Nothing was published or created. The owner picks the npm scope and the repository owner and replaces `kerb-dev` in `package.json`, the README, the workflows and `scripts/homebrew.js`.
- 2026-10-01 · 4.7.8 · `wait-for` starts another attempt only when at least 1 s remains before `--max`. Found by the shuffled runs: an attempt started milliseconds before the deadline was killed before printing, and the "last output" was empty.
- 2026-10-01 · 4.4, 4.7.4 · From dogfooding: `node --test` (Node's built-in runner) joins the default check commands, and unit-less timing fields named `*_ms`/`*_s` (e.g. TAP's `duration_ms: 1.68`) are normalised in fingerprints, so repeated `node --test` failures can match.
- 2026-10-01 · 4.7.2 · Hooks use the user's `hash_budget_ms` when set; otherwise 300 ms.
- 2026-10-01 · 12.1 · Names settled with the owner: npm package `kerb-cli` (installs the `kerb` command), repository `eeshwarantharan/kerb`, Homebrew tap `eeshwarantharan/homebrew-tap`. The first public release is 0.1.0, a preview: 1.0 waits for the benchmark gate, an enforced dogfood session and green Linux/Windows CI.
- 2026-10-01 · 4.5.7 · On Windows, `kerb run` and `wait-for` run commands with Git Bash when it is installed (`CLAUDE_CODE_GIT_BASH_PATH`, then the usual Git for Windows locations, then `bash.exe` on PATH, skipping the WSL launcher in System32), merging stderr into stdout as on POSIX, and fall back to `cmd.exe` otherwise. Reason: agents on Windows, Claude Code among them, send bash commands and run them in Git Bash; `cmd.exe` would break them. Found by the first Windows CI run.
