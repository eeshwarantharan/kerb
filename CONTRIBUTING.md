# Contributing to Kerb

Thanks for helping. Kerb's first rule is that **false refusals are the enemy**: one wrong refusal costs more trust than ten saves earn. Every change should keep that in mind, and every reported false refusal becomes a regression test.

## Getting started

```bash
git clone https://github.com/eeshwarantharan/kerb && cd kerb
node --test                       # Node 20+; no install step, there are no dependencies
node bin/kerb.js --help
```

- `docs/KERB.md` is the specification and the source of truth. If you change behaviour, change the spec in the same pull request, and add a line to its section 13 (Decisions log) when you make a judgement call.
- Code is plain JavaScript (ES modules) with JSDoc types. No runtime or dev dependencies, ever; CI rejects them.
- Tests use `node:test`. A test that asserts a refusal must also assert the command did **not** run (a side-effect file outside the repo is the usual way). Time-based rules use the injectable clock (`setClock` in `src/util/core.js`).
- Useful extra runs: `KERB_TEST_PERF=1 node --test test/perf.test.js test/workspace.test.js` (performance), `node scripts/shuffle-tests.js --runs 10` (order and flakes), `KERB_TEST_BIN=dist/kerb.cjs node --test` after `node scripts/bundle.js` (the bundled build).

## Adding a denial signature

Denial signatures teach Kerb to recognise a real policy block, so the next attempt is refused before it runs. They live in `src/bound/learn.js`.

1. Collect the exact line the tool prints when your proxy or firewall blocks it. Redact anything private.
2. Decide the strength. **Strong** means the line can only come from a policy decision (for example `blocked by policy`, `CONNECT tunnel failed, response 403`); strong hits are confirmed immediately. **Weak** means the line could have other causes (DNS failures); weak hits stay *suspected* and never block until seen from two different commands.
3. Add the matcher to `STRONG` or `WEAK`, and add a word from it to `PREFILTER` so the line is examined.
4. Remember the safety rule: a line only counts if it names a host the command actually contacted. Don't loosen that.
5. Add tests in `test/learn.test.js`: the signature learns the host from a network command (use a fake `./curl` script, as the existing tests do), and the same text from `cat` or from a command that didn't contact that host learns nothing.

## Adding a transient pattern

Transient patterns mark failures that one identical retry may fix (flaky networks, throttling, gateway errors). They live in `TRANSIENT_DEFAULT` in `src/loop/fingerprint.js`; dependency-unavailable patterns ("the service isn't up yet") live in `DEPENDENCY_DEFAULT` next to them.

- Only add messages that really are transient. `500 Internal Server Error` and "does not exist" are deliberately *not* transient: they are usually real bugs.
- Keep patterns specific and cheap. They run on every output line up to 4 KB.
- Add a case to `F9` (or a new F-test) in `test/fingerprint.test.js`, and a negative case if your pattern could match ordinary output.
- Team-specific messages belong in a policy's `transient_patterns` or `dependency_patterns`, not in the defaults.

## Adding an agent adapter

1. **Verify first.** Read the agent's current hooks documentation and find: the pre- and post-command events, the payload fields (command, working directory, call id, exit code, output, timeout), how a hook denies a call and what the agent shows, whether an empty or failed hook fails open or closed, and where hook configuration lives. Record what you found, with links, in `docs/KERB.md` section 13.
2. Write `src/adapters/<agent>.js` with `pre`, `post`, `startOutput` and `stopOutput`. Map the payload onto `observePre` / `observePost` (see `claude.js` and `cursor.js`). Use `callId()` when the agent sends no call id.
3. **Deny-only:** return a deny in the agent's format, or `null`. Never return an allow, an approve or a rewritten command. If the agent blocks on empty output, don't add the adapter until there's a way to stay neutral.
4. Add a descriptor to `src/init/agents.js`: detection, the settings file and merge logic (with absolute paths), `strip` for uninstall, and `hookCommands` for `kerb doctor`. Settings files that contain absolute paths should be gitignored when Kerb creates them.
5. Register the adapter in `src/cli/hook.js`.
6. Add payload fixtures in `test/fixtures/hooks/<agent>/` (captured from a real session where possible), and extend the table in `test/adapters.test.js` so G1–G7 cover the new agent.
7. Update the "Works with" table in the README with an honest tier.

## Reporting a false refusal

Use the "False refusal" issue template and include `kerb why` output. The fix always comes with a regression test.

## Pull requests

Keep them focused, run `node --test`, and describe what changed and why. By contributing you agree your work is licensed under Apache-2.0.
