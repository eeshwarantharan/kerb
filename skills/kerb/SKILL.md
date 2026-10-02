---
name: kerb
description: Use Kerb for shell commands in repos with kerb.policy.json or a .kerb folder, so blocked actions and useless retries are caught before they waste turns, and test results, deltas and known fixes come from what actually ran.
---

# Using Kerb

If no Kerb hook is active, run shell commands as `kerb run -- <command>`.

## Reading Kerb's answers
- `kerb: policy_blocked`: not allowed here. Don't retry or work around it. Use the named alternative, or tell the user what you need and why.
- `kerb: identical_retry`: nothing relevant changed since this failed. Change something first. If a service isn't up yet, use `kerb wait-for`.
- `kerb: cached`: a static check (type check, lint) already ran on exactly these files; its recorded result is the answer and the exit code is the recorded one. Read it instead of running the check again.
- `kerb: deja_vu`: your files are back in a state that already failed. Try a different fix.
- `kerb: oscillating`: your edits are going back and forth between states that all fail. Stop, explain what you tried, and try something different.
- `kerb: breaker_open`: the same failure keeps happening despite edits. Stop, summarise what you tried, and propose a different approach.
- `kerb: <command> · N failing (was M)`: what changed since the last run: + fixed, ! still failing, - new failure, ~ flaky.
- `kerb: hint · seen before`: this exact failure was fixed before; `kerb show fix:<id>` shows how. `similar failure fixed before` is only a lead, not the same error.
- `kerb: cause`: Kerb found which of your edits broke a test, confirmed by re-running it; the `next:` line gives a patch that reverts only those edits.
- `kerb ledger` / `kerb: verification`: what was tried, and whether the last test result still matches the files. Don't say tests pass unless verification is green.
- `kerb: environment`: the failure comes from the environment (TLS interception, a corporate proxy's block page, expired credentials), not your code. Don't debug the code for it. Follow the `next:` line, or tell the user. Never turn certificate verification off.
- `kerb: note · [name] …`: advice from a plugin your team installed.
- Exit 124 or 125 with a Kerb footer: the command hung and was killed. Look for watch modes, prompts or servers; use a non-interactive variant or run servers in the background.

## Waiting and polling
- Use `kerb wait-for --max 3m -- <command>` to wait for a database, a server or a deploy. It retries inside one call and returns once.
- `--until output:<regex>` waits for specific output; `--interval` and `--backoff` control pacing.

## Rules
- Trust the `kerb:` line, not the exit code alone.
- Never run `kerb ack`, `kerb reset`, `kerb forget`, `kerb config`, `kerb enforce`, `kerb run --force`, `kerb restore --in-place`, `kerb sync --push` or `kerb plugins approve`, and never set `KERB_*` variables.
- Run `kerb map` at the start of a task to see known boundaries.
- The footer shows the full log path. Read the log only when the shaped output isn't enough.
