/**
 * Locations and stores (spec §3 `locations`, §4 J7, §5.5 Locations; Pro). Pure, client-safe.
 *
 *  - Role per location: warehouse | store | other. Shopify can't tell us reliably which
 *    locations are POS stores, so every location starts as "other" and the merchant sets it.
 *  - "Counts in supplier orders" (Location.onlinePool override): one include / leave-out
 *    toggle per active location, on EVERY plan (audit 2026-10-17: which stock counts is
 *    correctness, not a Pro feature). The rule itself lives in compute-shared
 *    (countsForOnline); the toggle only writes the override (see onlinePoolForInclude).
 *    Roles (warehouse / store) and per-location planning stay Pro.
 *  - Per-location planning covers ACTIVE locations with the role warehouse or store; their
 *    VariantMetric rows use scope = Location.id (compute-locations).
 *  - The location switcher (`?location=<Location.id>`) on Products and Reorder: only a
 *    planning location of this shop, only on Pro; anything else is the online stock pool.
 */
import { countsForOnline, SCOPE_ONLINE, type PoolLocation } from "./compute-shared";

type T = (s: string) => string;

export const LOCATION_ROLES = ["warehouse", "store", "other"] as const;
export type LocationRole = (typeof LOCATION_ROLES)[number];

/** Roles that get their own plan (per-location metrics, the switcher, transfers). */
export const PLANNING_ROLES: readonly LocationRole[] = ["warehouse", "store"];

export function isLocationRole(v: unknown): v is LocationRole {
  return typeof v === "string" && (LOCATION_ROLES as readonly string[]).includes(v);
}

/** Unknown stored values read as "other" (the schema default). */
export function readRole(v: unknown): LocationRole {
  return isLocationRole(v) ? v : "other";
}

export function roleLabel(role: LocationRole, t: T): string {
  switch (role) {
    case "warehouse":
      return t("Warehouse");
    case "store":
      return t("Store");
    case "other":
      return t("Other");
  }
}

// ── "Counts for online sales" ─────────────────────────────────────────────

export type PoolChoice = "follow" | "yes" | "no";

export function poolChoiceOf(onlinePool: boolean | null | undefined): PoolChoice {
  return onlinePool === true ? "yes" : onlinePool === false ? "no" : "follow";
}

export function onlinePoolOf(choice: PoolChoice): boolean | null {
  return choice === "yes" ? true : choice === "no" ? false : null;
}

/**
 * The override to store for the include toggle. Leaving a location out writes `false`.
 * Including it keeps the current override when the location already counts (so an
 * untouched row keeps following the default rule), else writes `true`.
 */
export function onlinePoolForInclude(include: boolean, current: Omit<PoolLocation, "id">): boolean | null {
  if (!include) return false;
  return countsForOnline(current) ? (current.onlinePool ?? null) : true;
}

// ── Settings → Locations ─────────────────────────────────────────────────

export type LocationRecord = PoolLocation & { name: string; role: string };

export type LocationSettingsRow = {
  id: string;
  name: string;
  /** Shopify's fulfillsOnlineOrders. */
  online: boolean;
  role: LocationRole;
  pool: PoolChoice;
  /** Counts for online sales right now (override, else Shopify). */
  counts: boolean;
};

export function toSettingsRow(l: LocationRecord): LocationSettingsRow {
  return {
    id: l.id,
    name: l.name,
    online: l.online,
    role: readRole(l.role),
    pool: poolChoiceOf(l.onlinePool),
    counts: countsForOnline(l),
  };
}

