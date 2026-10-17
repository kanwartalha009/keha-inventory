/**
 * Seeded randomness for the store simulator (lib/sim/store-sim-shared). Pure and deterministic:
 * the same seed gives the same store on every machine. mulberry32 (as the scale fixture uses) plus
 * the draws the simulator needs (Poisson, log-normal, picks).
 */

export type Rng = {
  /** Uniform in [0, 1). */
  next: () => number;
  /** Integer in [min, max] (inclusive). */
  int: (min: number, max: number) => number;
  /** True with probability p. */
  chance: (p: number) => boolean;
  /** Poisson(λ) draw (λ ≥ 0). */
  poisson: (lambda: number) => number;
  /** exp(N(0, σ)): a multiplicative noise factor with median 1. */
  logNormal: (sigma: number) => number;
  /** One element, by weight (weights ≥ 0, at least one > 0). */
  weighted: <T>(items: readonly T[], weights: readonly number[]) => T;
  /** An independent stream derived from this seed and a label (stable whatever else is drawn). */
  fork: (label: string | number) => Rng;
};

/** FNV-1a 32-bit hash of a string (stable ids, seeds). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    // Box–Muller (one value per call; the pair's second half is dropped for simplicity).
    let u = next();
    if (u < 1e-12) u = 1e-12;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    poisson: (lambda) => {
      if (!(lambda > 0)) return 0;
      if (lambda > 40) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal()));
      // Knuth: multiply uniforms until the product drops below e^-λ.
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = next();
      while (p > limit) {
        k++;
        p *= next();
      }
      return k;
    },
    logNormal: (sigma) => Math.exp(sigma * normal()),
    weighted: (items, weights) => {
      const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= Math.max(0, weights[i] ?? 0);
        if (r < 0) return items[i]!;
      }
      return items[items.length - 1]!;
    },
    fork: (label) => createRng(hash32(`${seed}:${label}`)),
  };
  return rng;
}
