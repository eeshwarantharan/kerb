# Reporter fixtures (KERB-V2 5.4)

Each `<tool>/<name>.txt` is the output of the command in `<name>.cmd`, recorded on 2026-10-01
from the real tool with output not going to a terminal (stdout and stderr merged, as an agent
sees it), with the exit status in `<name>.exit`. Paths of the scratch projects were rewritten to
`/work/...`. `<fixture>.expected.json` is the reviewed parse result that tests RP1–RP11 compare
against; `node scripts/reporter-goldens.js` regenerates them after a fixture changes (review the
diff). `cases.json` lists each fixture with the repo root it was recorded in.

| Tool | Version | Fixtures |
|---|---|---|
| Vitest | 3.2.7 (default, verbose, `AI_AGENT=1`, JSON reporter); 4.1.11 on Node 24 (`--reporter=agent`, which Vitest also picks by itself under `CLAUDECODE=1`) | `vitest/` |
| Jest | 29.7 (default, `--verbose`, `--json --outputFile`) | `jest/` |
| pytest | 9 (default, `-rA`, `-v`, `--junitxml`) | `pytest/`, `junit/pytest-junit.xml` |
| go test | Go 1.23.4 (default, `-v`, `-json`) | `go/` |
| cargo test, Clippy | cargo 1.99, clippy 0.1.99 (`cargo test`, `cargo clippy`, `cargo clippy -- -D warnings`) | `cargo/`, `clippy/` |
| Node test runner | Node 20.12 (TAP, the default without a terminal; `--test-reporter=spec`) | `node/` |
| tsc | TypeScript 5 (plain and `--pretty`) | `tsc/` |
| ESLint | 9 (stylish) | `eslint/` |
| Ruff | 0.x (full and `--output-format=concise`) | `ruff/` |
| mypy | 1.x | `mypy/` |

`junit/surefire-TEST-com.shop.CartTest.xml` is written by hand in Maven Surefire's documented
report layout (Maven was not available); `junit/pytest-junit.xml` is real.
