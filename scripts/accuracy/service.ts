/**
 * Service-level simulation on the frozen dataset: follow Keha's orders (the app's real
 * computeVariant + planVariant) day by day on the real daily demand, lost sales when out (DENY),
 * and report the fill reached against each ABC role's fill target, stock-out days and the average
 * stock (in units and in days of demand — the dataset has no prices).
 *
 *   L, R      lead time and order cycle (days)
 *   level     lean | balanced | safe (the safety level: the fill targets per role)
 *   review    "daily" (order on the plan's order-by day) or "cycle" (every R days, everything due)
 *   late      share of deliveries that arrive late (seeded per variant); lateMax: the longest delay
 *             as a share of L (uniform 1 day … lateMax × L). Once 3 deliveries have landed the
 *             engine gets their measured lead-time σ, as compute does (supplierLeadSigma).
 *   moqDays   supplier minimum per line: this many days of the variant's mean demand (0 = none)
 *   naive     also run the naive order-up-to policy at these multipliers of z × σ × √(L + R)
 *   start     first simulated day (each variant starts 28 days after its launch at the earliest)
 *   seed      the late-delivery dice
 *
 * A censored sold-out day of the history is imputed at the trailing 28-day in-stock mean. The
 * measurement starts after a warm-up of L + R days. The roles' pooled forecast-error ratios
 * (compute's pre-pass, roleErrorPriors) are refreshed weekly here, not nightly (run time).
 */
import { computeVariant, type AbcRole, type VariantInput } from "../../app/lib/engine/index-shared";
import { planVariant } from "../../app/lib/engine/forward-plan-shared";
import { SERVICE_LEVELS, zForSafetyLevel, type SafetyLevelKey } from "../../app/lib/engine/safety-shared";
import { errorOriginDays, rolePrior } from "../../app/lib/engine/error-shared";
import { rng, rowsFor, seasonContextAt, type Dataset, type Variant } from "./data";

export interface ServiceOptions {
  L?: number;
  R?: number;
  level?: SafetyLevelKey;
  review?: "daily" | "cycle";
  late?: number;
  lateMax?: number;
  moqDays?: number;
  naive?: number[];
  start?: string;
  seed?: number;
  /** Extra computeVariant input / settings (experiments). */
  engine?: Partial<VariantInput>;
  settings?: Record<string, unknown>;
}

interface Res {
  demand: number;
  served: number;
  lostDays: number;
  stockUnits: number;
  stockDaysOfDemand: number;
  days: number;
  orders: number;
  lateArrivals: number;
}

export interface ServiceReport {
  policy: string;
  byRole: Record<string, { fill: number; target: number | null; gap: number | null; stockoutDaysPerYear: number; avgStockUnits: number; avgStockDays: number; variants: number; orders: number }>;
}