/** Active locations, warehouses first, then stores, then the rest; by name inside a role. */
export function sortLocations<L extends { name: string; id: string; role: string }>(rows: readonly L[]): L[] {
  const rank = (r: string) => (r === "warehouse" ? 0 : r === "store" ? 1 : 2);
  return [...rows].sort((a, b) => rank(a.role) - rank(b.role) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

export type LocationUpdate = { id: string; role: LocationRole; onlinePool: boolean | null };

export type LocationsFormError = "invalid" | "unknown" | "emptyPool" | "rolesLocked";

/** At most this many rows per save (Shopify allows far fewer active locations). */
const MAX_ROWS = 500;

/**
 * The posted rows `{ id, role, include }` → updates. Every row must be one of `active`
 * (this shop's active locations) with a known role and a boolean include. Below Pro
 * (`rolesAllowed` false) a row's role must stay what it is ("rolesLocked" otherwise); the
 * include toggle works on every plan. Refuses a save that leaves no active location
 * counted (every number would disappear). Locations not posted keep their settings.
 */
export function validateLocationsForm(
  raw: unknown,
  active: readonly (PoolLocation & { role?: string })[],
  opts: { rolesAllowed: boolean } = { rolesAllowed: true },
): { ok: true; updates: LocationUpdate[] } | { ok: false; error: LocationsFormError } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ROWS) return { ok: false, error: "invalid" };
  const byId = new Map(active.map((l) => [l.id, l]));
  const updates = new Map<string, LocationUpdate>();
  for (const r of raw) {
    if (!r || typeof r !== "object") return { ok: false, error: "invalid" };
    const { id, role, include } = r as Record<string, unknown>;
    if (typeof id !== "string" || !isLocationRole(role) || typeof include !== "boolean") return { ok: false, error: "invalid" };
    const current = byId.get(id);
    if (!current) return { ok: false, error: "unknown" };
    if (!opts.rolesAllowed && role !== readRole(current.role)) return { ok: false, error: "rolesLocked" };
    updates.set(id, { id, role, onlinePool: onlinePoolForInclude(include, current) });
  }
  const after = active.map((l) => {
    const u = updates.get(l.id);
    return u ? { ...l, onlinePool: u.onlinePool } : l;
  });
  if (after.length > 0 && !after.some(countsForOnline)) return { ok: false, error: "emptyPool" };
  return { ok: true, updates: [...updates.values()] };
}

export function locationsErrorText(error: LocationsFormError, t: T): string {
  switch (error) {
    case "invalid":
      return t("Something in the form isn't valid. Reload the page and try again.");
    case "unknown":
      return t("A location changed in Shopify. Reload the page and try again.");
    case "emptyPool":
      return t("At least one location must count in supplier orders.");
    case "rolesLocked":
      return t("Warehouse and store roles are on the Pro plan.");
  }
}

// ── Planning locations and the switcher ──────────────────────────────────

export type PlanningLocation = { id: string; name: string; role: LocationRole };

/** Active warehouses and stores (the ones with their own plan). */
export function planningLocations(rows: readonly { id: string; name: string; active: boolean; role: string }[]): PlanningLocation[] {
  return sortLocations(
    rows
      .filter((l) => l.active && (PLANNING_ROLES as readonly string[]).includes(l.role))
      .map((l) => ({ id: l.id, name: l.name, role: readRole(l.role) })),
  );
}

const LOCATION_GID = /^gid:\/\/shopify\/Location\/\d{1,20}$/;

/** `?location=` → a Location gid (numeric ids accepted), else null. */
export function parseLocationParam(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (LOCATION_GID.test(s)) return s;
  if (/^\d{1,20}$/.test(s)) return `gid://shopify/Location/${s}`;
  return null;
}

export type ScopeView = { scope: string; location: PlanningLocation | null };

/**
 * The scope a screen shows: the requested location when the plan includes `locations` and
 * it is one of this shop's planning locations; otherwise the online stock pool (a non-Pro
 * store's `?location=` is ignored, never an error).
 */
export function resolveScope(requested: string | null, enabled: boolean, allowed: readonly PlanningLocation[]): ScopeView {
  if (!enabled || !requested) return { scope: SCOPE_ONLINE, location: null };
  const hit = allowed.find((l) => l.id === requested);
  return hit ? { scope: hit.id, location: hit } : { scope: SCOPE_ONLINE, location: null };
}

/** The numeric tail of a Location gid (short URLs). */
export function locationNumericId(gid: string): string {
  const m = /(\d+)$/.exec(gid);
  return m ? m[1]! : gid;
}
