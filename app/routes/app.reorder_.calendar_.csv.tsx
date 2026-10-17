/**
 * The 13-week order plan as CSV (/app/reorder/calendar/csv) — Order plan · Next 13 weeks,
 * Growth (`orderCalendar`). Headers in the admin's language (Shop.locale); unknown costs are
 * empty, never 0. Free gets the upgrade JSON (403).
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getEntitlements, upgradeResponse } from "../services/entitlements.server";
import { loadOrderPlan } from "../models/order-plan.server";
import { shopBasics } from "../models/reorder.server";
import { toSupportedLocale, translate } from "../lib/i18n";
import { planCsv } from "../lib/order-plan-shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { features } = await getEntitlements(session.shop);
  if (!features.orderCalendar) return upgradeResponse("orderCalendar", "The 13-week order calendar is on the Growth plan.");
  const [plan, basics] = await Promise.all([loadOrderPlan(session.shop), shopBasics(session.shop)]);
  const locale = toSupportedLocale(basics.locale);
  const csv = planCsv(plan, (s) => translate(locale, s));
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="order-plan-${plan.today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
