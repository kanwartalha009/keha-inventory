/**
 * GET /app/actions — the Actions page (0286, Kanwar 2026-10-20): the whole "This week's actions"
 * list with its tabs; ?tab= opens a tab (the Dashboard's tiles link here). The Dashboard keeps the
 * top 5. Before the plan is ready it says why, as Order plan does.
 *
 * POST /app/actions — the action list's writes (spec §5.1, §4 J5). JSON body:
 *   { op: "snooze" | "dismiss" | "done" | "undo", id }
 *   { op: "clear", id, kind, percent, endsOn, code }   (Growth: clearance)
 * Every write checks the action belongs to the session's shop. "clear" runs
 * only from the confirm dialog (invariant I-1), checks the plan on the
 * server, and never runs on sample data (services/data-scope).
 *
 * Handled outcomes answer 200 with `ok: false` and a reason (as the Settings
 * action does): a non-2xx Response returned to a fetcher becomes a route
 * error in React Router, and the dialog must show the message instead.
 */
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateApp } from "../services/data-scope.server";
import { can, planFor } from "../services/entitlements.server";
import { getActionList } from "../models/actions.server";
import { latestMoney, readiness } from "../models/dashboard.server";
import { MoneyFigure, useFmt } from "../components/money";
import { ACTIONS_MONEY, type MoneySnapshot } from "../lib/money-shared";
import { kehaPreorderInstalled } from "../services/keha-preorder.server";
import { ActionList } from "../components/action-list";
import { PlanNotReadyNote } from "../components/order-plan";
import { actionsHelp } from "../components/help";
import { AppPage } from "../components/ui";
import { useLinkProps } from "../components/wc";
import { useLocale } from "../lib/i18n";
import type { ActionListView } from "../lib/action-list-shared";
import type { PlanReadiness } from "../lib/dashboard-shared";
import { onlyParamChanged } from "../lib/revalidate-shared";
import { createClearanceDiscount } from "../services/clearance.server";
import { claimClearAction, getClearTarget, recordClearance, releaseClearAction, updateActionState } from "../models/actions.server";
import { isActionOp, type ActionOp } from "../lib/action-list-shared";
import { endOfLocalDay, validateClearForm, type ClearFormError } from "../lib/clearance-shared";
import { todayIn } from "../lib/dashboard-shared";
import { requiredPlan } from "../lib/plan-shared";

export type ActionsResult =
  | { ok: true; op: ActionOp; id: string }
  | { ok: true; op: "clear"; id: string; discountId: string }
  | { ok: false; error: "bad_request" | "not_found" | "failed" }
  | { ok: false; error: "invalid"; errors: Partial<Record<ClearFormError, true>> }
  | { ok: false; error: "shopify"; userErrors: string[] }
  | { ok: false; error: "upgrade"; upgrade: { feature: "clearance"; plan: string } }
  /** Sample data mode: no discount is created in the store (I-1). */
  | { ok: false; error: "sample" };

export type ActionsPageData = {
  readiness: PlanReadiness;
  list: ActionListView | null;
  timezone: string | null;
  /** Lost sales and sold-out page visits (clarity pass: moved here from the Dashboard). */
  money?: MoneySnapshot | null;
};

export const loader = async ({ request }: LoaderFunctionArgs): Promise<ActionsPageData> => {
  const { admin, shop, sample } = await authenticateApp(request);
  const now = new Date();
  const [plan, ready] = await Promise.all([planFor(shop), readiness(shop, now)]);
  const [list, money] = ready.ready
    ? await Promise.all([
        getActionList(shop, plan, now, { preorderInstalled: sample ? async () => false : () => kehaPreorderInstalled(admin, shop) }),
        latestMoney(shop).catch(() => null),
      ])
    : [null, null];
  return { readiness: ready, list, timezone: list?.timezone ?? null, money };
};

/** A tab switch on the Actions page (only ?tab= changes) reloads nothing (lib/revalidate-shared). */
export const shouldRevalidate: ShouldRevalidateFunction = ({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }) =>
  !formMethod && onlyParamChanged(currentUrl, nextUrl, "tab") ? false : defaultShouldRevalidate;

export const headers: HeadersFunction = (h) => boundary.headers(h);

