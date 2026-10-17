/**
 * Module stand-ins for the end-to-end simulation tests (each test file wires them with vi.mock):
 * the Shopify session (`state.shop` is the store the request is for), the plan, the email
 * transport (sent emails are kept) and the store owner read. Nothing else is replaced: the
 * routes, models, services and the engine are the real ones.
 */
import { featureMap, hasFeature, requiredPlan, type Feature, type PlanCode } from "../../app/lib/plan-shared";
import { isSampleKey, samplePlan } from "../../app/lib/sample-mode-shared";

export const state = {
  /** The store the next request authenticates as (session.shop). */
  shop: "",
  /** The plan of every store (sample keys: samplePlan of it). */
  plan: "growth" as PlanCode,
  emails: [] as { to: unknown; subject: string; html?: string; text?: string }[],
  /** Admin GraphQL calls made (nothing in these tests may reach Shopify's write APIs). */
  graphql: [] as string[],
};

const planOf = (shop: string): PlanCode => (isSampleKey(shop) ? samplePlan(state.plan) : state.plan);

/** An Admin API client that answers the reads the email path makes and records every call. */
export const fakeAdmin = {
  graphql: async (query: string) => {
    state.graphql.push(query);
    return new Response(JSON.stringify({ data: { shop: { name: "Sim Store", email: "owner@sim.test", contactEmail: null }, shopLocales: [{ locale: "en", primary: true, published: true }] } }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};

export const shopifyMock = () => ({
  authenticate: {
    admin: async () => ({ session: { shop: state.shop }, admin: fakeAdmin, cors: (r: Response) => r, redirect: (to: string) => new Response(null, { status: 302, headers: { Location: to } }) }),
  },
  unauthenticated: { admin: async () => ({ admin: fakeAdmin }) },
});

export const entitlementsMock = () => ({
  getEntitlements: async (shop: string) => {
    const plan = planOf(shop);
    return { plan, features: featureMap(plan), comped: false, checked: true };
  },
  planFor: async (shop: string) => planOf(shop),
  can: async (shop: string, f: Feature) => hasFeature(planOf(shop), f),
  forgetEntitlements: () => {},
  upgradeResponse: (feature: Feature, message: string) => Response.json({ ok: false, error: message, upgrade: { feature, plan: requiredPlan(feature) } }, { status: 403 }),
});

export const emailMock = () => ({
  emailTransportConfigured: () => true,
  sendEmail: async (m: { to: unknown; subject: string; html?: string; text?: string }) => {
    state.emails.push(m);
    return { ok: true, id: `email-${state.emails.length}` };
  },
});
