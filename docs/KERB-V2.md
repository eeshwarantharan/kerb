# KERB-V2.md · Architecture and build plan

**Kerb v2 knows what actually ran, what is verified right now, and exactly which change broke or fixed what.** It keeps everything v1 does (Boundary Map, Loopbreaker, supervisor, shaping, visibility, org policy) and adds an **outcome graph**: every result stored under the exact state of the code and environment it came from. Instant answers, live verification, last green, cause isolation, proven fixes and convergence tracking all fall out of that one structure.

This document is an **addendum to `docs/KERB.md` (v1)**. Save it as `docs/KERB-V2.md`. Where it changes v1 behaviour it says so explicitly; everything else in v1 stays authoritative.

---

## 0. How to use this document

**For the human:** sections 1–3 explain the product and the architecture. Section 13 is the build plan; section 15 is the benchmark and launch gate.

**For the building agent:**

1. Read `docs/KERB.md` and this file completely before writing code.
2. The same rules as v1 apply: the spec wins; **VERIFY** means read the current official documentation and record findings with date and URL in section 16 (Decisions log); prefer the reading that keeps false refusals low; fail open; deny-only; no runtime dependencies; no network except admin-configured endpoints.
3. Work milestone by milestone (section 13). Each milestone ships as a release. Run `node --test` and commit after every step.
4. Never break v1 behaviour without a test proving the replacement is equivalent or better.

---

## 1. Product thesis

### 1.1 What models lack, and Kerb supplies

| Models struggle with | Why | What Kerb v2 supplies |
|---|---|---|
| **Credit assignment.** Which of my changes caused this test to go red or green? | They see snapshots and logs, not state over time | **Cause isolation** and **proven fixes**, computed deterministically |
| **Knowing what is verified *now*** | "I ran the tests" is true until the next edit; models don't track that | **Live verification status** bound to the exact current state |
| **Remembering attempts** across compaction and sessions | Context is lossy; summaries are lossy | An **attempt ledger** built from records, not summaries |
| **Cheap experiments** | Every probe costs a turn | A **background worker** that runs probes in separate worktrees |
| **Recognising convergence, stalls and oscillation** | Each turn sees one result | A **convergence signal** over the whole series |

### 1.2 Positioning

- **One line:** "Kerb gives coding agents what they can't do for themselves: it knows what actually ran, what's verified right now, and which change broke what."
- **Pitch "proof", not "memory".** Memory tools (claude-mem, built-in auto memory) summarise what the model saw. Kerb records what actually happened, deterministically, at zero token cost, offline. It's safe for enterprises.
- **Integrate, don't compete.** Memory tools, claim verifiers and delta-debugging tools should be able to read Kerb's records instead of re-running tests. Kerb publishes an open record format, a query CLI and an MCP server.
- **Skills fix the thinking; Kerb fixes the facts.** Kerb ships skills that use its records, and is distributed through the same channels skills are.

### 1.3 Pillars

| Pillar | Contents | Status |
|---|---|---|
| **Guard** | Boundary Map, Loopbreaker, supervisor, shaping, human-only actions | v1, upgraded to use state ids |
| **Truth** | State model, outcome store, test-level results | new |
| **Insight** | Deltas, verification status, convergence, ledger, instant answers, last green, cause, proven fixes, environment classifier | new |
| **Platform** | Record format, `kerb query`, MCP server, plugin API, skills pack | new |
| **Adoption** | `kerb scan`, shadow mode, progressive CLI, marketplaces | new |

### 1.4 New principles (in addition to v1's)

1. **Deterministic first.** No insight engine calls a language model. Every statement Kerb makes is derived from recorded facts and can be traced with `kerb why`.
2. **Hints, never instructions, for anything inferred.** A proven fix or a cause finding is presented as evidence with a confidence level, never as "do this".
3. **Never touch the working tree.** Background work happens in separate worktrees. Restores produce patches; only a human can restore in place.
4. **Local by default.** States, fixes and findings stay on the machine. Sharing is explicit, human-enabled, and shares references, not code.
5. **Every claim has a confidence.** Findings are `confirmed` (reproduced) or `undetermined`. Kerb never invents a culprit.

### 1.5 Non-goals for v2

LLM-summarised memory; a hosted service; running or orchestrating agents; model routing (v3 may consume the convergence signal); fuzzy similarity search over fixes beyond exact and family fingerprints.

---

## 2. What changes from v1

| Area | v1 | v2 |
|---|---|---|
| Workspace hash | Custom hash over git status and dirty-file content | **State id** derived from a git tree snapshot (section 4). Equivalent identity, now restorable |
| Results | Command-level exit code and fingerprint | Plus **test-level results** from reporter parsers |
| identical_retry | Refuses | For hermetic commands, **answers from cache** instead of refusing |
| deja_vu | Two-state return | Plus **oscillation**: cycles across up to four states |
| Failure kinds | transient, dependency, ordinary | Plus **environment** (TLS interception, proxy pages, auth expiry); never loop-counted |
| Output to the agent | Shaped output and refusals | Plus **deltas**, **ledger**, **verification status**, **fix and cause hints** |
| Default mode | Enforce | **Shadow for the first 7 days** after `init`, then the user opts in |
| Storage | JSONL records | JSONL event log stays the source of truth, plus rebuildable indexes and git objects for snapshots |
| Interfaces | CLI, hooks | Plus `kerb query`, `kerb mcp`, plugins, skills |

---

## 3. Architecture

### 3.1 Layers

```
                ┌───────────────────────────── Surfaces ─────────────────────────────┐
                │ hook injections · CLI · status line · recap · card · kerb query    │
                │ kerb mcp (read-only) · plugin events · skills pack · kerb export   │
                └──────────────────────────────────▲─────────────────────────────────┘
                                                   │
 ┌──────── Guards ────────┐   ┌──────────────── Insight engines ─────────────────┐
 │ Boundary Map           │   │ delta · verification · convergence · ledger      │
 │ Loopbreaker (+cycles)  │◀──│ instant answers · last green · environment       │
 │ human-only             │   │ cause isolation · proven fixes  (worker jobs)    │
 └───────────▲────────────┘   └────────────────────────▲─────────────────────────┘
             │                                          │
             └────────────────── Truth ─────────────────┘
                 state model (git trees) · event log (JSONL) · indexes
                 test-level results · fixes · findings · boundaries
                                   ▲
 ┌──────────────────────────── Capture ───────────────────────────────┐
 │ agent hooks (pre, post, session start, compact, stop) · kerb run   │
 │ reporter parsers · transcript readers (kerb scan)                  │
 └────────────────────────────────────────────────────────────────────┘
                     Background worker: probes in .kerb/worktrees/
```

### 3.2 Request path (enforced agent)

