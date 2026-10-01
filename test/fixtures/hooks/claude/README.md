Claude Code hook payloads. The shapes follow the hooks reference verified on 2026-10-01
(https://code.claude.com/docs/en/hooks). `cwd` and `tool_use_id` are replaced by the tests.
Replace these with payloads captured from a real session during dogfooding (step 7.3).

`session-start-compact.json`, `session-start-resume.json` and `stop-active.json` follow the hooks reference re-read on 2026-10-02 (SessionStart `source`, Stop `stop_hook_active`).
