/**
 * S4 (Kanwar 2026-10-18): settings in plain words, one click from where they matter. "Order cycle"
 * is "Order enough for" everywhere a merchant reads it, and "Why this quantity" links to the
 * settings behind its terms (safety stock and order days; lead time, case pack, minimums).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { WhyPopover } from "../app/components/order-plan";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|ts)$/.test(f) ? [p] : [];
  });
}

describe("settings in plain words", () => {
  it("no merchant-facing string says order cycle", () => {
    const hits: string[] = [];
    for (const f of files("app")) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/t\("((?:[^"\\]|\\.)*)"\)/g)) if (/order cycle|one cycle/i.test(m[1]!)) hits.push(`${f}: ${m[1]}`);
      for (const m of src.matchAll(/(?:label|hint): "((?:[^"\\]|\\.)*)"/g)) if (/order cycle/i.test(m[1]!)) hits.push(`${f}: ${m[1]}`);
    }
    expect(hits).toEqual([]);
  });

  it("Why this quantity links to Settings and Suppliers", () => {
    const why = { day: 0, days: 28, demand: 56, rate: 2, season: 1, growth: 1, safety: 10, onHand: 5, onOrder: 3, need: 58, rounded: 60, pack: 12, moq: 50, topUp: 0 };
    const Stub = createRoutesStub([{ path: "/", Component: () => <WhyPopover id="w1" title="Tee" whys={[why]} lastYear={null} qty={60} /> }]);
    const html = renderToString(<Stub initialEntries={["/"]} />);
    expect(html).toContain("Change the numbers behind this:");
    expect(html).toContain('href="/app/settings?more=1"');
    expect(html).toContain('href="/app/settings/suppliers"');
  });
});
