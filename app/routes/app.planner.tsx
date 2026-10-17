/**
 * /app/planner → /app/reorder/season (2026-10-17). Season plan moved under the Order plan path so
 * the admin nav highlights "Order plan" on it (Shopify highlights by path prefix). Emails, Slack,
 * Flow and bookmarks still point here: keep them working, query string included
 * (`?scenario=`, `?edit=`, the admin's own `shop` / `host` / `embedded`).
 */
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const SEASON_PLAN_PATH = "/app/reorder/season";

/** The new URL for an old /app/planner request (query string kept as it was). */
export function seasonPlanRedirect(requestUrl: string): string {
  return `${SEASON_PLAN_PATH}${new URL(requestUrl).search}`;
}

export const loader = ({ request }: LoaderFunctionArgs) => redirect(seasonPlanRedirect(request.url));

/** An old form posting here (none in the app any more): send it to the same place. */
export const action = ({ request }: LoaderFunctionArgs) => redirect(seasonPlanRedirect(request.url), 307);
