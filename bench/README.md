# Kerb benchmark

Two parts (docs/KERB.md 12.3):

1. **Hook latency** (`hook-latency.js`): warm p50/p95 of `kerb hook claude pre`, end to end, on a 5,000-file git repo. Results in `results/hook-latency-<platform>-<build>.json`. Gate: p95 under 100 ms.
2. **Tasks** (`run.js`, `tasks.js`): 22 tasks in sandboxed repos (blocked registries with a mirror, protected branches, flaky and slow tests, a late database, noisy and hanging commands, a 100,000-file monorepo), each run with and without Kerb, three times, by the same agent and model. Gate: success rate with Kerb no lower than without (within 1 point), and zero incorrect refusals.

## Running the task benchmark

```bash
node bench/proxy.js &                                   # restrictive egress, 403 "blocked by policy"
npx verdaccio &                                         # a working npm mirror on localhost:4873
node bench/run.js --proxy http://127.0.0.1:8899 \
  --agent-cmd "claude -p {prompt} --output-format json --max-turns 30"
```

Each row in `results/tasks/rows.jsonl` lists the run's refusals with `"correct": null`. Review every one and set it to `true` or `false`; a single `false` fails the launch gate and becomes a regression test.

## Status

- Hook latency: measured on one Apple Silicon laptop; see `results/`.
- Tasks: **not run yet.** The harness and tasks are here so the numbers can be reproduced; nothing in the README or launch posts may claim savings until this has been run and reviewed.
