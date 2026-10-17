/**
 * An OrderPlanData built with the real forward plan (engine/forward-plan-shared) for the
 * Dashboard and Order plan SSR tests: two suppliers, one vendor group, one overdue line, one
 * line without a cost.
 */
import { eventsOf, planDays, planVariant, type ForwardVariantInput, type PlanEvent } from "../app/lib/engine/forward-plan-shared";
import { demand } from "../app/lib/engine/order-shared";
import type { OrderPlanData, PlanVariantInfo } from "../app/lib/order-plan-shared";

export const PLAN_TODAY = "2026-10-16";

function input(over: Partial<ForwardVariantInput>): ForwardVariantInput {
  const b = { today: PLAN_TODAY, status: "healthy", rate: 2, seasonal: 1, trend: 1, plan: 1, curve: null, safety: 10, leadTimeDays: 14, cycleDays: 14, onHand: 100, incoming: 0, arrivals: [], pack: null, moq: null, days: planDays(PLAN_TODAY), ...over };
  return { ...b, need: demand(b.rate!, { seasonal: 1, trend: 1, plan: 1 }, b.leadTimeDays + b.cycleDays) + b.safety! - (b.onHand + b.incoming) };
}

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;

export function orderPlanFixture(over: Partial<OrderPlanData> = {}): OrderPlanData {
  const rows: { n: number; product: string; key: string; cost: number | null; over: Partial<ForwardVariantInput> }[] = [
    { n: 1, product: "Linen shirt", key: "supplier:s1", cost: 12, over: { onHand: 5 } }, // overdue, ordered today
    { n: 2, product: "Linen trousers", key: "supplier:s1", cost: 20, over: { onHand: 40 } }, // due tomorrow
    { n: 3, product: "Mug", key: "vendor:acme", cost: null, over: { onHand: 80, rate: 1 } }, // later, no cost
    { n: 4, product: "Cap", key: "supplier:s2", cost: 4, over: { onHand: 300, rate: 3 } },
  ];
  const events: PlanEvent[] = [];
  const variants: Record<string, PlanVariantInfo> = {};
  for (const r of rows) {
    const plan = planVariant(input(r.over));
    events.push(...eventsOf(plan, { variantId: V(r.n), productId: `P${r.n}`, supplierKey: r.key, unitCost: r.cost }));
    variants[V(r.n)] = {
      variantId: V(r.n),
      productId: `P${r.n}`,
      productTitle: r.product,
      variantTitle: "M",
      sku: `SKU-${r.n}`,
      image: null,
      daysLeft: (r.over.onHand ?? 100) / (r.over.rate ?? 2),
      neverRunsOut: false,
      deadline: plan.deadline,
      valuePerDay: (r.over.rate ?? 2) * 25,
    };
  }
  events.sort((a, b) => a.orderBy.localeCompare(b.orderBy) || a.supplierKey.localeCompare(b.supplierKey));
  return {
    today: PLAN_TODAY,
    currency: "EUR",
    timezone: "Europe/Madrid",
    events,
    variants,
    suppliers: {
      "supplier:s1": { key: "supplier:s1", kind: "supplier", supplierId: "s1", name: "Lisbon Linen" },
      "supplier:s2": { key: "supplier:s2", kind: "supplier", supplierId: "s2", name: "Cap Co" },
      "vendor:acme": { key: "vendor:acme", kind: "vendor", supplierId: null, name: "Acme" },
    },
    suppliersSetUp: true,
    cantPlan: { noData: 12, dead: 1 },
    ...over,
  };
}
