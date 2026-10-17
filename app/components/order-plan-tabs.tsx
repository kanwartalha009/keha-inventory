/**
 * Order plan tabs (Kanwar 2026-10-17): Order now · Next 90 days · Season plan · Open orders.
 * Each tab is its own route — the URLs emails, Slack, Flow and supplier links already use keep
 * working (/app/reorder, /app/planner) — and this strip links them, like the Settings tabs.
 */
import { useNavigate } from "react-router";
import { useLocale } from "../lib/i18n";
import { Tabs } from "./wc";

export const ORDER_PLAN_TABS = [
  { id: "now", path: "/app/reorder" },
  { id: "calendar", path: "/app/reorder/calendar" },
  { id: "season", path: "/app/planner" },
  { id: "orders", path: "/app/reorder/orders" },
] as const;
export type OrderPlanTabId = (typeof ORDER_PLAN_TABS)[number]["id"];

type T = (s: string) => string;

export function orderPlanTabLabel(id: OrderPlanTabId, t: T): string {
  switch (id) {
    case "now":
      return t("Order now");
    case "calendar":
      return t("Next 90 days");
    case "season":
      return t("Season plan");
    case "orders":
      return t("Open orders");
  }
}

export function OrderPlanTabs({ current }: { current: OrderPlanTabId }) {
  const { t } = useLocale();
  const navigate = useNavigate();
  return (
    <Tabs
      tabs={ORDER_PLAN_TABS.map((x) => ({ id: x.id, content: orderPlanTabLabel(x.id, t) }))}
      selected={ORDER_PLAN_TABS.findIndex((x) => x.id === current)}
      onSelect={(i) => navigate(ORDER_PLAN_TABS[i]!.path)}
    />
  );
}
