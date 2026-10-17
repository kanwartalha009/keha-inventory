/**
 * /privacy and /terms (task 2.7; playbook §8 "privacy and terms match the code", mistake #20):
 *  - every scope in shopify.app.toml has one plain sentence, and nothing else is listed;
 *  - the periods the pages state are the ones the code enforces;
 *  - the email provider named is the API the app really sends through;
 *  - both pages render the facts (SSR).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import Privacy, { loader as privacyLoader } from "../app/routes/privacy";
import Terms, { loader as termsLoader } from "../app/routes/terms";
import { LEGAL_FACTS, OUTBOX_SENT_RETENTION_DAYS, PURGE_AFTER_HOURS, SCOPE_PURPOSES, emailProvider } from "../app/lib/legal.server";
import { CONFIRM_LINK_DAYS } from "../app/lib/purchase-order-shared";
import { RETENTION_MONTHS } from "../app/lib/sync/store-time-shared";
import { PII_LOG_RETENTION_DAYS } from "../app/lib/pii-log-shared";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function render(path: string, Component: () => JSX.Element, data: unknown) {
  const Stub = createRoutesStub([{ id: "page", path, Component, loader: () => data }]);
  // React's text-node separators removed, so assertions read like the page.
  return renderToString(<Stub initialEntries={[path]} hydrationData={{ loaderData: { page: data } }} />).replace(/<!-- -->/g, "");
}

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe("legal facts match the code", () => {
  it("explains every requested scope, and only those", () => {
    const toml = read("shopify.app.toml").match(/^scopes\s*=\s*"([^"]*)"/m)?.[1] ?? "";
    const scopes = toml.split(",").map((s) => s.trim()).filter(Boolean).sort();
    expect(Object.keys(SCOPE_PURPOSES).sort()).toEqual(scopes);
    for (const why of Object.values(SCOPE_PURPOSES)) expect(why.length).toBeGreaterThan(20);
  });

  it("states the periods the code enforces", () => {
    expect(LEGAL_FACTS.dailyFactsMonths).toBe(RETENTION_MONTHS);
    expect(LEGAL_FACTS.accessLogDays).toBe(PII_LOG_RETENTION_DAYS);
    expect(LEGAL_FACTS.confirmLinkDays).toBe(CONFIRM_LINK_DAYS);
    const purge = read("app/services/gdpr.server.ts").match(/export const PURGE_AFTER_MS = (\d+) \* 60 \* 60 \* 1000;/);
    expect(Number(purge?.[1])).toBe(PURGE_AFTER_HOURS);
    const outbox = read("app/lib/nova.server.ts").match(/export const SENT_RETENTION_MS = (\d+) \* 24 \* 60 \* 60 \* 1000;/);
    expect(Number(outbox?.[1])).toBe(OUTBOX_SENT_RETENTION_DAYS);
  });

  it("names the email provider from the API the app sends through", () => {
    expect(emailProvider(undefined)).toBe("Resend"); // email.server's default
    expect(emailProvider("https://api.resend.com/emails")).toBe("Resend");
    expect(emailProvider("https://api.postmarkapp.com/email")).toBe("Postmark");
    expect(emailProvider("https://mail.example.org/send")).toBe("mail.example.org");
    expect(read("app/services/email.server.ts")).toContain('"https://api.resend.com/emails"');
  });
});

describe("/privacy", () => {
  it("renders what the app stores, sends and deletes", async () => {
    process.env.INVENTORY_SUPPORT_EMAIL = "privacy@example.com";
    process.env.INVENTORY_LEGAL_NAME = "Example Ltd";
    const html = render("/privacy", Privacy, await privacyLoader());
    for (const scope of Object.keys(SCOPE_PURPOSES)) expect(html).toContain(scope);
    expect(html).toContain("stores no shopper names");
    expect(html).toContain("encrypted at rest (AES-256-GCM)");
    expect(html).toContain("stops working 60 days after the order is sent");
    expect(html).toContain("older than 25 months are deleted");
    expect(html).toContain("48 hours later");
    expect(html).toContain("kept for 90 days");
    expect(html).toContain("Resend");
    expect(html).toContain("Railway");
    expect(html).toContain("Product needs reorder");
    expect(html).toContain("Shopify Sidekick");
    expect(html).toContain("it collects nothing new and changes nothing in");
    expect(html).toContain("Transfers are created as drafts");
    expect(html).toContain("Season plan scenarios");
    expect(html).toContain("privacy@example.com");
    expect(html).toContain("Example Ltd");
    expect(html).not.toContain("rolled up");
  });
});

describe("/terms", () => {
  it("renders the confirm rule, the supplier link and the purge", () => {
    delete process.env.INVENTORY_SUPPORT_EMAIL;
    const html = render("/terms", Terms, termsLoader());
    expect(html).toContain("changes nothing in the store until the merchant confirms");
    expect(html).toContain("stock transfers are created as drafts");
    expect(html).toContain("stops working 60 days after the order is sent");
    expect(html).toContain("deleted 48 hours after uninstall");
    expect(html).toContain("support@keha.io");
  });
});
