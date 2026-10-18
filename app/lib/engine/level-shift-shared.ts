/**
 * Level-shift detection (forecast quality 2026-10-17, owner-approved B5). Pure.
 *
 * The pace blends the last 28 / 56 / 90 days (0.5 / 0.3 / 0.2), so a product that went viral, or
 * died, keeps being planned at a level it no longer sells at for weeks. Here a SUSTAINED change in
 * the level is tested for; after a confirmed one the pace is the level since the change.
 *
 * Series: the in-stock full days of the last `windowDays` days after spike capping (sold-out,
 * partial and return-heavy days left out), DE-SEASONALISED by the season source's daily level
 * (y = sold ÷ level). Without levels the raw sales are tested (y = sold): computeVariant does that
 * only when the store has no seasonal index yet, and keeps only a DROP there (accuracy audit
 * 2026-10-18) — a seasonal ramp or Black Friday can't be told from a new level (on a real store's
 * backtest, detection on raw sales flagged the November peak in a third of the products and cost
 * 2 points of WAPE; drops only: neutral, and a product falling from 10 to 1 a day is caught).
 *
 * Test (the change point found by maximising the two-window contrast): for every split with at
 * least `minBeforeDays` in-stock days before and `searchAfterDays` after,
 *     z = (mean after − mean before) ÷ √(v × (1/n_before + 1/n_after)),
 * v = the larger of the pooled day variance, the variance of 7-day means × 7 (sales of nearby
 * days move together: a promotion week is not independent noise) and the Poisson variance. The
 * split with the largest |z| is the change point. Confirmed when
 *  - |z| ≥ `z` (4: the change-point scan is a multiple test over ~50 splits),
 *  - the level at least doubled, or fell below a third (`upRatio`, `downRatio`), and
 *  - the raw sales moved the same way by ×1.3 at least (a steady product in a group whose level
 *    moved is the group changing, not the product),
 *  - it is sustained: the change point (searched with two weeks after it) is four weeks or more
 *    old, and each half of the days since it is on the new side
 *    of the midpoint between the two levels.
 * The bar is high on purpose. On the real store (docs/ACCURACY.md) a third to a half of the
 * products "shift" by a looser test (×1.3, z 3.5, two weeks) and those changes mostly reverted —
 * using the new level raised WAPE from 31.6 to 37 %. With this bar the detection is neutral there
 * (28-day WAPE 31.6 → 31.7 %, bias −6.1 → −5.4 %) and catches the viral / dead products it is for.
 *
 * After a shift the pace is θ × B: θ = Σ sold ÷ Σ level over the in-stock days since the change
 * (the product's de-seasonalised level now), B = the rate windows' own blend of the level over
 * their in-stock days — what the blended pace would be had the new level always held, so the
 * seasonal index (built on the same blend one year back) applies to it unchanged.
 */
import { dayIndex, fromDayIndex, type DayKey } from "./dates-shared";
import type { DailyRow, RateWindowSpec } from "./types-shared";

export const LEVEL_SHIFT = Object.freeze({
  /** |z| at the change point (weekly-block variance). */
  z: 4,
  /** A step up counts from ×2, a step down from ×⅓ (see the module header). */
  upRatio: 2,
  downRatio: 1 / 3,
  /** In-stock days needed after the change (sustained: four weeks) and before it. */
  minAfterDays: 28,
  minBeforeDays: 14,
  /** The raw (not de-seasonalised) sales moved the same way by at least this factor. */
  rawRatio: 1.3,
  /** The change point is searched with at least this many in-stock days after it. */
  searchAfterDays: 14,
  /** Days searched (the pace's longest window). */
  windowDays: 90,
});

export interface LevelShift {
  /** The first in-stock day at the new level. */
  day: DayKey;
  /** Units per in-stock day before and after the change (raw, not de-seasonalised). */
  before: number;
  after: number;
  /** De-seasonalised after ÷ before (> 1: stepped up). */
  ratio: number;
  z: number;
  /** In-stock days since the change. */
  afterDays: number;
  /** The pace from the new level (θ × B, see the module header). */
  rate: number;
}

type Pt = { i: number; x: number; l: number; y: number };

const soldOut = (r: Pick<DailyRow, "outOfStock" | "sold">) => r.outOfStock && !(r.sold > 0);

/**
 * The confirmed level shift in the last `windowDays` days before `today`, or null. `rows` by day
 * index (rate-shared SeriesIndex), already capped; `levels` the season source's daily levels.
 */
