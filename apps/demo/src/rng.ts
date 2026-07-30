/**
 * Small deterministic PRNG (mulberry32) so the corpus generator is a pure
 * function of (now, seed): tests get stable expectations and a reseed after
 * reset produces an equivalent: not byte-identical, demo.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [min, max] (inclusive). */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Uniform float in [min, max). */
export function randFloat(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) {
    throw new Error('pick from empty array');
  }
  return item;
}

/** True with probability p. */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

/** Random lowercase hex string of the given length (trace/span ids). */
export function hexId(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += Math.floor(rng() * 16).toString(16);
  }
  return out;
}
