/**
 * Email transport for store-owner emails (the Monday email, data-request
 * answers). Keha never emails shoppers.
 *
 * Provider-agnostic: configured by env. The default shape targets a Resend-style
 * JSON API (`from`, `to`, `subject`, `text`); swap the URL/body for SendGrid,
 * Postmark, SES, etc. If unconfigured, we return a FAILED result with a reason —
 * never a silent success.
 *
 *   INVENTORY_EMAIL_API_URL   default https://api.resend.com/emails
 *   INVENTORY_EMAIL_API_KEY   bearer token for the provider
 *   INVENTORY_EMAIL_FROM      verified sender, e.g. "Keha <mail@keha.io>"
 */

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  /** Display name for the From line (the store's name); the address stays INVENTORY_EMAIL_FROM. */
  fromName?: string;
  /** Extra headers, e.g. List-Unsubscribe (Resend `headers` field). */
  headers?: Record<string, string>;
};

/**
 * "Store Name <verified@address>" from INVENTORY_EMAIL_FROM ("Name <addr>" or
 * "addr"). Quotes / angle brackets / line breaks are stripped from the name.
 * Exported for tests.
 */
export function fromWithName(from: string, name?: string): string {
  const clean = (name ?? "").replace(/["<>\r\n]/g, "").trim().slice(0, 80);
  if (!clean) return from;
  const addr = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  return `"${clean}" <${addr}>`;
}

export type SendResult = { ok: true } | { ok: false; reason: string };

export function emailTransportConfigured(): boolean {
  return Boolean(process.env.INVENTORY_EMAIL_API_KEY && process.env.INVENTORY_EMAIL_FROM);
}

export async function sendEmail(input: SendEmailInput): Promise<SendResult> {
  const apiKey = process.env.INVENTORY_EMAIL_API_KEY ?? "";
  const from = process.env.INVENTORY_EMAIL_FROM ?? "";
  const url = process.env.INVENTORY_EMAIL_API_URL || "https://api.resend.com/emails";

  if (!apiKey || !from) {
    return {
      ok: false,
      reason:
        "no_transport: set INVENTORY_EMAIL_API_KEY + INVENTORY_EMAIL_FROM to enable store-owner emails",
    };
  }
  if (!input.to) return { ok: false, reason: "no_recipient" };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromWithName(from, input.fromName),
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `provider_${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: `transport_error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
