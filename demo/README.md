# Kerb demo

The launch demo (60–90 seconds, docs/KERB.md 12.2), as a script you can run:

1. `sh demo/setup.sh /tmp/kerb-demo`: a repo whose policy blocks `registry.npmjs.org` (alternative: a local mirror), protects `main`, has one real failing test, and has a test database that takes about 20 seconds to start.
2. Start a mirror: `npx verdaccio` (it listens on `http://localhost:4873`).
3. `cd /tmp/kerb-demo && kerb init --agent claude`.
4. Ask the agent: "Add left-pad and make the tests pass." What should happen:
   - `npm install left-pad` → `policy_blocked`, naming the mirror; the agent uses it.
   - The tests fail because the database isn't up; an immediate re-run → `identical_retry` pointing to `kerb wait-for`; the agent starts the database and runs `kerb wait-for -- npm test`, which returns once it's up.
   - A real test failure; a re-run with nothing changed → `identical_retry`.
   - The agent fixes `src/pad.js`; the tests pass.
   - The recap appears and the status line shows the saves.
5. `kerb card --session` shows the card.

`demo/demo.tape` records it with [VHS](https://github.com/charmbracelet/vhs). Use the real numbers on screen; don't edit them.
