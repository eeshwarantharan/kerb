// Hook handoff records (.kerb/pending). Implemented in step 4.2.

/** Hook context for a `kerb run` / `kerb wait-for` the agent started, or null. */
export function hookContextFor(cwd, command) {
  void cwd; void command;
  return null;
}
