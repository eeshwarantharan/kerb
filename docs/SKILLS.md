# Kerb's skills

Three skills live in [`skills/`](../skills). Each is a `SKILL.md` with frontmatter on line 1, so any agent that reads skills can use them.

| Skill | Use it when |
|---|---|
| [`kerb`](../skills/kerb/SKILL.md) | Always, in a repo that uses Kerb. Explains each `kerb:` line: refusals, cached answers, deltas, hints, cause findings, verification. `kerb init` installs this one. |
| [`kerb-diagnose`](../skills/kerb-diagnose/SKILL.md) | A check keeps failing. Read `kerb progress` and `kerb ledger`, check `kerb cause` and known fixes, reproduce with the narrow test from `kerb why <run>`, test one hypothesis per attempt, stop and summarise when stalled or oscillating. |
| [`kerb-before-done`](../skills/kerb-before-done/SKILL.md) | The end of a task. Check `kerb status` verification for every check touched; never say "tests pass" unless it is green on the current files. |

The skills only guide the agent. The enforcement and the records come from the Kerb CLI and its hooks: install it (`npm i -g kerb-cli`) and run `kerb init` in the repo.

## Installing them

- **Claude Code plugin.** This repository is its own plugin marketplace:
  ```
  /plugin marketplace add eeshwarantharan/kerb
  /plugin install kerb@kerb
  ```
  The plugin holds the three skills only. Hooks and the MCP server come from `kerb init`, which writes them with this machine's paths.
- **`npx skills`.** The `skills/<name>/SKILL.md` layout is what the skills CLI reads: `npx skills add eeshwarantharan/kerb --skill kerb-diagnose` (or `--skill kerb-before-done`).
- **By hand.** Copy a skill's folder into your agent's skills directory (`.claude/skills/`, `.github/skills/`, …).

The MCP server (`kerb mcp`, read-only) is described for the MCP registry in [`server.json`](../server.json); `kerb init` registers it for Claude Code, Cursor, VS Code and Gemini CLI, and prints the command for Codex, OpenCode and Copilot CLI.

## Pairing `kerb-diagnose` with other debugging skills

Many debugging skills teach the same loop: reproduce, form one hypothesis, test it with the smallest change, verify, repeat. `kerb-diagnose` doesn't replace that loop; it supplies the evidence each step needs, from records rather than memory:

| Step of the loop | What Kerb adds |
|---|---|
| Reproduce | `kerb why <run>` gives the narrow command for the first failing test. |
| What's been tried | `kerb ledger` and `kerb progress`: attempts, edits between them, returns to earlier files, the trend. |
| Hypothesise | `kerb cause` (the edit that broke it, confirmed by probes) and `kerb show fix:<id>` (how this failure was fixed before). |
| Test one change | The delta after each run: `+ fixed`, `! still failing`, `- new failure`. |
| Know when to stop | `stalled`, `oscillating`, `diverging` and the breaker say the approach isn't working. |
| Verify | `kerb-before-done`: green on the current files, or say it isn't verified. |

Install both skills side by side. Where they disagree about when to stop, follow Kerb's signals: they come from the runs that actually happened.
