/**
 * Locations (Settings → Locations, the location switcher, transfers — spec §5.5, J7).
 * Database only. The catalog sync never overwrites `role` or `onlinePool`
 * (services/sync/catalog.server upsertLocation writes name / active / online only).
 */
import prisma from "../db.server";
import { POOL_LOCATION_SELECT } from "../lib/compute-shared";
import {
  planningLocations,
  sortLocations,
  toSettingsRow,
  type LocationSettingsRow,
  type LocationUpdate,
  type PlanningLocation,
} from "../lib/locations-shared";

const SELECT = { ...POOL_LOCATION_SELECT, name: true, role: true } as const;

/** This shop's active locations, for Settings → Locations. */
export async function listLocationSettings(shop: string): Promise<LocationSettingsRow[]> {
  const rows = await prisma.location.findMany({ where: { shop, active: true }, select: SELECT });
  return sortLocations(rows.map(toSettingsRow));
}

/** Active locations with the pool fields (validation input). */
export async function activeLocations(shop: string) {
  return prisma.location.findMany({ where: { shop, active: true }, select: SELECT });
}

/** Saves roles and "counts for online sales". Only this shop's locations are touched. */
export async function saveLocationSettings(shop: string, updates: readonly LocationUpdate[]): Promise<number> {
  if (!updates.length) return 0;
  const results = await prisma.$transaction(
    updates.map((u) =>
      prisma.location.updateMany({ where: { id: u.id, shop }, data: { role: u.role, onlinePool: u.onlinePool } }),
    ),
  );
  return results.reduce((a, r) => a + r.count, 0);
}

/** Active warehouses and stores: the switcher's choices and the transfer plan's ends. */
export async function listPlanningLocations(shop: string): Promise<PlanningLocation[]> {
  const rows = await prisma.location.findMany({ where: { shop }, select: { id: true, name: true, active: true, role: true } });
  return planningLocations(rows);
}
