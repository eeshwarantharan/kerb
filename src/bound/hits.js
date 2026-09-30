// Refusal counts per boundary, from refusal records.

/** @param {any[]} recs @returns {Record<string, number>} keyed "kind:pattern" */
export function boundaryHits(recs) {
  const hits = {};
  for (const r of recs) if (r.type === 'refusal' && r.boundary) hits[r.boundary] = (hits[r.boundary] || 0) + 1;
  return hits;
}
