// Delta debugging (Zeller's ddmin) over hunks (KERB-V2 8.2): the smallest subset of changes that
// still makes the test fail. `test(subset)` resolves to 'fail', 'pass' or 'unresolved' (a subset
// that doesn't apply, or a test that didn't run); only 'fail' narrows. Throws Budget when the
// probe budget runs out, carrying the smallest failing set found so far.

export class Budget extends Error {
  constructor(best) { super('probe budget exhausted'); this.best = best; }
}

function split(list, n) {
  const out = [];
  const size = Math.ceil(list.length / n);
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * @param {string[]} all hunk ids (test(all) is known to fail)
 * @param {(subset: string[]) => Promise<'fail'|'pass'|'unresolved'>} test
 */
export async function ddmin(all, test) {
  let c = [...all];
  let n = 2;
  const run = async (s) => {
    try { return await test(s); } catch (e) { if (e instanceof Budget) throw new Budget(c); throw e; }
  };
  while (c.length > 1) {
    const parts = split(c, Math.min(n, c.length));
    let reduced = false;
    for (const d of parts) {
      if ((await run(d)) === 'fail') { c = d; n = 2; reduced = true; break; }
    }
    if (reduced) continue;
    if (parts.length > 2) {
      for (const d of parts) {
        const comp = c.filter((x) => !d.includes(x));
        if ((await run(comp)) === 'fail') { c = comp; n = Math.max(n - 1, 2); reduced = true; break; }
      }
      if (reduced) continue;
    }
    if (n >= c.length) break;
    n = Math.min(c.length, n * 2);
  }
  return c;
}
