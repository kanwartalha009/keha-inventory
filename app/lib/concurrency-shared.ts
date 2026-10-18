/**
 * Small concurrency helpers (DB scale #4/#5). Pure, no dependencies.
 */

/**
 * Maps `items` through `fn` with at most `limit` calls in flight; results keep the input order.
 * Used to cap parallel database reads (each in-flight query holds a pool connection).
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Runs thunks with at most `limit` in flight (heterogeneous queries); results keep the order. */
export function allLimit<T extends readonly (() => Promise<unknown>)[]>(
  limit: number,
  thunks: T,
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  return mapLimit(thunks, limit, (t) => t()) as Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }>;
}

/** Lets timers, I/O and other requests run between heavy synchronous steps. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Variants between two yields in compute's per-variant loops. */
export const YIELD_EVERY = 100;

/**
 * A counter that yields to the event loop on every `every`-th call (perf 2026-10-18): compute's
 * per-variant loop runs ~1–2 ms of engine work per variant, so a 2,000-variant chunk held the loop
 * 3–5 s on a large store; yielding every 100 variants caps one slice at ~0.1–0.2 s. Resolves at
 * once (no macrotask) on the other calls.
 */
export function yielder(every: number): () => Promise<void> | undefined {
  const n = Math.max(1, Math.floor(every));
  let i = 0;
  return () => (++i % n === 0 ? yieldToEventLoop() : undefined);
}

/** `ids` in slices of at most `size`. */
export function slices<T>(ids: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
