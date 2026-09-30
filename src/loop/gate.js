// Loopbreaker gate for check-class commands. Implemented in milestone 2.

/** @returns {{ refusal: any | null, matched: any | null, loop: any | null }} */
export function loopGate(prep, o = {}) {
  void prep; void o;
  return { refusal: null, matched: null, loop: null };
}