export function levelShift(
  rows: ReadonlyMap<number, DailyRow>,
  today: DayKey,
  windows: readonly RateWindowSpec[],
  levels?: ReadonlyMap<DayKey, number> | null,
  opts: { z?: number } = {},
): LevelShift | null {
  const Z = opts.z ?? LEVEL_SHIFT.z;
  if (!(Z > 0) || !Number.isFinite(Z)) return null;
  const t = dayIndex(today);
  const lv = (day: DayKey) => {
    const l = levels?.get(day);
    return typeof l === "number" && Number.isFinite(l) && l > 0 ? l : 1;
  };
  const pts: Pt[] = [];
  for (let i = t - LEVEL_SHIFT.windowDays; i < t; i++) {
    const r = rows.get(i);
    if (!r || soldOut(r) || r.partial || !(r.sold >= 0)) continue;
    const l = lv(r.day);
    pts.push({ i, x: r.sold, l, y: r.sold / l });
  }
  const n = pts.length;
  // The change point is searched with two weeks after it at least; it must then be four weeks old
  // (a step 20 days ago is found at 20 days, not pinned at 28, and is not sustained yet).
  const A = LEVEL_SHIFT.searchAfterDays;
  const B0 = LEVEL_SHIFT.minBeforeDays;
  if (n < LEVEL_SHIFT.minAfterDays + B0) return null;
  const S = new Float64Array(n + 1);
  const Q = new Float64Array(n + 1);
  const invL = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) {
    S[k + 1] = S[k]! + pts[k]!.y;
    Q[k + 1] = Q[k]! + pts[k]!.y * pts[k]!.y;
    invL[k + 1] = invL[k]! + 1 / pts[k]!.l;
  }
  let best: { k: number; z: number; mb: number; ma: number } | null = null;
  for (let k = B0; k <= n - A; k++) {
    const nb = k;
    const na = n - k;
    const mb = S[k]! / nb;
    const ma = (S[n]! - S[k]!) / na;
    const ssb = Q[k]! - nb * mb * mb;
    const ssa = Q[n]! - Q[k]! - na * ma * ma;
    // Poisson floor: y = x ÷ level has variance mean ÷ level.
    const poisson = (Math.min(mb, ma) + Math.max(mb, ma)) / 2 * (invL[n]! / n);
    // Sales of nearby days move together (a promotion week, a campaign): the variance is at least
    // that of the 7-day means × 7, so a few strong weeks don't pass as a new level.
    const bv = (from: number, to: number, m: number) => {
      let q = 0;
      let c = 0;
      for (let j = from; j + 7 <= to; j += 7) {
        q += ((S[j + 7]! - S[j]!) / 7 - m) ** 2;
        c++;
      }
      return { q, c };
    };
    const w1 = bv(0, k, mb);
    const w2 = bv(k, n, ma);
    const weekly = w1.c + w2.c > 2 ? (7 * (w1.q + w2.q)) / (w1.c + w2.c - 2) : 0;
    const v = Math.max((ssb + ssa) / Math.max(1, n - 2), weekly, poisson, 1e-12);
    const z = (ma - mb) / Math.sqrt(v * (1 / nb + 1 / na));
    if (!best || Math.abs(z) > Math.abs(best.z)) best = { k, z, mb, ma };
  }
  if (!best || Math.abs(best.z) < Z) return null;
  const { k, mb, ma } = best;
  if (n - k < LEVEL_SHIFT.minAfterDays) return null;
  const ratio = mb > 0 ? ma / mb : Infinity;
  if (!(ratio >= LEVEL_SHIFT.upRatio || ratio <= LEVEL_SHIFT.downRatio)) return null;
  // Sustained: both halves of the days after the change sit on the new side of the midpoint.
  const mid = (mb + ma) / 2;
  const half = Math.floor((n - k) / 2);
  const mean = (a: number, b: number) => (S[b]! - S[a]!) / (b - a);
  const h1 = mean(k, k + half);
  const h2 = mean(k + half, n);
  if (ma > mb ? !(h1 > mid && h2 > mid) : !(h1 < mid && h2 < mid)) return null;
  // The new level θ (de-seasonalised) and the blend of the level over the rate windows (B).
  let sx = 0;
  let sl = 0;
  let rawAfter = 0;
  for (let j = k; j < n; j++) {
    sx += pts[j]!.x;
    sl += pts[j]!.l;
    rawAfter += pts[j]!.x;
  }
  let rawBefore = 0;
  for (let j = 0; j < k; j++) rawBefore += pts[j]!.x;
  // The raw sales must move the same way (by ×1.3 at least): a steady product in a group whose
  // level moved is the group changing, not the product.
  const rawRatio = rawBefore > 0 ? rawAfter / (n - k) / (rawBefore / k) : Infinity;
  if (ma > mb ? !(rawRatio >= LEVEL_SHIFT.rawRatio) : !(rawRatio <= 1 / LEVEL_SHIFT.rawRatio)) return null;
  const theta = sl > 0 ? sx / sl : 0;
  let num = 0;
  let den = 0;
  for (const w of windows) {
    let s = 0;
    let c = 0;
    for (const p of pts) if (p.i >= t - w.days) {
      s += p.l;
      c++;
    }
    if (!c) continue;
    num += w.weight * (s / c);
    den += w.weight;
  }
  const blend = den > 0 ? num / den : 1;
  return {
    day: fromDayIndex(pts[k]!.i),
    before: rawBefore / k,
    after: rawAfter / (n - k),
    ratio: Math.min(100, ratio),
    z: best.z,
    afterDays: n - k,
    rate: Math.max(0, theta * blend),
  };
}
