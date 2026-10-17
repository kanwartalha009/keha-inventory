/**
 * Sample data mode (services/data-scope): every admin screen reads and writes the data key from
 * authenticateApp, never session.shop, so sample data and the store's own rows never mix. Only
 * the screens that act on the installed store itself read session.shop: billing (Plans, the
 * layout's plan sync), loading / removing sample data, the real store's alert settings (refused
 * while sample data is shown) and Sidekick (the real store only). A new admin route either uses
 * authenticateApp or is added here with its reason.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "app", "routes");

/** Routes that act on the installed store on purpose. */
const REAL_STORE: Record<string, string> = {
  "app.tsx": "layout: billing plan sync and the store's language",
  "app.plans.tsx": "billing is the installed store's",
  "app.sample.tsx": "loads / removes the store's sample data",
  "app.settings_.alerts.tsx": "the loader shows the real store's alerts; the action is refused on sample data",
};

describe("admin routes read the data key (sample data mode)", () => {
  const routes = readdirSync(DIR).filter((f) => /^app\..*\.tsx$/.test(f) || f === "app.tsx");

  it("every admin route authenticates through authenticateApp, or is listed as acting on the real store", () => {
    const offenders: string[] = [];
    for (const f of routes) {
      if (f in REAL_STORE) continue;
      const src = readFileSync(join(DIR, f), "utf8");
      // (A route that only redirects authenticates nothing and reads nothing.)
      if (/authenticate\.admin\(/.test(src) || /session\.shop/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("covers the newer screens: Import & export, its templates, Settings (budget), the supplier order builder", () => {
    for (const f of ["app.settings_.import.tsx", "app.settings_.import_.$file.tsx", "app.settings.tsx", "app.reorder_.build.tsx", "app.reorder_.calendar.tsx"]) {
      const src = readFileSync(join(DIR, f), "utf8");
      expect(src, f).toMatch(/authenticateApp\(/);
      expect(src, f).not.toMatch(/session\.shop/);
    }
  });
});