export default function ActionsPage() {
  const { t } = useLocale();
  const link = useLinkProps();
  const data = useLoaderData<typeof loader>() as ActionsPageData;
  const notReady = data.readiness.ready ? null : data.readiness;
  return (
    <AppPage heading={t("Actions")} intro={t("Everything that needs you this week, ranked by the money at stake.")} help={actionsHelp(t)}>
      {notReady ? (
        <s-section heading={t("This week's actions")}>
          <s-stack direction="block" gap="base">
            <PlanNotReadyNote readiness={notReady} />
            <s-stack direction="inline">
              <s-button {...link("/app")}>{t("Back to Dashboard")}</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      ) : data.list ? (
        <>
          {data.money && <SoldOutCost money={data.money} />}
          <ActionList list={data.list} timezone={data.timezone} mode="full" />
        </>
      ) : (
        <s-section heading={t("This week's actions")}>
          <s-paragraph color="subdued">{t("Nothing to do this week. We'll tell you when something needs you.")}</s-paragraph>
        </s-section>
      )}
    </AppPage>
  );
}

const reply = (body: ActionsResult) => Response.json(body);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") throw new Response("Method not allowed", { status: 405 });
  const { admin, shop, sample } = await authenticateApp(request);
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return reply({ ok: false, error: "bad_request" });
  }
  const id = typeof body.id === "string" && body.id.length > 0 && body.id.length <= 64 ? body.id : null;
  if (!id) return reply({ ok: false, error: "bad_request" });
  const now = new Date();

  if (isActionOp(body.op)) {
    const done = await updateActionState(shop, id, body.op, now);
    if (!done) return reply({ ok: false, error: "not_found" });
    return reply({ ok: true, op: body.op, id });
  }

  if (body.op !== "clear") return reply({ ok: false, error: "bad_request" });
  // Sample data never reaches the store: no discount is created.
  if (sample) return reply({ ok: false, error: "sample" });

  if (!(await can(shop, "clearance"))) {
    return reply({ ok: false, error: "upgrade", upgrade: { feature: "clearance", plan: requiredPlan("clearance") } });
  }
  const target = await getClearTarget(shop, id);
  if (!target) return reply({ ok: false, error: "not_found" });

  const today = todayIn(target.timezone, now);
  const form = validateClearForm(
    { kind: String(body.kind ?? ""), percent: String(body.percent ?? ""), endsOn: String(body.endsOn ?? ""), code: String(body.code ?? "") },
    today,
  );
  if (!form.ok) return reply({ ok: false, error: "invalid", errors: form.errors });

  // Claim the action first (atomic live → done): a double submit or a second
  // tab gets "not_found" instead of creating a second discount in Shopify.
  if (!(await claimClearAction(shop, id, now))) return reply({ ok: false, error: "not_found" });
  const release = () => releaseClearAction(shop, target, now).catch((e) => console.error("[actions] clear release failed", shop, id, e));

  const startsAt = now;
  const endsAt = form.value.endsOn ? endOfLocalDay(form.value.endsOn, target.timezone) : null;
  let created;
  try {
    created = await createClearanceDiscount(admin, form.value, { productIds: [target.productId], startsAt, endsAt });
  } catch (e) {
    console.error("[actions] discount create failed", shop, e);
    await release();
    return reply({ ok: false, error: "failed" });
  }
  if (!created.ok) {
    await release();
    return reply({ ok: false, error: "shopify", userErrors: created.userErrors });
  }

  // The discount exists in Shopify now; a failed bookkeeping write must not
  // invite a second click that would create a second discount.
  try {
    await recordClearance(shop, target, form.value, { id: created.id, startsAt, endsAt }, now);
  } catch (e) {
    console.error("[actions] clearance record failed", shop, created.id, e);
    await updateActionState(shop, id, "done", now).catch(() => null);
  }
  return reply({ ok: true, op: "clear", id, discountId: created.id });
};

/** What sold-out products already cost (clarity pass 2026-10-23: from the Dashboard to here, next to the Stock gaps tab). */
function SoldOutCost({ money }: { money: MoneySnapshot }) {
  const { t } = useLocale();
  const fmt = useFmt(money.currency);
  return (
    <s-section heading={t("What sold-out products cost you")}>
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
        {ACTIONS_MONEY.map((key) => (
          <MoneyFigure key={key} cardKey={key} money={money} fmt={fmt} />
        ))}
      </s-grid>
    </s-section>
  );
}
