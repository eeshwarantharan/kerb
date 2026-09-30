# Dogfood log (build step 7.3)

Every refusal and every hash-budget skip seen while using Kerb for real, with a verdict. Any false refusal becomes a bug with a regression test.

## Session 1 · 2026-10-01 · Kerb's own repo · best effort

The agent building Kerb (Claude Code in VS Code) ran its own shell commands through `kerb run --` in this repository for the last part of the build: git commits, focused test runs, the shuffled suite. Tier: best effort (no hooks), so Kerb saw only the commands passed through `kerb run`.

| # | What happened | Verdict | Follow-up |
|---|---|---|---|
| 1 | `node --test …` ran as class `other`, so the Loopbreaker ignored it. Node's built-in test runner isn't in the default check list. | Missed save (never a false refusal) | Added `node --test` to the default check commands; this repo's `kerb.policy.json` also lists it. Test: P9. |
| 2 | Node's TAP output prints `duration_ms: 1.68` for every test. The number has no unit, so fingerprint normalisation kept it, and two identical failures got different fingerprints. `breaker_open` could never fire for `node --test`. | Missed save | Normalise `<name>_ms: <number>` and `<name>_s: <number>` fields as durations. Test: F4. |
| 3 | The shuffled suite (step 7.1) caught a real `wait-for` bug: after its last sleep it could start an attempt with only milliseconds left before `--max`, which was killed before printing anything, so "last output above" was empty. | Bug | An attempt now starts only with at least 1 s left. Test: WF2 (second case). |
| 4 | Under full-suite load, a hook's post-hash `git status` exceeded the 300 ms budget, so Kerb failed open and a later identical retry wasn't refused. | Correct fail-open (a missed save, never a false refusal) | Hooks now honour the user's `hash_budget_ms` setting; the loop-dependent hook tests set a generous budget. |

No refusals and no hash-budget skips from the agent's own commands so far in this session.

## Still to do

- A full working session with each enforced agent's hooks installed (Claude Code first), including real payload capture for `test/fixtures/hooks/`.
- One session on a large monorepo (100,000+ files).