1. **SessionStart** (also after compaction or resume): refresh the org bundle; inject the briefing, the attempt ledger and the verification status (section 9).
2. **PreToolUse** (shell): parse → human-only → Boundary Map → for check commands, compute the state id → instant answer or Loopbreaker → allow or deny. Under 100 ms warm (v1 budget).
3. The command runs (the agent's own tool).
4. **PostToolUse:** compute the post-state, record the result, parse test results, classify failures, then build and inject the delta, environment fix and any fix or cause hint. Queue worker jobs. Under 150 ms warm, excluding reporter parsing of very large outputs (budgeted separately, section 12).
5. **Stop:** recap; verification status warning or gate (section 7.2).
6. **Worker** (separate process): cause isolation, fix minimisation, index rebuilds, garbage collection. Results are delivered at the next injection point.

### 3.3 Code layout additions

```
src/
  state/snapshot.js        git tree snapshots via temporary index; walk-mode blob store
  state/id.js              state ids, scope, env stamp (from v1)
  state/materialize.js     worktrees and patches from state ids
  store/events.js          event log (v1 jsonl.js, extended record types)
  store/index.js           derived indexes, rebuild, compaction
  reporters/               one parser per test framework + registry
  insight/delta.js
  insight/verify.js        verification status
  insight/converge.js      series, stalls, cycles
  insight/ledger.js
  insight/cache.js         instant answers
  insight/green.js         last green, restore
  insight/envclass.js      environment failures and fixes
  insight/fixes.js         proven fixes, family fingerprints, notes sharing
  worker/main.js           lifecycle, queue, budgets
  worker/cause.js          isolation (delta debugging over hunks)
  worker/narrow.js         narrowing commands to single tests per framework
  scan/                    transcript readers per agent + replay
  platform/schema/         JSON Schemas for the record format
  platform/query.js
  platform/mcp.js          minimal MCP server over stdio
  platform/plugins.js
skills/                    kerb, kerb-diagnose, kerb-before-done
```

---

## 4. State model

### 4.1 State id

A **state** is the content of a check command's scope plus its environment stamp.

- **Git mode:**
  1. Copy the repo index to `.kerb/tmp/index-<pid>` and set `GIT_INDEX_FILE` to it.
  2. `git add -A -- . ':(exclude).kerb'` (only dirty paths are rehashed, because the copied index already has stat data), then `git write-tree` gives the **snapshot tree** (including untracked, non-ignored files).
  3. Scope subtree id: `git rev-parse <snapshot>:<package path>` (or the root tree), plus the blob ids of root shared files (v1 section 4.7.2).
  4. `state_id = "st_" + sha256(scope subtree id ‖ shared blob ids ‖ env stamp)[0..16]`.
- **Walk mode** (outside git): v1 walk hash, with dirty file content stored in `.kerb/blobs/<sha256>` (content-addressed, deduplicated). The state stores a path → blob map.
- Files over 5 MB are hashed (v1 rule) but not stored; such a state is marked `materializable: false`.
- The hash budget from v1 still applies; if exceeded, the run gets `state: null` and loop checks are skipped (fail open).

This replaces v1's custom workspace hash with git's own content addressing. Identity semantics are the same (W1–W16 must still pass), and states become **restorable**.

### 4.2 Keeping snapshots alive

- To protect snapshot trees from `git gc`, Kerb creates a commit object for each kept state (`git commit-tree <tree> -p HEAD -m "kerb state <id>"`) and a ref `refs/kerb/states/<id>`.
- **Retention:** the last 20 states per key; every state that was green in the last 14 days; every state referenced by a fix or finding. `kerb gc` deletes other refs (the worker runs it daily). Git reclaims objects in its own gc.
- **Never pushed.** `refs/kerb/*` is outside default push refspecs. `kerb doctor` warns if a remote has `mirror = true` or a push refspec matching `refs/*`, and the hook adds a note to any agent `git push --mirror`.
- **Recorded:** `{ "type":"state", "id", "scope", "snapshot_tree", "commit", "env_stamp", "materializable", "ts" }`.

### 4.3 Materializing a state

- **Worktree:** `git worktree add --detach .kerb/worktrees/<job> <state commit>`. Dependency directories (policy `worktree_links`, default `node_modules`, `.venv`, `vendor`, `target`) are symlinked from the main checkout. If the dependency env stamp differs between the state and now, the job reports `undetermined: dependencies changed` instead of running.
- **Patch:** `git diff <current snapshot> <state snapshot> -- <scope>` written to `.kerb/patches/<id>.patch`.
- Worktrees are removed after each job; `kerb gc` also removes stale ones.

---

## 5. Truth: records and test-level results

### 5.1 Record format: Kerb Execution Record (KER) v1

Published as JSON Schemas in `platform/schema/` and in the docs, with a stability promise: additive changes only within a major version. Record types:

| Type | Key fields |
|---|---|
| `session` | id, agent, tier, started, branch, mode (shadow or enforce) |
| `state` | as in 4.2 |
| `run` | id, session, key, class, scope, pre_state, post_state, exit, duration_ms, fingerprint, failure_kind, class_result, raw_bytes, shown_bytes, framework, tests_summary |
| `test_result` | run, test_id, status (pass, fail, skip, error), location, message (redacted, max 200 chars), duration_ms |
| `refusal` / `would_refuse` | id, key, reason, matched_run, avoided_duration_ms, avoided_output_bytes |
| `cached_answer` | id, key, state, source_run |
| `fix` | id, fingerprint, family, test_ids, from_state, to_state, hunks (minimal if computed), commit (once committed), confidence |
| `finding` | id, kind (`cause`), test_id, good_state, bad_state, culprit_hunks, probes, confidence, reason_if_undetermined |
| `boundary` | v1 learned entries |
| `note` | id, source (core or plugin name), text, level |

The v1 `runs.jsonl` becomes the **event log**, and all v2 types are appended to it. The v1 crc, locking and recovery rules apply unchanged.

### 5.2 Indexes

Derived, rebuildable files in `.kerb/index/`, written atomically:

- `by_key.json`: last 50 runs per key;
- `tests.json`: last 20 results per test id;
- `states.json`: state → runs, green or red per key;
- `fixes.json`: fingerprint and family → fix ids;
- `verification.json`: current status per tracked key (section 7.2).

`kerb reindex` rebuilds everything from the event log. If an index is missing or corrupt, it is rebuilt; hooks fall back to scanning the last 2,000 log lines within their budget.

### 5.3 Test identity

`test_id = framework ":" normalised file path "::" full test name` (suite path joined with ` > `). Parameterised cases keep their parameters. Ids are stable across runs and machines.

### 5.4 Reporter parsers

Each parser in `src/reporters/` takes shaped output (and, when present, a structured report file) and returns test results, or `null` if it doesn't recognise the output. Parsers never fail a run; a parse error records `framework: unknown`.

| Framework | Sources, in order of preference |
|---|---|
| Vitest | agent reporter output (**VERIFY** its format when `AI_AGENT` is set); JSON reporter file if configured; default reporter text |
| Jest | `--json` output file if present; default reporter text |
| pytest | JUnit XML if `--junitxml` used; `-rA` / default summary lines (`FAILED path::name - message`); agent-reporter plugins (**VERIFY**) |
| go test | `-json` stream; `--- FAIL: Name` text |
| cargo test | `test path ... FAILED` lines and the failures section |
| Node test runner | TAP and spec reporter text |
| tsc, ESLint, Ruff, mypy, Clippy | Diagnostics as pseudo-tests: `tool:file::rule-or-code`, so deltas work for type and lint errors too |
| JUnit XML anywhere | `**/TEST-*.xml`, `**/junit*.xml` written during the run |

`kerb run --structured` (explicit opt-in, never via hooks) may add a framework's machine-readable reporter flag. Hooks never rewrite commands (v1 rule).

---

## 6. Guards in v2

### 6.1 Loopbreaker

- Uses state ids. All v1 rules and tests (L1–L22) hold with state ids in place of hashes.
- **Oscillation (new reason `oscillating`).** Over the last 6 finished check runs of a key, if the sequence of post-states contains a cycle of length 2–4 where every run in the cycle is an ordinary failure, the next run that would continue the cycle is refused:

  ```
  kerb: oscillating · your last 4 attempts cycle between 2 file states, both failing
        states: st_7f3a (attempts 2, 4) and st_91c0 (attempts 3, 5) · changed: config/ports.ts
        next: stop editing this back and forth; explain what you've tried to the user, or try a different approach
  ```

  Rule order: identical_retry, cached answer (6.3), deja_vu, oscillating, breaker_open.
- **Environment failures** (section 8.6) are never loop failures, like policy denials.

### 6.2 Boundary Map

Unchanged from v1, except that environment fixes from section 8.6 can name a sanctioned fix (from policy) in the same way boundaries name alternatives.

### 6.3 Instant answers (replaces identical_retry for hermetic commands)

When a check command is about to run on **the same key, state id and env stamp** as a recorded run, and the command is **hermetic**, Kerb denies the call and returns the recorded result as the answer:

```
kerb: cached · same files and environment as run r-12 (4 min ago)
      result: exit 1 · 2 failing: cart.test.js:42 applies discount; cart.test.js:88 rounds totals
      next: nothing changed, so re-running gives the same result; change the code first (full log: .kerb/logs/r-12.log)
```

For a cached **success**: `result: passed (124 tests) · next: no need to re-run`.

**Hermetic** means the result depends only on files and the env stamp:

- **On by default:** static checks (`tsc`, `eslint`, `prettier --check`, `ruff check`, `mypy`, `go vet`, `cargo check`, `cargo clippy`, `deno lint`, `deno check`).
- **Opt-in:** test commands listed in policy `hermetic_commands`.
- **Never hermetic:** any run that failed transiently, with a dependency failure or an environment failure; any command with extracted network hosts; any run older than policy `cache_ttl` (default 24 h).

Each cached answer records a `cached_answer` event. Non-hermetic commands keep v1's identical_retry behaviour.

---

## 7. Insight engines

### 7.1 Delta

After every check run with test results, compare with the previous run of the same key (or, if test sets differ, the intersection of test ids):

```
kerb: npm test · 2 failing (was 5)
      + fixed: applies discount; rounds totals; handles empty cart
      ! still failing: session timeout · cart.test.js:42 expected 90, got 100
      ~ flaky: checkout retries (passed and failed on the same files)
```

- Monochrome. Prefixes `+`, `!`, `-` (new failure), `~` (flaky). At most 8 lines; then `… and N more (kerb why)`.
- **Flaky:** a test that both passed and failed on the same state id. Flaky tests are excluded from fingerprints used by breaker and oscillation rules.
- First run of a key: a summary only (`5 failing of 124`), with the first 3 failures.
- Delivered as additional context after the command (section 9). With `kerb run`, appended to the shaped output instead of the generic footer.

### 7.2 Verification status

For each tracked key (any check key run in this session or listed in policy `verify_keys`):

| Status | Meaning |
|---|---|
| `green` | Last run passed on the **current** state |
| `red` | Last run failed on the current state |
| `stale` | Last run's state differs from the current state; lists up to 5 changed files since |
| `never` | Not run this session |

- Shown by `kerb status`, the status line (`tests: green` / `tests: stale (pricing.ts)`), the MCP tool `verification_status`, and the Stop hook.
- **Stop behaviour,** from policy `stop_gate`:
  - `warn` (default): the recap says "tests are stale: last green before you edited pricing.ts".
  - `block`: block the stop once per turn with that message, then yield (block budget 1, like other Stop-hook tools).
  - `off`.
- Claim verifiers can query this instead of re-running tests.

### 7.3 Convergence

Per key, over runs since the last success:

| Signal | Rule |
|---|---|
| `converging` | Failing count fell in at least 2 of the last 3 runs |
| `stalled` | Same fingerprint set for 3 or more runs, with different states |
| `oscillating` | Cycle as in 6.1 |
| `diverging` | Failing count rose in 2 consecutive runs |
| `green` | Last run passed |

- `kerb progress [--json]` prints the series per key: `npm test: 5 → 3 → 3 → 3 (stalled)`.
- The status line shows the series for the most recent key: `failing 5→2→0`.
- The signal is a public API (MCP and query), for routers and orchestrators to consume.

### 7.4 Attempt ledger

Generated deterministically from records; at most 250 tokens (4 bytes per token):

```
kerb ledger · branch feat/cart · since 14:02
  npm test (packages/cart): 4 attempts · failing 5 → 3 → 3 → 3 (stalled)
  edited across attempts: discount.ts (2, 4), pricing.ts (3)
  attempt 4 returned to the files of attempt 2
  last green: 13:40 (st_7f3a) · now: stale
  known fix for this failure: fix:7f3a (kerb show fix:7f3a)
```

Injected at SessionStart when the session starts fresh on a branch with records from the last 24 hours, and after compaction or resume (section 9). Also available as `kerb ledger` and MCP `attempts`.

### 7.5 Last green

- `kerb green [--key K] [--test T]`: the newest state where the key passed (or the test passed), with time, run id and changed files since.
- `kerb restore <state> --patch`: writes a patch that turns the current tree into that state, for the scope only. Agents may use this, since it changes nothing by itself.
- `kerb restore <state> --keep-except <finding>`: a patch that reverts only the culprit hunks of a cause finding.
- `kerb restore <state> --in-place`: human-only (v1 4.7.7 rules); stashes current changes first (`git stash push -m "kerb restore backup"`).

### 7.6 Proven fixes

- **Recording:** when a key goes from an ordinary failure with fingerprint F to a success, record a `fix` with from_state, to_state, the tests that changed from fail to pass, and the full diff stats. The worker later minimises it (8.2) into the hunks actually needed.
- **Family fingerprint:** a coarser fingerprint of the first failing line per test, with file paths, line numbers, identifiers in quotes and numbers removed. Used only for "similar" hints.
- **Retrieval:** on a failure with fingerprint F:
  - exact match: `seen before · fixed on 14 Sep in 2 hunks (src/db/pool.ts) · kerb show fix:9a1c`;
  - family match only: `similar failure fixed before · kerb show fix:9a1c (not the same error)`.
  - At most one hint per failure. Hints carry the confidence: `minimal` (minimised and re-verified) or `full diff`.
- **Committed fixes:** when a later commit contains the to_state's changes for the scope, record the commit sha on the fix.

### 7.7 Sharing fixes (off by default)

- Enabled by a human: `kerb config set share_fixes true`.
- **Only committed fixes are shared.** Kerb writes a git note under `refs/notes/kerb` on the fixing commit containing `{fingerprint, family, test_ids, kerb_version}`. No diffs, no output, no paths beyond test ids. The commit itself carries the code.
- `kerb sync` (human or agent) runs `git fetch origin refs/notes/kerb:refs/notes/kerb-remote` and merges notes into the local fix index; `kerb sync --push` (human-only) pushes local notes.
- Uncommitted fixes, states and findings are never shared.

---

## 8. Background worker

### 8.1 Lifecycle

- `kerb worker` runs as a separate process, one per repo (lock file), spawned detached by hooks when jobs are queued, and exiting after 60 s idle.
- Jobs live in `.kerb/jobs/` (one JSON file each). States: queued, running, done, failed, cancelled.
- **Budgets:** per job (probes and wall time), per hour (default 15 CPU-minutes), and concurrency 1. Runs under `nice 10` on macOS and Linux.
- Config `worker: on|off`. Default `on` for minimisation of fixes on hermetic static checks; **cause isolation for tests is off until a human enables it** (8.2). The first time Kerb could have isolated a cause, the recap says so with the enable command.
- Disabled by default when `CI=true`.
- `kerb worker status|stop`, and `kerb jobs` to list jobs.

### 8.2 Cause isolation

**Trigger:** a test (or diagnostic) passed in run G and fails in a later run B of the same key, both states materializable, the dependency env stamp unchanged, and the test is not flaky.

**Steps:**

1. **Narrow:** build a command that runs only that test (`worker/narrow.js`, per framework: `vitest run <file> -t <name>`, `jest <file> -t <name>`, `pytest <file>::<name>`, `go test -run '^Name$' ./pkg`, `cargo test <name> -- --exact`, `node --test --test-name-pattern`). If narrowing isn't possible, use the original command with a smaller probe budget.
2. **Reproduce:** in a worktree at B, the narrowed test must fail twice; at G it must pass once. Otherwise: `undetermined: not reproducible in isolation`.
3. **Hunks:** the diff G→B within scope, split into hunks (files that were added or deleted count as one hunk each).
4. **Search:** delta debugging (ddmin) over hunks, applying subsets onto G in the worktree. Each probe runs the narrowed test. Results are cached by the resulting tree id, so repeated subsets cost nothing.
5. **Confirm:** reverting exactly the culprit set from B must pass, confirmed by a probe.
6. **Budget:** max 12 probes and 3 minutes (configurable); on exhaustion, `undetermined: interdependent changes` with the smallest set found so far, labelled as such.

**Result:** a `finding` record, delivered at the next injection point:

```
kerb: cause · "logout clears session" broke at attempt 4
      culprit: src/session.ts:88–95 (1 of 6 hunks) · confirmed by 7 probes
      next: revert just that hunk to restore green (kerb restore st_91c0 --keep-except f:3b2e --patch); your other edits are kept
```

Never applied automatically.

**Fix minimisation** uses the same machinery in the other direction: the smallest subset of the F→green diff that still turns the failing tests green. It runs only when the worker is idle.

### 8.3 Environment classifier

Runs on every failure before loop classification. Environment failures are recorded with `failure_kind: "environment"` and a subtype, never count toward loops, and carry a fix line.

| Subtype | Signatures (examples) | Fix line |
|---|---|---|
| `tls_interception` | `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `self signed certificate in certificate chain`, `unable to get local issuer certificate`, `CERTIFICATE_VERIFY_FAILED`, `PKIX path building failed`, `x509: certificate signed by unknown authority` | The per-tool setting below, pointing at the CA bundle from policy `tls.ca_bundle` (managed or org layer) |
| `proxy_page` | Community-sourced block-page signatures (HTML 403 bodies from corporate proxies), added only from real captures | "Blocked by the corporate proxy; tell the user which URL you need" |
| `auth_expired` | `401` with a token-expiry message, `gh auth` errors, cloud `ExpiredToken` | "Credentials expired; ask the user to re-authenticate" |

**Per-tool TLS fixes** (only when `tls.ca_bundle` is set):

| Tool | Setting |
|---|---|
| Node, npm, yarn, pnpm | `NODE_EXTRA_CA_CERTS=<bundle>`; for npm also `npm config set cafile <bundle>` |
| Bun | `NODE_USE_SYSTEM_CA=1` or Bun's own CA setting (**VERIFY**) |
| pip, requests | `PIP_CERT=<bundle>` / `REQUESTS_CA_BUNDLE=<bundle>` |
| curl, OpenSSL-based tools | `SSL_CERT_FILE=<bundle>` / `CURL_CA_BUNDLE=<bundle>` |
| git | `GIT_SSL_CAINFO=<bundle>` |
| AWS CLI | `AWS_CA_BUNDLE=<bundle>` |
| Go | `SSL_CERT_FILE=<bundle>` |
| Java, Gradle, Maven | Import into a truststore; tell the user (requires keytool and a password) |

- Without `tls.ca_bundle`: "TLS interception detected; the company CA isn't configured for this tool. Ask the user, or run `kerb doctor tls`."
- `kerb doctor tls` (human): finds candidate corporate root CAs in the OS trust store, exports a bundle to `~/.kerb/ca-bundle.pem` with the user's confirmation, and offers to set `tls.ca_bundle`. **VERIFY** each OS's export commands.
- **Never** suggest disabling verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`, `--insecure`, `-k`, `sslVerify=false`, `--trusted-host`). A test enforces this.

