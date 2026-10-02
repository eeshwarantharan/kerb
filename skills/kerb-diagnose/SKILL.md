---
name: kerb-diagnose
description: A disciplined debugging loop for a failing check in a repo that uses Kerb. Use it when tests or a build keep failing, before the next edit-and-rerun, so each attempt tests one idea against Kerb's records instead of guessing.
---

# Diagnosing a failure with Kerb

Kerb records every check run: which tests failed, the files at each attempt, fixes that worked before, and which edit broke a test. Use those records instead of memory.

## 1. Read what was already tried
- `kerb progress`: failing counts since the last success, and the signal (converging, stalled, diverging, oscillating).
- `kerb ledger`: attempts, files edited between them, returns to earlier files, the last green state.
- If the signal is `stalled` or `oscillating`, go to step 6 now.

## 2. Look for a known answer
- `kerb cause`: if Kerb already isolated the edit that broke the test, read it. Its `next:` line gives a patch that reverts only that edit.
- A `kerb: hint · seen before` line means this exact failure was fixed before: `kerb show fix:<id>` shows the fix. "similar failure fixed before" is only a lead.

## 3. Reproduce with the narrowest test
- `kerb history` gives the latest run's id; `kerb why <run-id>` lists its failing tests and a `narrow` command that runs just the first one. Run that, through Kerb, instead of the whole suite while you work.

## 4. One hypothesis per attempt
- Write down, in one sentence, what you think is wrong and what result would prove it.
- Make the smallest edit that tests that one idea. Don't bundle unrelated changes into the same attempt.
- Run the narrow test. Read Kerb's delta line (`+ fixed`, `! still failing`, `- new failure`) before deciding anything.

## 5. Before editing again
- Run `kerb cause` again: a new finding may have arrived after the last run.
- If the delta shows a new failure, your last edit caused it. Undo or fix that first.
- `kerb green` shows the newest state where the check passed; `kerb restore <state> --patch` writes a patch back to it without applying anything.

## 6. Stop and summarise when stuck
On `stalled`, `oscillating`, `diverging` or `breaker_open`: stop editing. Tell the user what you tried (from `kerb ledger`), what each attempt showed, and what you would try next and why. Don't retry the same idea with small variations.

## Rules
- Kerb's records are the source of truth about what ran; don't claim a test passes from memory.
- Never run `kerb ack`, `kerb reset`, `kerb restore --in-place` or `kerb run --force` to get past a refusal; they are for the user.