type Pipe = { at: number; units: number; placed: number }[];
type Policy = (v: Variant, t: number, onHand: number, pipe: Pipe, init: boolean, leadSigma: number | null) => number;

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export function runService(ds: Dataset, o: ServiceOptions = {}): ServiceReport[] {
  const L = o.L ?? 14;
  const R = o.R ?? 14;
  const level: SafetyLevelKey = o.level ?? "balanced";
  const review = o.review ?? "daily";
  const SIM_START = ds.idxOf(o.start ?? "2025-10-06");
  const N = ds.days;
  const seasons = new Map<number, ReturnType<typeof seasonContextAt>>();
  const seasonAt = (t: number) => {
    let c = seasons.get(t);
    if (!c) seasons.set(t, (c = seasonContextAt(ds, t)));
    return c;
  };
  const demandOn = (v: Variant, i: number) => {
    if (v.soldOut.has(i) && !(v.sold[i]! > 0)) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(v.launch, i - 28); k < i; k++)
        if (!v.soldOut.has(k)) {
          s += Math.max(0, v.sold[k]!);
          n++;
        }
      return n ? s / n : 0;
    }
    return Math.max(0, v.sold[i]!);
  };
  const meanDemand = new Map(ds.variants.map((v) => {
    let s = 0;
    let n = 0;
    for (let i = v.launch; i < Math.min(N, v.launch + 90); i++) {
      s += demandOn(v, i);
      n++;
    }
    return [v.id, n ? s / n : 0] as const;
  }));
  const moqOf = (v: Variant) => (o.moqDays ? Math.max(1, Math.ceil((meanDemand.get(v.id) ?? 0) * o.moqDays)) : null);
  const base = (v: Variant, t: number): Omit<VariantInput, "onHand"> => {
    const ctx = seasonAt(t);
    const s = ctx.forVariant([], L + R);
    const older = rowsFor(ds, v, t - 427, t - 91);
    return {
      id: v.id,
      series: rowsFor(ds, v, t - 90, t - 1),
      olderSeries: older,
      history: older,
      today: ds.dayOf(t),
      role: v.role,
      supplierLeadTimeDays: L,
      cycleDays: R,
      seasonal: s.seasonal,
      trend: s.trend,
      seasonCurve: ctx.curveFor(s, Math.ceil((L + R + 200) / 7)),
      levels: ctx.levelsFor(s, 90),
      seasonKnown: s.seasonalResult.applied,
      errorOrigins: ctx.originsFor(s, errorOriginDays(ds.dayOf(t), L + R), L + R),
      settings: { z: zForSafetyLevel(level), ...(o.settings ?? {}) },
      minOrder: moqOf(v),
      sellsWhenOut: false,
      ...(o.engine ?? {}),
    } as Omit<VariantInput, "onHand">;
  };
  // The roles' pooled error ratios (compute's pre-pass), refreshed weekly.
  const priors = new Map<number, Record<AbcRole, number>>();
  const priorsAt = (t: number) => {
    const w = t - (t % 7);
    let c = priors.get(w);
    if (c) return c;
    const ratios: Record<AbcRole, (number | null)[]> = { A: [], B: [], C: [] };
    for (const v of ds.variants) {
      if (v.launch >= w) continue;
      const r = computeVariant({ ...base(v, w), onHand: 0 } as VariantInput);
      ratios[v.role].push(r?.inputs.error?.ratio ?? null);
    }
    const store = rolePrior(Object.values(ratios).flat());
    c = { A: rolePrior(ratios.A) ?? store ?? 1, B: rolePrior(ratios.B) ?? store ?? 1, C: rolePrior(ratios.C) ?? store ?? 1 };
    priors.set(w, c);
    return c;
  };

  const keha: Policy = (v, t, onHand, pipe, init, leadSigma) => {
    const incoming = pipe.reduce((a, p) => a + p.units, 0);
    // The plan's view of open orders: due one lead time after they were placed (a late order is
    // still "due" on its planned day until it lands, as the app's PO arrival date).
    const arrivals = pipe.map((p) => ({ day: ds.dayOf(Math.max(t, p.placed + L)), units: p.units }));
    const b = base(v, t);
    const r = computeVariant({ ...b, onHand, incoming, arrivals, errorPrior: priorsAt(t)[v.role], leadTimeSigmaDays: leadSigma } as VariantInput);
    if (!r || r.rate === null) return 0;
    if (init) return Math.max(0, Math.ceil((r.inputs.orderNeed ?? 0) + onHand + incoming));
    const fwd = planVariant({
      today: ds.dayOf(t),
      status: r.status,
      rate: r.rate,
      seasonal: r.seasonal,
      trend: r.trend,
      plan: 1,
      curve: b.seasonCurve ?? null,
      safety: r.safety,
      leadTimeDays: L,
      cycleDays: R,
      onHand,
      incoming,
      arrivals,
      need: r.inputs.orderNeed,
      orderQty: r.orderQty,
      notCounted: 0,
      pack: null,
      moq: r.inputs.minOrder,
      days: review === "cycle" ? R : 1,
      outSince: r.inputs.outSince,
      sellsWhenOut: false,
    });
    if (review === "cycle") return fwd.orders.reduce((a, x) => a + x.qty, 0);
    const first = fwd.orders.find((x) => x.day === 0);
    return first ? first.qty : 0;
  };

  const naive = (c: number): Policy => {
    const z = zForSafetyLevel(level);
    return (v, t, onHand, pipe, init) => {
      const xs: number[] = [];
      for (let i = Math.max(v.launch, t - 28); i < t; i++) xs.push(demandOn(v, i));
      if (!xs.length) return 0;
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
      const ss = c * z[v.role] * sd * Math.sqrt(L + R);
      const S = m * (L + R) + ss;
      const pos = onHand + pipe.reduce((a, p) => a + p.units, 0);
      if (init) return Math.ceil(S);
      const moq = moqOf(v) ?? 0;
      const want = review === "cycle" || pos <= m * L + ss ? Math.max(0, Math.ceil(S - pos)) : 0;
      return want > 0 ? Math.max(want, moq) : 0;
    };
  };

  const simulate = (v: Variant, policy: Policy): Res | null => {
    const t0 = Math.max(SIM_START, v.launch + 28);
    if (t0 >= N - L - R) return null;
    const dice = rng((o.seed ?? 1) ^ hash(v.id));
    const delay = () => (o.late && dice() < o.late ? 1 + Math.floor(dice() * Math.max(1, (o.lateMax ?? 0.5) * L)) : 0);
    const leads: number[] = [];
    const leadSigma = () => {
      if (leads.length < 3) return null;
      const m = leads.reduce((a, b) => a + b, 0) / leads.length;
      const s = Math.sqrt(leads.reduce((a, x) => a + (x - m) ** 2, 0) / leads.length);
      return s > 0 ? s : null;
    };
    let onHand = policy(v, t0, 0, [], true, null);
    const pipe: Pipe = [];
    const res: Res = { demand: 0, served: 0, lostDays: 0, stockUnits: 0, stockDaysOfDemand: 0, days: 0, orders: 0, lateArrivals: 0 };
    const measureFrom = t0 + L + R;
    let demandSum = 0;
    for (let t = t0; t < N; t++) {
      for (let k = pipe.length - 1; k >= 0; k--)
        if (pipe[k]!.at <= t) {
          onHand += pipe[k]!.units;
          leads.push(pipe[k]!.at - pipe[k]!.placed);
          if (pipe[k]!.at > pipe[k]!.placed + L && t >= measureFrom) res.lateArrivals++;
          pipe.splice(k, 1);
        }
      const q = review !== "cycle" || (t - t0) % R === 0 ? policy(v, t, onHand, pipe, false, leadSigma()) : 0;
      if (q > 0) {
        pipe.push({ at: t + L + delay(), units: q, placed: t });
        if (t >= measureFrom) res.orders++;
      }
      const d = demandOn(v, t);
      const served = Math.min(Math.max(0, onHand), d);
      onHand -= served;
      if (t >= measureFrom) {
        res.demand += d;
        res.served += served;
        if (d - served > 1e-9) res.lostDays++;
        res.stockUnits += onHand;
        res.days++;
        demandSum += d;
      }
    }
    res.stockDaysOfDemand = demandSum > 0 ? res.stockUnits / demandSum : 0;
    return res;
  };

  const run = (name: string, policy: Policy): ServiceReport => {
    const by: Record<string, Res & { vd: number }> = {};
    for (const v of ds.variants) {
      const r = simulate(v, policy);
      if (!r) continue;
      for (const k of ["all", v.role]) {
        const g = (by[k] ??= { demand: 0, served: 0, lostDays: 0, stockUnits: 0, stockDaysOfDemand: 0, days: 0, orders: 0, lateArrivals: 0, vd: 0 });
        g.demand += r.demand;
        g.served += r.served;
        g.lostDays += r.lostDays;
        g.stockUnits += r.stockUnits;
        g.stockDaysOfDemand += r.stockDaysOfDemand;
        g.days += r.days;
        g.orders += r.orders;
        g.lateArrivals += r.lateArrivals;
        g.vd++;
      }
    }
    const byRole: ServiceReport["byRole"] = {};
    for (const [k, g] of Object.entries(by)) {
      const fill = (100 * g.served) / g.demand;
      const target = k === "all" ? null : 100 * SERVICE_LEVELS[level][k as AbcRole];
      byRole[k] = {
        fill: +fill.toFixed(1),
        target,
        gap: target === null ? null : +(fill - target).toFixed(1),
        stockoutDaysPerYear: +((g.lostDays / g.days) * 365).toFixed(1),
        avgStockUnits: Math.round(g.stockUnits / (g.days / g.vd)),
        // Days of the variants' own demand on the shelf (each variant's average, then the mean).
        avgStockDays: +(g.stockDaysOfDemand / g.vd).toFixed(1),
        variants: g.vd,
        orders: g.orders,
      };
    }
    return { policy: name, byRole };
  };

  const out = [run(`keha:${level}`, keha)];
  for (const c of o.naive ?? []) out.push(run(`naive:${c}`, naive(c)));
  return out;
}

export function formatService(rs: ServiceReport[], o: ServiceOptions): string {
  const lines = [`== Service: L ${o.L ?? 14}, R ${o.R ?? 14}, ${o.review ?? "daily"} review, late ${o.late ?? 0}${o.late ? ` (≤ ${o.lateMax ?? 0.5} × L)` : ""}, minimum ${o.moqDays ?? 0} days ==`];
  for (const r of rs) {
    lines.push(r.policy);
    for (const k of ["A", "B", "C", "all"]) {
      const g = r.byRole[k];
      if (!g) continue;
      lines.push(`  ${k.padEnd(4)} fill ${g.fill.toFixed(1).padStart(5)} %${g.target !== null ? ` (target ${g.target}, ${g.gap! >= 0 ? "+" : ""}${g.gap!.toFixed(1)})` : "                  "}  stock-out days/yr ${g.stockoutDaysPerYear.toFixed(1).padStart(5)}  avg stock ${String(g.avgStockUnits).padStart(7)} u (${g.avgStockDays.toFixed(1)} days)  variants ${g.variants}`);
    }
  }
  return lines.join("\n");
}

