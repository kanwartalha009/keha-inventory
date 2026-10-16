/**
 * Shopify Flow trigger sender (spec §11, task 2.6): `flowTriggerReceive` with
 * the trigger's handle and a payload whose keys match its extension toml
 * (lib/flow-shared FLOW_FIELDS). Called from the hourly alerts job on Growth.
 *
 * Results: "ok"; "rejected" = Shopify answered with userErrors (e.g. no
 * workflow uses the trigger, or the extension isn't deployed) — a definite
 * answer, so the episode counts as fired and it isn't retried every hour;
 * "error" = network / throttle / auth — not recorded, tried again next tick.
 */
import { FLOW_FIELDS, payloadMatches, type FlowHandle } from "../lib/flow-shared";

const FLOW_TRIGGER = `#graphql
  mutation KehaInvFlowTrigger($handle: String, $payload: JSON) {
    flowTriggerReceive(handle: $handle, payload: $payload) {
      userErrors {
        field
        message
      }
    }
  }`;

export type AdminGraphql = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{ json: () => Promise<unknown> }>;
};

export type FlowFireResult = { status: "ok" } | { status: "rejected" | "error"; error: string };

export async function fireFlowTrigger(admin: AdminGraphql, handle: FlowHandle, payload: Record<string, unknown>): Promise<FlowFireResult> {
  if (!payloadMatches(handle, payload)) {
    return { status: "rejected", error: `payload keys must be exactly: ${FLOW_FIELDS[handle].join(", ")}` };
  }
  try {
    const res = await admin.graphql(FLOW_TRIGGER, { variables: { handle, payload } });
    const body = (await res.json()) as {
      data?: { flowTriggerReceive?: { userErrors?: { field?: string[] | null; message: string }[] } | null };
      errors?: unknown;
    };
    if (body.errors) return { status: "error", error: JSON.stringify(body.errors).slice(0, 300) };
    const errs = body.data?.flowTriggerReceive?.userErrors ?? [];
    if (errs.length) return { status: "rejected", error: errs.map((e) => e.message).join("; ").slice(0, 300) };
    return { status: "ok" };
  } catch (e) {
    return { status: "error", error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}