---

## 9. Delivery: what reaches the agent, when

**VERIFY** for each agent which hook events can add context for the model (for example an `additionalContext` field), the size limits, and the events for compaction and resume. Where an event can't inject, use the fallback.

| Moment | Content | Max size | Fallback |
|---|---|---|---|
| Session start (fresh) | briefing (v1), ledger if recent records exist, verification status | 400 tokens total | Instructions block regenerated with a "recent attempts" section |
| Session start after compaction or resume | ledger and verification status (always) | 300 tokens | Same |
| Before a command | refusal or cached answer (deny reason) | 3 lines + result line | `kerb run` output |
| After a command | delta, environment fix, fix hint, cause finding (if ready) | 10 lines | Appended to `kerb run` output |
| Stop | recap; verification warning or gate | 8 lines | `kerb recap` |

**Rules:**

- At most one injection per moment.
- Nothing is injected after a successful, uncut, non-check command (v1's zero-cost rule for small commands still holds).
- Every injected block starts with `kerb:` or `kerb ledger` so it's attributable.
- **Best-effort agents** get deltas, hints and environment fixes only through `kerb run` output, plus the ledger via the regenerated instructions block.

---

## 10. Adoption features

### 10.1 `kerb scan` (retroactive replay)

**Goal:** show each developer their own waste before they enable anything.

- **Transcript readers** per agent in `src/scan/<agent>.js`. **VERIFY** each agent's transcript location and format. Start with Claude Code, then Codex, Gemini CLI, Copilot CLI, Cursor, OpenCode.
- Reconstruct the timeline of shell commands with outputs, exit status where available, timestamps, the file-edit tool calls between them, and token usage per turn where the transcript records it.
- **Replay rules:**

  | Rule | Approximation used in replay |
  |---|---|
  | identical retry | Same check command failed, then ran again with no file-edit call and no setup command in between |
  | blocked-host retries | v1 denial signatures |
  | environment failures | 8.3 signatures |
  | hangs | Agent tool timeouts or interrupts |
  | noise | Output bytes beyond v1's budget |
  | polling | 3 or more runs of the same command within 5 minutes with nothing else in between |

- **Output:** "would have" counts, run time, output bytes, and **measured tokens** when the transcript has usage (the tokens of turns that would have been avoided or shortened), each labelled "replayed".

  ```
  kerb scan · 30 days · 41 Claude Code sessions in this repo (replayed)
    142 test re-runs with nothing changed       3h 10m of run time
     37 retries against blocked hosts
     19 certificate errors (corporate TLS)       no CA bundle configured
    2.4 GB of output beyond Kerb's budget        ≈ 610k tokens (measured from transcripts)
     11 commands that hung until the agent's timeout
  ```

- `kerb init` offers to run the scan first. `kerb scan --json` and `kerb card --scan` exist. The scan reads local files only; nothing leaves the machine.

### 10.2 Shadow mode

- After `kerb init`, mode is `shadow` for 7 days (managed config can set `enforce` immediately).
- **In shadow,** hooks never deny. Instead they record `would_refuse` events and inject nothing. The recap shows `would have stopped 4 re-runs and 1 blocked retry`.
- Insight injections (deltas, ledger, hints) are on in shadow mode, because they don't block anything. They can be turned off with `kerb config set insights off`.
- On day 7 (or after 20 would-refuse events), the recap asks the human to review (`kerb review-shadow` lists each would-refuse with its evidence) and enable `kerb enforce` (human-only).
- `kerb mode` shows the current mode.

### 10.3 Progressive CLI

- `kerb --help` shows six commands: `init`, `scan`, `status`, `report`, `enforce`, `doctor`.
- `kerb help all` shows the rest, grouped: Look around, Insight, Platform, Platform teams, Human-only.

### 10.4 Skills pack and distribution

Skills in `skills/`, each starting with frontmatter on line 1:

- **`kerb`** (v1 skill, updated): reading refusals, cached answers, deltas, ledger and hints.
- **`kerb-diagnose`**: a disciplined debugging loop using Kerb's records. Read `kerb progress` and `kerb ledger` first; reproduce with the narrowest test (`kerb why` shows it); one hypothesis per attempt; check `kerb cause` before editing again; stop and summarise on `stalled` or `oscillating`.
- **`kerb-before-done`**: before claiming completion, check `kerb status` verification for every key touched; never claim "tests pass" unless the status is green on the current state.

**Distribution** (**VERIFY** packaging formats): a Claude Code plugin in the official marketplace if accepted, otherwise a self-hosted marketplace; an `npx skills` compatible layout; the MCP registry; awesome lists. A short guide pairing `kerb-diagnose` with popular debugging skills (Matt Pocock's `diagnosing-bugs` style loops) shows how they compose.

---

## 11. Platform

### 11.1 `kerb query`

Read-only, JSON by default:

```
kerb query runs [--key K] [--since 2h] [--state st_…] [--status failure]
kerb query tests [--status failing|flaky] [--test T]
kerb query verification
kerb query progress
kerb query fixes [--fingerprint F | --test T]
kerb query findings [--test T]
kerb query states [--key K] [--green]
```

### 11.2 MCP server

- `kerb mcp` is a minimal MCP server over stdio (JSON-RPC 2.0, no dependencies). **VERIFY** the current protocol version and the required methods (`initialize`, `tools/list`, `tools/call`).
- **Tools, all read-only:** `verification_status`, `progress`, `attempts(key?)`, `test_history(test_id)`, `known_fixes(fingerprint|test_id)`, `last_green(key|test_id)`, `cause(test_id)`, `boundaries()`, `explain(run_id)`.
- Each tool returns at most 2 KB of text, with pointers (run ids) for more.
- `kerb init` registers the server for agents that support MCP, alongside hooks. MCP is a *pull* channel; hooks remain the *push* channel and the enforcement.

### 11.3 Plugins

- **Plugins** are ES modules listed in policy (`plugins: [{ "path": "...", "sha256": "..." }]`) or managed config. A repo-listed plugin runs only after a human approves its hash (`kerb plugins approve`). Unlisted or changed plugins never load.
- **API:** `export default { name, events: { "run.end"(ctx, run) {…}, "refusal"(…), "finding"(…), "session.start"(…) } }`. Handlers may return `{ note: "text" }` (advisory, shown with the plugin's name) and nothing else. Deny contributions are not part of v2.
- Each handler has a 50 ms budget; on timeout or error it's skipped and counted.
- Plugins get a read-only query object (`ctx.query`), never write access to the event log.

### 11.4 Export

`kerb export --format ker --since 7d` writes NDJSON per the schema, redacted, for memory tools, dashboards and research. `--no-text` removes all messages and paths, leaving ids, counts and hashes.

---

## 11a. Configuration additions

| Key | Default | Layer |
|---|---|---|
| `mode` | `shadow` for 7 days, then prompt | user, managed |
| `insights` | `on` | user |
| `stop_gate` | `warn` | policy |
| `hermetic_commands` | `[]` (static checks built in) | policy |
| `cache_ttl` | `24h` | policy |
| `verify_keys` | `[]` | policy |
| `worker` | `on` | user, managed |
| `cause` | `off` until a human enables it | user, managed |
| `worker_budget_cpu_min_per_hour` | `15` | user, managed |
| `worktree_links` | `node_modules`, `.venv`, `vendor`, `target` | policy |
| `share_fixes` | `false` | user (human-only), managed |
| `tls.ca_bundle` | unset | managed, org, user |
| `plugins` | `[]` | policy, managed |

---

## 12. Performance budgets

| Path | Budget (warm, 5,000-file repo) | On breach |
|---|---|---|
| PreToolUse, non-check command | 60 ms p95 | Fail open |
| PreToolUse, check command (state id + rules + cache lookup) | 120 ms p95 | Skip loop checks, record skip |
| PostToolUse (record, state, classify, delta) | 150 ms p95, plus reporter parsing up to 100 ms per MB of output | Record without test-level results |
| Snapshot on a 100,000-file repo with fsmonitor | 300 ms | Skip state for this run |
| `kerb status` / status line | 50 ms | Show the last cached line |
| MCP tool call | 200 ms | Return partial with a pointer |
| Worker | 15 CPU-minutes per hour | Queue waits |

If measured p95 for the hook path exceeds these on the benchmark machines, the v1 decision applies: port `hook` and `check` to Go or Rust behind the same contract.

---

## 13. Build plan

Each milestone is a release. Ship early; adoption features come first.

### Milestone A · v0.2 "Try it safely" (adoption first)

- [x] **A1** Shadow mode, `would_refuse` events, `kerb review-shadow`, `kerb enforce`, `kerb mode`. *Tests: SH1–SH8.*
- [x] **A2** `kerb scan` for Claude Code (VERIFY transcripts), then Codex and Gemini CLI. *Tests: SC1–SC10.*
- [x] **A3** Environment classifier, TLS fixes, `kerb doctor tls`. *Tests: EN1–EN9.*
- [x] **A4** Progressive CLI help. *Tests: CL1–CL2.*
- [ ] **A5** README rewrite around one headline per audience; scan output as the hero image.

### Milestone B · v0.3 "Truth"

- [ ] **B1** State model: git-tree snapshots, walk-mode blob store, refs, retention, `kerb gc`, materialization. v1 W tests must pass unchanged. *Tests: ST1–ST14.*
- [ ] **B2** Event log extensions and KER schemas; indexes and `kerb reindex`. *Tests: EV1–EV8.*
- [ ] **B3** Reporter parsers (Vitest, Jest, pytest, go test, cargo, Node, tsc, ESLint, Ruff, mypy, Clippy, JUnit XML), with recorded real outputs as fixtures. *Tests: RP1–RP14.*

### Milestone C · v0.4 "Insight"

- [ ] **C1** Delta and flaky detection. *Tests: DL1–DL9.*
- [ ] **C2** Verification status and stop gate. *Tests: VS1–VS8.*
- [ ] **C3** Convergence, oscillation guard, `kerb progress`. *Tests: CV1–CV9.*
- [ ] **C4** Attempt ledger and injection at session start, compaction and resume (VERIFY events). *Tests: LG1–LG7.*
- [ ] **C5** Delivery layer per section 9 for every enforced agent. *Tests: DV1–DV8.*

### Milestone D · v0.5 "Instant answers and last green"

- [ ] **D1** Instant answers for hermetic commands. *Tests: IA1–IA10.*
- [ ] **D2** `kerb green` and `kerb restore` (patch, keep-except, in-place human-only). *Tests: GR1–GR8.*

### Milestone E · v0.6 "Cause and proof"

- [ ] **E1** Worker lifecycle, queue, budgets, worktrees. *Tests: WK1–WK10.*
- [ ] **E2** Narrowing per framework. *Tests: NR1–NR7.*
- [ ] **E3** Cause isolation with reproduction and confirmation. *Tests: CA1–CA12.*
- [ ] **E4** Proven fixes, family fingerprints, minimisation, hints. *Tests: FX1–FX10.*
- [ ] **E5** Notes sharing and `kerb sync`. *Tests: NS1–NS7.*

### Milestone F · v0.7 "Platform"

- [ ] **F1** `kerb query` and `kerb export`. *Tests: QY1–QY6.*
- [ ] **F2** MCP server. *Tests: MC1–MC8.*
- [ ] **F3** Plugins with hash approval. *Tests: PL1–PL8.*
- [ ] **F4** Skills pack and marketplace packaging (VERIFY formats). *Tests: SK1–SK4.*

### Milestone G · v1.0 "Proof"

- [ ] **G1** Benchmark v2 (section 15), published with raw data.
- [ ] **G2** Five design users in shadow then enforce mode; their scan and report numbers (with permission).
- [ ] **G3** Dogfood on a large monorepo with cause isolation on; every wrong finding becomes a regression test.
- [ ] **G4** Launch.

---

## 14. Acceptance tests (v2)

Conventions from v1 apply: `node:test`, injectable clock, side-effect files to prove a command didn't run, recorded real fixtures for parsers, transcripts and hook payloads.

**SH · Shadow mode**
- SH1 `init` sets shadow with an expiry 7 days out (injected clock). SH2 In shadow, a blocked host is not denied; a `would_refuse` event is recorded. SH3 Recap shows would-have counts. SH4 Insights still inject in shadow. SH5 `enforce` is human-only. SH6 After expiry, the recap prompts once; mode stays shadow until a human acts. SH7 Managed `mode: enforce` skips shadow. SH8 `review-shadow` lists each event with evidence.

**SC · Scan**
- SC1 Claude Code transcript fixture → correct command timeline. SC2 Identical retry detected only with no edit or setup call between. SC3 An edit call in between → not counted. SC4 Blocked-host retries counted from signatures. SC5 TLS failures counted. SC6 Hangs from timeouts or interrupts. SC7 Measured tokens only when usage is present; otherwise bytes only. SC8 Everything labelled "replayed". SC9 Unknown transcript format → skipped with a note, no crash. SC10 Nothing written outside `.kerb/` and nothing sent over the network.

**EN · Environment**
- EN1 Each TLS signature → `environment/tls_interception`. EN2 Never counted for loops. EN3 With `tls.ca_bundle`, the fix line names the correct setting per tool. EN4 Without it, the generic line. EN5 No message anywhere suggests disabling verification (scan all templates and outputs). EN6 Proxy page signatures only from the fixture set. EN7 `auth_expired` classified. EN8 `doctor tls` asks before writing. EN9 Bun case follows the VERIFY decision.

**CL** · CL1 `--help` lists exactly six commands. CL2 `help all` lists every command.

**ST · State model**
- ST1 Same content → same state id across runs and machines (fixture repo). ST2 v1 W1–W16 pass with state ids. ST3 Untracked non-ignored files are in the snapshot; ignored are not. ST4 The snapshot doesn't modify the real index (byte-compare `.git/index`). ST5 Concurrent snapshots don't collide (separate temp indexes). ST6 Refs created under `refs/kerb/states/`. ST7 Retention keeps the right states; `kerb gc` removes others. ST8 A worktree at a state reproduces the files exactly. ST9 A patch from current to state applies cleanly and yields the state. ST10 Over-5 MB files → `materializable: false`. ST11 Walk mode stores and restores blobs. ST12 `doctor` warns about mirror pushes. ST13 Snapshot over budget → `state: null`, loop checks skipped. ST14 Default `git push` never sends `refs/kerb/*` (integration test with a bare remote).

**EV · Events and indexes**
- EV1 New record types validate against the schemas. EV2 Unknown fields are tolerated by readers. EV3 Indexes rebuild identically from the log. EV4 A corrupt index is rebuilt automatically. EV5 Hooks work without indexes within budget. EV6 Concurrency: 20 parallel runs keep indexes consistent. EV7 `reindex` is idempotent. EV8 Schemas published in docs match the code.

**RP · Reporters** (each against recorded real output)
- RP1–RP11 One per framework or tool in 5.4: correct test ids, statuses, locations and messages. RP12 Unrecognised output → `null`, run still recorded. RP13 Messages redacted and truncated. RP14 A 50 MB output parses within budget or falls back.

**DL · Delta**
- DL1 Fixed, still failing and new are correct across two runs. DL2 Intersection when test sets differ. DL3 Flaky detection on the same state. DL4 Flaky tests excluded from breaker fingerprints. DL5 At most 8 lines, then the "more" line. DL6 First run → summary. DL7 Monochrome (no ANSI) in injections. DL8 Diagnostics (tsc, ESLint) produce deltas. DL9 No delta after a successful non-check command.

**VS · Verification**
- VS1 Green, red, stale and never states correct. VS2 Stale lists changed files. VS3 Status line text. VS4 Stop gate `warn` adds to the recap. VS5 `block` blocks once, then yields. VS6 `off` does nothing. VS7 MCP `verification_status` matches the CLI. VS8 Uses `verify_keys` from policy.

**CV · Convergence**
- CV1 Converging, stalled, oscillating, diverging and green detected on fixture series. CV2 An oscillation refusal fires on a 2-state cycle. CV3 And on a 3- and 4-state cycle. CV4 No oscillation refusal when a run in the cycle is transient or environment. CV5 Rule order as in 6.1. CV6 `kerb progress` text and JSON. CV7 Status line series. CV8 Oscillation message names the cycling files. CV9 Shadow mode records it as would-refuse.

**LG · Ledger**
- LG1 At most 250 tokens. LG2 Content is derived only from records (no network, no model). LG3 Injected after compaction or resume (recorded payload fixtures). LG4 Not injected on a fresh session without recent records. LG5 Includes last green and verification status. LG6 Includes a known-fix pointer when one matches. LG7 Best-effort agents get it through the instructions block.

**DV · Delivery**
- DV1 One injection per moment. DV2 Size limits respected. DV3 Nothing after small successful commands. DV4 Every block starts with `kerb`. DV5 Fallbacks used when an event can't inject (per VERIFY). DV6 Injections are deterministic for the same records. DV7 Injection failures fail open. DV8 Recorded payload fixtures per enforced agent.

**IA · Instant answers**
- IA1 Static check on an unchanged state → cached answer, command not executed. IA2 Changed state → runs. IA3 Changed env stamp → runs. IA4 Non-hermetic test command → v1 identical_retry behaviour. IA5 Opt-in `hermetic_commands` → cached. IA6 Transient, dependency or environment failures never cached. IA7 Commands with network hosts never cached. IA8 Older than `cache_ttl` → runs. IA9 Cached success message. IA10 `cached_answer` event recorded and counted in the report.

**GR · Last green and restore**
- GR1 `green` finds the newest passing state for a key. GR2 And for a single test. GR3 `restore --patch` produces a correct patch and changes nothing. GR4 `--keep-except` reverts only culprit hunks. GR5 `--in-place` is human-only. GR6 In-place stashes first. GR7 Non-materializable states are refused with a reason. GR8 Scope is respected.

**WK · Worker**
- WK1 Spawned on demand; one per repo. WK2 Idle exit. WK3 Budgets enforced. WK4 Runs niced. WK5 Never modifies the working tree (byte-compare before and after a job). WK6 Worktrees removed after jobs. WK7 Crash recovery: running jobs become failed on restart. WK8 Disabled in CI by default. WK9 `worker stop` stops it. WK10 Jobs survive a Kerb upgrade (schema version on job files).

**NR · Narrowing**
- NR1–NR6 One per framework: the narrowed command runs exactly the target test (fixture projects). NR7 No narrowing possible → original command with reduced budget.

**CA · Cause isolation** (seeded-bug fixture repos)
- CA1 Finds a single culprit hunk among 6. CA2 Finds a pair of interdependent hunks. CA3 Not reproducible → undetermined. CA4 Flaky test → not triggered. CA5 Dependencies changed → undetermined. CA6 Budget exhausted → undetermined with the partial set labelled. CA7 Confirmation probe required. CA8 Probe results cached by tree id. CA9 Finding delivered at the next injection point. CA10 Never applied automatically. CA11 Off for tests until a human enables it; the recap mentions availability once. CA12 Added and deleted files handled as single hunks.

**FX · Proven fixes**
- FX1 Red→green records a fix with tests changed. FX2 Exact match hint on a recurrence. FX3 Family-only match labelled "not the same error". FX4 At most one hint per failure. FX5 Minimisation reduces hunks and re-verifies. FX6 Confidence labels. FX7 Commit sha attached once committed. FX8 No hint when the fix's tests no longer exist. FX9 Hints are text only, never applied. FX10 Fix records contain no output beyond redacted first lines.

**NS · Notes sharing**
- NS1 Off by default; nothing is written to notes. NS2 Enabling is human-only. NS3 Only committed fixes produce notes. NS4 Notes contain only fingerprint, family, test ids and version. NS5 `sync` merges remote notes into the fix index. NS6 `sync --push` is human-only. NS7 Uncommitted states and findings are never shared.

**QY · Query and export**
- QY1–QY4 Each query returns schema-valid JSON for fixture logs. QY5 `export` is redacted. QY6 `--no-text` removes all text and paths.

**MC · MCP**
- MC1 Handshake per the VERIFY'd protocol version. MC2 `tools/list` lists exactly the read-only tools. MC3 Each tool returns at most 2 KB. MC4 Tools match CLI results. MC5 No write capability exists. MC6 Errors return structured MCP errors. MC7 Within 200 ms on fixtures. MC8 `init` registers the server where supported.

**PL · Plugins**
- PL1 Unlisted plugins never load. PL2 Hash mismatch → not loaded, warning. PL3 Repo plugins need human approval. PL4 Notes appear with the plugin name. PL5 Handlers can't deny. PL6 50 ms timeout skips the handler. PL7 Errors are counted, not raised. PL8 `ctx.query` is read-only.

**SK · Skills**
- SK1 Each skill has valid frontmatter on line 1. SK2 Every command a skill mentions exists. SK3 `kerb-before-done` never instructs claiming success without green status. SK4 Packaging validates against the VERIFY'd marketplace format.

---

## 15. Benchmark v2 and launch gate

**Arms:**
1. Plain agent.
2. Agent with a skill-only version of Kerb's rules (no hooks).
3. Kerb v1.
4. Kerb v2.

**Tasks:** 30 or more realistic tasks across Node, Python and Go repos, including:
- seeded regressions that require credit assignment;
- tasks long enough to trigger compaction;
- flaky tests;
- a locked-down network with TLS interception (a local intercepting proxy with its own CA);
- slow suites;
- one 100,000-file monorepo.

**Metrics per run:** success rate; attempts to green; tokens to green (from transcripts); time to green; refusals and cached answers, each judged correct or not; cause findings, judged against the seeded ground truth (precision and recall); hook latency p50 and p95.

**Launch gate for 1.0:**
- Success rate of arm 4 is no lower than arm 1 (within 1 point).
- Arm 4 beats arm 2 on tokens to green **or** time to green, with a confidence interval that excludes zero.
- Zero incorrect refusals or cached answers.
- Cause findings: precision of at least 95% among confirmed findings.
- Hook latency within section 12 budgets.

Publish the harness, tasks and raw results in `bench/`. If arm 2 matches arm 4, say so publicly and simplify.

---

## 16. Decisions log (v2)

- 2026-10-01 · 4 · State identity moves to git tree snapshots via a temporary index, kept alive by local refs under `refs/kerb/states/`. Reason: same identity as v1's hash, plus restorable states for last green and cause isolation, with git's own deduplication.
- 2026-10-01 · 6.3 · Identical retries of hermetic commands return the cached result instead of a refusal. Reason: a refusal costs a turn and frustrates; an answer gives the agent what it wanted.
- 2026-10-01 · 7.6–7.7 · Fixes are local by default; sharing is human-enabled, uses git notes on commits, and contains only fingerprints and test ids. Reason: DLP and secrets risk in uncommitted code; committed code already travels with the repo.
- 2026-10-01 · 8.2 · Cause isolation for tests is off until a human enables it. Reason: it runs tests in the background, which can have side effects and costs CPU.
- 2026-10-01 · 8.3 · TLS fixes only point at a configured company CA bundle; Kerb never suggests disabling verification. Reason: correctness and security; hardcoded bundle paths are wrong in most enterprises.
- 2026-10-01 · 10.2 · Shadow mode by default for 7 days. Reason: trust before enforcement is the main adoption barrier for a tool that refuses commands.
- 2026-10-01 · 11.2 · MCP is a read-only pull channel; hooks remain the push and enforcement channel. Reason: agents in debugging spirals don't choose to call tools.
- 2026-10-01 · 15 · The benchmark includes a skill-only arm. Reason: if a skill gets the same results, Kerb should be simpler.
- 2026-10-01 · 10.2 · Mode is per repo, in `.kerb/mode.json`, written by `kerb init` (shadow, 7 days) and by `kerb enforce` (human-only). Effective mode, first match wins: managed config (`mode` or `defaults.mode`), the repo file, the user config `mode`, then `enforce`. A repo where init never ran stays in enforce, so v1 behaviour and v1 installs don't change on upgrade; init doesn't start shadow when the user config already says `enforce`. Re-running init never resets the shadow clock.
- 2026-10-01 · 10.2 · Shadow covers every path that could refuse: hooks, `kerb run` and `kerb wait-for` record `would_refuse` (same fields as `refusal`) and run the command with no extra output. `kerb check` never runs anything, so in shadow it exits 0 and says what enforce mode would refuse. Human-only refusals become would-refusals too; the human-only commands themselves still need the typed code, so nothing is unlocked.
- 2026-10-01 · 10.2 · The end-of-shadow prompt goes out from the Stop hook once (recorded as `prompted_at` in the mode file), and only counts as shown when the agent can display Stop output (not Cursor or OpenCode). `kerb mode` always shows it while it applies. Counts since shadow started come from the summary's day buckets.
- 2026-10-01 · 10.2 · `kerb review-shadow` also shows what happened when each command ran anyway: for a loop would-refusal, whether the next run of the key failed the same way, or passed (labelled "this refusal would have been wrong"). Reason: that is the evidence a human needs before `kerb enforce`.
- 2026-10-01 · 11a · `insights off` drops `fixes` hints from hook context and `kerb run` output; v1 notes about walls (suspected and newly learned hosts) stay, since they are about boundaries, not insight.
- 2026-10-01 · 15 · The benchmark's Kerb arm seeds the user config with `mode: enforce`, so it measures enforcement, not shadow.
- 2026-10-01 · 13 · A3 was built before A2, because `kerb scan` counts environment failures with A3's signatures.
- 2026-10-01 · 8.3 · The classifier runs inside the existing output analyzer, on every line up to 4 KB, and wins over the transient and dependency kinds (a Kerb timeout stays transient). Environment runs are neither failures nor successes for the loop rules, like policy denials: they never trigger a refusal and they break a breaker streak. Records carry `env_subtype`. The fix block is two lines (`kerb: environment · …` and `next: …`), after the footer in `kerb run` and in the post hook's context; `insights off` drops it.
- 2026-10-01 · 8.3 · `tls.ca_bundle` is read from the managed config (`tls.ca_bundle` or `defaults["tls.ca_bundle"]`), then the org bundle's policy (`tls.ca_bundle`), then the user config; `tls` in `kerb.policy.json` is ignored with a lint warning, since a repo could point tools at a hostile CA. Policy `environment_fixes: {subtype: text}` names a sanctioned fix (6.2), merged like alternatives (highest layer wins, shown with its source, repo entries dropped under `lock_repo_alternatives`); for TLS, a configured CA bundle's per-tool setting takes precedence.
- 2026-10-01 · 8.3 · VERIFY Bun (https://bun.com/docs/runtime/bunfig, https://bun.com/docs/runtime/environment-variables): bunfig `[install] cafile` is documented, so `bun install|add|update|…` get that fix. Bun's env-var docs don't list `NODE_EXTRA_CA_CERTS` or `NODE_USE_SYSTEM_CA`; Bun's Node compatibility reads `NODE_EXTRA_CA_CERTS`, so other `bun` commands get that setting. uv gets `SSL_CERT_FILE` (https://docs.astral.sh/uv/concepts/authentication/certificates/).
- 2026-10-01 · 8.3 · Proxy block pages: the only signature shipped is Squid's stock `ERR_ACCESS_DENIED` text, from its source template (`errors/templates/ERR_ACCESS_DENIED`); vendor pages (Zscaler, Palo Alto, Fortinet, Netskope) wait for real captures through the "new signature" issue template. The TLS fixtures are each tool's documented error text, written by hand, not captured from a live proxy; to be replaced by captures during dogfooding.
- 2026-10-01 · 8.3 · `kerb doctor tls`: candidates are CA certificates in the OS trust store, still valid, that are not among the public roots Node ships (`tls.rootCertificates`). Sources (VERIFY): macOS `security find-certificate -a -p` on `/Library/Keychains/System.keychain` and the login keychain; Linux the local-anchor directories (`/usr/local/share/ca-certificates`, `/etc/pki/ca-trust/source/anchors`, `/etc/ca-certificates/trust-source/anchors`, `/usr/share/pki/trust/anchors`, `/etc/pki/trust/anchors`); Windows `Cert:\LocalMachine\Root` and `Cert:\CurrentUser\Root` through PowerShell. The written bundle holds the public roots plus the company CAs, because `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `AWS_CA_BUNDLE` and similar replace the default store rather than add to it. Writing needs the typed human code; `--dry-run` only lists. It reads `tls.rootCertificates` from `node:tls` and opens no connection (Z3 checks this).
- 2026-10-01 · 10.1 · VERIFY Claude Code transcripts: `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd with every non-alphanumeric character replaced by "-">/<session>.jsonl` (config dir: https://code.claude.com/docs/en/settings), plus `<session>/subagents/agent-*.jsonl`. Record shapes checked against real local transcripts (structure only): `assistant.message.content[].tool_use {id, name, input}` with `message.usage` repeated on each content-block record of one message id; `user.message.content[].tool_result {tool_use_id, content, is_error}` and `toolUseResult {stdout, stderr, interrupted}` (or an `Error: Exit code N…` string). Kerb matches project directories by prefix and then requires the recorded `cwd` to be inside the repo.
- 2026-10-01 · 10.1 · VERIFY Codex (codex-rs/protocol/src/models.rs, codex-rs/rollout/src/policy.rs on GitHub): `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, lines `{timestamp, type, payload}`; shell calls are `function_call` (`shell`, `shell_command`, `exec_command`) or `local_shell_call`; edits are `apply_patch`; usage is `event_msg` `token_count.info.last_token_usage`. Shell output differs across versions (a JSON string with `metadata.exit_code`, or text with `Exit code:`/`Process exited with code`, `Wall time:` and `Output:`); the reader takes either. `.jsonl.zst` rollouts are read only on a Node with `zlib.zstdDecompressSync` (22.15+), else skipped with a note. The fixture is built from these shapes, not captured.
- 2026-10-01 · 10.1 · VERIFY Gemini CLI (chatRecordingService.ts, chatRecordingTypes.ts, storage.ts, projectRegistry.ts on GitHub; https://geminicli.com/docs/cli/session-management/): `~/.gemini/tmp/<project id>/chats/session-*.jsonl` (append-only: metadata, messages, `$set`, `$rewindTo`) and legacy `session-*.json`. The project id is now a registry slug with a `.project_root` file holding the path; older directories were `sha256(project root)`. Kerb accepts either. Shell calls are `run_shell_command` with `Exit Code: N` in the output. The fixture is built from these shapes, not captured.
- 2026-10-01 · 10.1 · Measured tokens: an agent re-sends its context on every model call, so a tool result's tokens are the next call's input minus this call's input and carried-over output (Codex: output minus reasoning), split by size among the results between the two calls. Negative or missing growth (compaction, no usage) gives no number. The scan labels these "measured from transcripts", and shows bytes only when the transcripts have no usage. The growth also includes anything else added between the two calls, so it can overstate a result's own size.
- 2026-10-01 · 10.1 · Replay rules as implemented: identical retries apply v1's kinds (ordinary always; transient from the second identical retry; dependency within the 60 s cooldown; environment never) with "no edit tool call and no other check/other/background command in between"; a command whose output already holds a Kerb refusal is skipped, and `kerb run|wait-for -- <inner>` is judged as `<inner>`. Blocked hosts: a host confirmed by a strong denial (or two weak hits from different commands) counts every later command that contacts it, across sessions; commands today's org or repo boundaries block are a separate row. Polling: three or more runs of one command, nothing else between, each within 5 minutes; attempts already counted as identical retries are not counted again. Hangs include user interrupts. Policy is today's org and repo layers; the learned layer is not used, since it may have been learned from these same sessions.
- 2026-10-01 · 10.1 · `kerb init` offers the scan as its last line rather than running it, so init stays fast and non-interactive. `kerb card --scan [--since 30d]` writes the card from replayed numbers, never with a dollar figure.
- 2026-10-01 · 10.3 · `kerb help all` repeats the six start commands, then the spec's groups. `run`, `wait-for`, `check` and `hook` go under "Platform (what agents and hooks call)", since they are the interface agents use; `enforce` appears both in the six and under Human-only. Groups list only commands that exist; Insight grows with milestones C–E.
