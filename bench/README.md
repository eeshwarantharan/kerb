# Kerb benchmark (v2)

The benchmark behind the 1.0 launch gate ([KERB-V2](../docs/KERB-V2.md) section 15). Everything that doesn't need an agent has been run, and its raw results are in [`results/`](results/). The agent runs haven't been run yet: they need an agent subscription, its API spend, and a reviewer, and no savings figure may be claimed until they have been run and reviewed.

| Part | Script | Needs an agent | Status |
|---|---|---|---|
| Tasks: 35 across Node, Python and Go, each with a check and a reference solution | `tasks.js`, `sandbox.js` | no | every task without an outside service is validated (see below) |
| Cause isolation: precision and recall on seeded regressions | `cause.js` | no | **run**: [`results/cause/`](results/cause/) |
| Hook latency against the section 12 budgets | `hook-latency.js` | no | **run**: `results/hook-latency-*.json` |
| Four arms × tasks × runs | `run.js` | yes | harness ready, **not run** |
| Refusals and cached answers, judged by replay | `judge.js` | (runs on the arm results) | ready |
| Analysis and the launch gate | `analyze.js` | (runs on the arm results) | ready |

## Tasks

`tasks.js` holds 35 tasks in eleven categories: blocked registries and hosts with a sanctioned alternative (`wall`), fix-the-test loops, flaky services (`transient`), a database that starts late (`dependency`), noisy output, hanging commands, seeded regressions that need credit assignment (`regression`, with the culprit lines as ground truth), a 20-function task long enough to compact, a TLS-inspecting proxy (`environment`), slow suites, static checks, and a 100,000-file monorepo. Each has a prompt, the check command an agent would run (for attempts and tokens to green), a success check, and a reference solution.

The tests (`test/bench.test.js`) prove each quick task is sound: its check fails as given and passes after the reference solution, and for seeded regressions the starting point passes and the culprit lines are lines the edits changed. The slow tasks (two slow suites and the monorepo) and the Go tasks were validated the same way by hand. Three tasks need outside services and have no automatic solution: the npm and PyPI mirrors, and the late database.

Disk use: every sandbox and temp HOME is deleted when its run is judged, and on exit or Ctrl-C; `--keep` keeps them (their paths are then in `rows.jsonl`). The two large tasks (`monorepo-package-test`, `seeded-regression-monorepo`) write 100,000 files, about 1 GB each, and run only with `--large`. Any run stops cleanly when less than 1 GB is free (3 GB for a large task).

