/**
 * In-memory sliding-window rate limiter (spec §14: the public supplier
 * confirm link is rate-limited). One process, best effort: a restart forgets
 * the counts, which is fine for slowing down guessing. Pure apart from its
 * own Map; `now` is passed in so tests never wait.
 */

export type RateLimiter = {
  /** Records one request for `key`; false when the key is over the limit (the request is not counted). */
  hit(key: string, now?: number): boolean;
  /** Keys currently tracked (tests / memory guard). */
  size(): number;
};

export function createRateLimiter(opts: { limit: number; windowMs: number; maxKeys?: number }): RateLimiter {
  const hits = new Map<string, number[]>();
  const maxKeys = opts.maxKeys ?? 10_000;
  return {
    hit(key, now = Date.now()) {
      const since = now - opts.windowMs;
      const list = (hits.get(key) ?? []).filter((t) => t > since);
      if (list.length >= opts.limit) {
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.delete(key); // re-insert: Map order = least recently used first
      hits.set(key, list);
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
      return true;
    },
    size: () => hits.size,
  };
}

/** The client address: first X-Forwarded-For hop (Railway's proxy sets it), else a fixed key. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || headers.get("x-real-ip")?.trim() || "unknown";
}
