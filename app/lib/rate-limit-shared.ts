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

/**
 * The client address for per-IP limits (review fix 2026-10-17).
 *
 *  1. CF-Connecting-IP when present: Cloudflare in front of the app sets it
 *     to the real client and overwrites any value the client sent.
 *  2. Else the RIGHT-most X-Forwarded-For entry: the one our own proxy
 *     (Railway's edge) appended for the connection it received. Everything
 *     to its left was sent by the client and can be anything, so the
 *     left-most entry would let a guesser pick a new "address" per request.
 *  3. Else X-Real-IP, else a fixed key (all such requests share one bucket).
 *
 * Caveat: with Cloudflare in front, the right-most XFF entry is a Cloudflare
 * edge, which is why (1) comes first. Without Cloudflare in front, a client
 * can send its own CF-Connecting-IP; the per-token limit still applies then.
 */
export function clientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops[hops.length - 1] || headers.get("x-real-ip")?.trim() || "unknown";
}
