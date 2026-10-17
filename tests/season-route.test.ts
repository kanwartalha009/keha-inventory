/**
 * Season plan lives at /app/reorder/season (2026-10-17 click-through: at /app/planner the admin nav
 * highlighted "Dashboard", because it highlights by path prefix and the nav link is /app/reorder).
 * The old URL keeps working as a redirect with its query string.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loader, seasonPlanRedirect, SEASON_PLAN_PATH } from "../app/routes/app.planner";
import { ORDER_PLAN_TABS } from "../app/components/order-plan-tabs";
import { ORDER_PLAN_PATHS, PAGE_FEATURE, lockedPageFeature } from "../app/lib/plan-shared";

const root = join(__dirname, "..");

describe("Season plan route", () => {
  it("every Order plan tab sits under the nav link's path, so the admin highlights Order plan", () => {
    for (const tab of ORDER_PLAN_TABS) expect(tab.path === "/app/reorder" || tab.path.startsWith("/app/reorder/"), tab.id).toBe(true);
    expect(ORDER_PLAN_TABS.find((x) => x.id === "season")!.path).toBe("/app/reorder/season");
    expect(SEASON_PLAN_PATH).toBe("/app/reorder/season");
    expect(ORDER_PLAN_PATHS).toContain("/app/reorder/season");
    expect(ORDER_PLAN_PATHS).not.toContain("/app/planner");
  });

  it("the route file doesn't nest under Order now nor collide with a purchase order id", () => {
    // app.reorder_.season.tsx: "_" opts out of the /app/reorder layout; a static segment wins over $id.
    expect(existsSync(join(root, "app/routes/app.reorder_.season.tsx"))).toBe(true);
    expect(existsSync(join(root, "app/routes/app.reorder_.$id.tsx"))).toBe(true);
    const src = readFileSync(join(root, "app/routes/app.reorder_.season.tsx"), "utf8");
    expect(src).not.toContain('"/app/planner');
    expect(src).toContain("/app/reorder/season?edit=new");
  });

  it("/app/planner redirects to /app/reorder/season, query string kept", async () => {
    expect(seasonPlanRedirect("https://app.test/app/planner")).toBe("/app/reorder/season");
    expect(seasonPlanRedirect("https://app.test/app/planner?scenario=abc&shop=x.myshopify.com&host=aGk")).toBe(
      "/app/reorder/season?scenario=abc&shop=x.myshopify.com&host=aGk",
    );
    const res = (await loader({ request: new Request("https://app.test/app/planner?edit=new"), params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/app/reorder/season?edit=new");
  });

  it("plan gating: the tab teaches inside (never the lock page); Season plan's own feature is planner", () => {
    expect(lockedPageFeature("/app/reorder/season", "free")).toBeNull();
    expect(PAGE_FEATURE[0]).toEqual({ path: "/app/reorder/season", feature: "planner" });
  });

  it("no link in the app, docs or scripts points at /app/planner any more (only the redirect route)", () => {
    const files = [
      "app/components/order-plan-tabs.tsx",
      "app/lib/sidekick-shared.ts",
      "app/lib/plan-shared.ts",
      "app/lib/monday-shared.ts",
      "app/services/monday.server.ts",
      "app/routes/app.reorder.tsx",
      "app/routes/app._index.tsx",
      "scripts/preview.tsx",
      "README.md",
      "docs/listing/LISTING.md",
      "docs/listing/REVIEWER.md",
      "docs/listing/SCREENSHOTS.md",
      "extensions/keha-inventory-sidekick/instructions.md",
    ];
    for (const f of files) expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/\/app\/planner(?![^\n]*redirect)/);
  });
});
