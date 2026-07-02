/**
 * Wrap `fn` so calls less than `minIntervalMs` apart are dropped (the first
 * call always fires). Thins high-frequency progress callbacks down to a
 * UI-friendly rate. `clock` is injectable for tests.
 */
export function rateLimited<A extends unknown[]>(
  minIntervalMs: number,
  fn: (...args: A) => void,
  clock: () => number = Date.now,
): (...args: A) => void {
  let last = -Infinity;
  return (...args) => {
    const now = clock();
    if (now - last < minIntervalMs) return;
    last = now;
    fn(...args);
  };
}
