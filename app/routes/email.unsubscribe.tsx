/**
 * /email/unsubscribe?token=… — the Monday email's unsubscribe link (spec §11).
 * Public: no Shopify auth; the sealed token (purpose "monday-unsub", 180 days)
 * names the store.
 *
 * GET only shows a confirm page, so a mail scanner that opens the link never
 * unsubscribes anyone. POST turns settings.mondayEmail.enabled off on the Shop
 * row, keeping every other setting. Shown in the store's language.
 */
import type { CSSProperties } from "react";
import { Form, useActionData, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { fill, toSupportedLocale, translate, type Locale } from "../lib/i18n";
import { unseal } from "../lib/seal.server";
import { MONDAY_UNSUB_PURPOSE } from "../lib/monday-shared";

type PageData =
  | { state: "confirm"; locale: Locale; shop: string; token: string }
  | { state: "done"; locale: Locale; shop: string }
  | { state: "invalid"; locale: Locale };

function browserLocale(request: Request): Locale {
  return toSupportedLocale(request.headers.get("Accept-Language"));
}

async function resolve(request: Request, token: string | null) {
  const data = token ? unseal<{ shop?: unknown }>(MONDAY_UNSUB_PURPOSE, token) : null;
  const shop = data && typeof data.shop === "string" ? data.shop : null;
  if (!shop) return { shop: null, row: null, locale: browserLocale(request) };
  const row = await prisma.shop.findUnique({ where: { domain: shop } });
  return { shop, row, locale: row ? toSupportedLocale(row.locale) : browserLocale(request) };
}

export const loader = async ({ request }: LoaderFunctionArgs): Promise<PageData> => {
  const token = new URL(request.url).searchParams.get("token");
  const { shop, locale } = await resolve(request, token);
  if (!shop || !token) return { state: "invalid", locale };
  return { state: "confirm", locale, shop, token };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<PageData> => {
  const form = await request.formData().catch(() => null);
  const fromForm = form?.get("token");
  const token = typeof fromForm === "string" && fromForm ? fromForm : new URL(request.url).searchParams.get("token");
  const { shop, row, locale } = await resolve(request, token);
  if (!shop) return { state: "invalid", locale };
  if (row) {
    const raw = row.settings && typeof row.settings === "object" && !Array.isArray(row.settings)
      ? (row.settings as Record<string, unknown>)
      : {};
    const me = raw.mondayEmail && typeof raw.mondayEmail === "object" && !Array.isArray(raw.mondayEmail)
      ? (raw.mondayEmail as Record<string, unknown>)
      : {};
    await prisma.shop.update({
      where: { domain: shop },
      data: { settings: { ...raw, mondayEmail: { ...me, enabled: false } } },
    });
  }
  return { state: "done", locale, shop };
};

const page: CSSProperties = {
  maxWidth: 520,
  margin: "64px auto",
  padding: "32px 24px",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  lineHeight: 1.5,
  color: "#1a1a1a",
  background: "#ffffff",
  borderRadius: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
};

export default function EmailUnsubscribe() {
  const loaded = useLoaderData<typeof loader>();
  const acted = useActionData<typeof action>();
  const data: PageData = acted ?? loaded;
  const tr = (key: string) => translate(data.locale, key);

  return (
    <main lang={data.locale} style={page}>
      <p style={{ margin: 0, color: "#616161", fontSize: 13 }}>Keha Inventory Intelligence</p>
      {data.state === "confirm" ? (
        <>
          <h1 style={{ fontSize: 22, margin: "8px 0 12px" }}>{tr("Stop the Monday email?")}</h1>
          <p>
            {fill(
              tr("{store} will stop getting the weekly money summary. You can turn it back on any time in the app's Settings."),
              { store: data.shop },
            )}
          </p>
          <Form method="post">
            <input type="hidden" name="token" value={data.token} />
            <button
              type="submit"
              style={{
                background: "#1a1a1a",
                color: "#ffffff",
                border: 0,
                borderRadius: 8,
                padding: "10px 18px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {tr("Unsubscribe")}
            </button>
          </Form>
        </>
      ) : data.state === "done" ? (
        <>
          <h1 style={{ fontSize: 22, margin: "8px 0 12px" }}>{tr("You're unsubscribed")}</h1>
          <p>
            {fill(
              tr("{store} won't get the Monday email any more. You can turn it back on any time in the app's Settings."),
              { store: data.shop },
            )}
          </p>
        </>
      ) : (
        <>
          <h1 style={{ fontSize: 22, margin: "8px 0 12px" }}>{tr("This link isn't valid any more")}</h1>
          <p>{tr("Open the app and turn off the Monday email in Settings instead.")}</p>
        </>
      )}
    </main>
  );
}