Validating found one broken task carried over from v1: `fix-test-min` passed before any fix (the stub returned the input's first element, which was its minimum). Fixed.

## Cause isolation (no agent)

```bash
node bench/cause.js --generated 60 --seed 1
```

Each scenario starts green, gets several edits of which some are known culprits, runs the check once more (red), and lets Kerb's worker isolate the cause, with `cause` on. Scenarios: the four seeded regression tasks (Node, pytest, Go) and generated Node and pytest repos (one culprit among 2–5 harmless edits; two culprits breaking two tests; flaky controls where no edit is to blame). A confirmed finding is **correct** when every hunk it blames contains a culprit line and every culprit line of its test is blamed; **exact** when it blames nothing but culprit lines. In a control, any confirmed finding is a false positive. The gate is precision ≥ 95% among confirmed findings.

Results are in `results/cause/summary.json` (and every scenario in `rows.jsonl`). Running it found three problems in Kerb, each now fixed with a regression test (see the decisions log in KERB-V2, 2026-10-02 and 03):

- Isolation never started for runners that name only failing tests (`pytest -q`; Jest and Vitest by default), because no record showed the test passing before.
- `pytest -q` output wasn't recognised at all.
- A single confirmation probe let a 50% flaky test blame an innocent hunk; and a Go build failure (an unused import with only some hunks applied) counted as the test failing.

Known limit: git merges edits less than seven lines apart into one hunk, and Kerb blames whole hunks, so a culprit next to a harmless edit takes the harmless edit with it. The seeded tasks keep their edits apart; real work won't always.

## Rewordings (no agent)

```bash
node bench/rewordings.js
```

Agents rarely repeat a command word for word: they add `2>&1 | tail -50`, `; echo $?` or `|| true`, switch to `npm run test`, or prefix `cd app &&`. This offers 26 such rewordings of a failing check (nothing changed since) and 29 ways of reaching a blocked registry to Claude Code's pre-tool hook and counts what Kerb refuses. Results: [`results/rewordings.json`](results/rewordings.json).

| | Before (0.7.0) | Now |
|---|---|---|
| Rewordings of a failing check refused | 2 of 26 | 22 of 26 |
| Ways to a blocked host refused | 25 of 29 | 27 of 29 |

The misses left are deliberate, because they can change the result: `npm test` and `node --test` (a package script can run anything), `pytest` and `python -m pytest` (the second puts the current directory on the import path), and `npx` (Kerb can't tell whether the package is installed, and refusing `npx jest` would be a false refusal). A URL in a shell variable (`U=…; curl $U`) gets through once; the denial teaches Kerb the wall.

Running this also found a worse problem: `npm test | tail` exits 0 when the tests fail, and Kerb recorded it as a pass, so `kerb status`, the MCP `verification` answer and the stop gate could say green. Fixed: see the decisions log (2026-10-04).

## Hook latency (no agent)

```bash
node bench/hook-latency.js --runs 60                                   # npm install (Node + script)
KERB_BENCH_BIN=dist/kerb-darwin-arm64 node bench/hook-latency.js       # the standalone binary
```

Warm p50/p95 end to end, process start included, on a 5,000-file git repo, for `kerb hook claude pre` (an ordinary command, a check, a check after a failure, a blocked command), `post` after a check with 50 test results, and `kerb statusline`, each against its section 12 budget. The result file records the machine's load average.

## Agent runs (not run yet)

Four arms, the same agent and model on every task, several runs each:

1. `plain`: the agent as it is.
2. `skill`: Kerb's rules as a skill and instructions only ([`arms/skill-only.md`](arms/skill-only.md)), no hooks and no records.
3. `v1`: Kerb v1 (tag `v0.1.0`), hooks installed by its `kerb init`, enforce mode.
4. `v2`: this Kerb, enforce mode, cause isolation on.

```bash
node bench/setup-v1.js                                        # a v0.1.0 worktree for arm 3
node bench/proxy.js --intercept '*.corp.test' &               # egress allowlist, 403 "blocked by policy", TLS inspection
npx verdaccio &                                               # an npm mirror on localhost:4873
node bench/run.js --proxy http://127.0.0.1:8899 --ca bench/results/tmp/ca/ca.pem \
  --kerb-v1 bench/results/tmp/kerb-v1 --runs 3 \
  --agent-cmd "claude -p {prompt} --output-format json --max-turns 40"
node bench/analyze.js bench/results/tasks/rows.jsonl \
  --cause bench/results/cause/summary.json --latency bench/results/hook-latency-darwin-arm64-npm.json
```

Per run, `rows.jsonl` records success, turns, tokens and cost from the agent's JSON, and from its Claude Code transcript the attempts, tokens and time to green (the first run of the task's check that passed, or a cached answer that says it passed). For the Kerb arms it records every refusal and cached answer, judged by `judge.js`: a refusal that says "running this again can't change the result" is replayed twice in a worktree at the state it was about, and is correct when both replays give the recorded exit code; replays that disagree, and `breaker_open`, are left for a person to review. Policy and human-only refusals follow the repo's policy. For v2, cause findings on the seeded tasks are judged against the ground truth.

`analyze.js` writes the launch gate: v2's success rate no lower than plain's (within 1 point); v2 beats the skill-only arm on tokens or time to green with a paired bootstrap 95% CI that excludes zero; zero incorrect refusals or cached answers (and none left unreviewed); cause precision ≥ 95%; hook latency within budget. If the skill-only arm matches v2, the spec says to say so publicly and simplify.

Cost, roughly: 35 tasks × 4 arms × 3 runs = 420 agent sessions, several hours of wall time and a real API bill. Running fewer runs or arms first is fine; the summary says what was run.
