---
name: kerb-before-done
description: Check Kerb's verification status before saying a task is finished, tests pass or the build is green. Use it at the end of any task that touched code in a repo that uses Kerb.
---

# Before you say you're done

Kerb knows whether the last test result is still about the files as they are now. Ask it before you claim anything.

## Steps
1. Run `kerb status` and read the `verification` section. It lists every check run in this session, and the checks the team requires, with one status each:
   - `green`: the last run passed on exactly the current files.
   - `red`: the last run failed on the current files.
   - `stale`: the files changed after the last run; it names them.
   - `never`: the check hasn't run in this session.
2. For every check that isn't `green`, run it again through Kerb, then run `kerb status` again.
3. Only when every check you touched is `green` may you say the tests pass.

## What to say
- All `green`: say which checks passed, on the current files.
- Something `red`: say what still fails (`kerb history` gives the run id; `kerb why <run-id>` lists its failing tests). Don't call the task done.
- Something `stale` or `never` that you couldn't run (no time, needs a service, needs the user): say plainly that it wasn't verified, and why.

## Never
- Never say "tests pass", "all green" or "done" from an earlier run, from memory, or because the code looks right. Only a `green` status counts.
- Never edit or skip a test to make a check green unless the user asked for that change.
