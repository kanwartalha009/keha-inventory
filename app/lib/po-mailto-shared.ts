/**
 * "Open in your email" (owner decision 2026-10-18: no paid email provider): the purchase order as
 * a `mailto:` link the merchant opens in their own email app, so the supplier sees the merchant's
 * real address and replies straight to them. Works with no email transport configured.
 *
 * The text is in the supplier's PO language (Settings → Suppliers; English by default), like the
 * email Keha sends when a provider is set: greeting, the lines, the totals, ship-to / terms /
 * Incoterms / dates / note (po-document-shared poDetailRows), the supplier link (confirm the ship
 * date, download the PDF or CSV) and a sign-off with the store's name.
 *
 * Length: email apps and browsers cut long `mailto:` links (some at ~2,000 characters), so the
 * whole URL is kept under MAILTO_MAX. Lines are dropped from the end first ("+3 more lines in the
 * order link"); if the details alone are still too long they are shortened with "…". The link and
 * the sign-off are never cut.
 *
 * Pure: `tr` translates into the PO language.
 */
import { fill, plural } from "./i18n";
import { detailText, type PoDetailRow } from "./po-document-shared";
import { supplierLineText, supplierTotalText, type SupplierEmailInput } from "./po-email-shared";

type T = (s: string) => string;

/** The longest `mailto:` URL we build (characters, after encoding). */
export const MAILTO_MAX = 1800;

export type SupplierMailtoInput = Omit<SupplierEmailInput, "confirmUrl"> & {
  /** The supplier's email; null / unusable = the merchant types it in their email app. */
  to: string | null;
  /** The supplier page; null when the plan has no supplier link (then the merchant attaches the PDF). */
  confirmUrl: string | null;
  /** Override for tests. */
  max?: number;
};

export type SupplierMailto = {
  /** The address used ("" when none). */
  to: string;
  subject: string;
  /** The plain-text body, line breaks as "\n" (shown in the app and copied). */
  body: string;
  url: string;
  /** Lines written into the email, and lines left out to keep the link short. */
  shownLines: number;
  moreLines: number;
  /** The order details had to be shortened too. */
  detailsCut: boolean;
};

/**
 * A plain address only: anything with characters that would change the mailto URL's meaning
 * (?, &, #, %, spaces, quotes, angle brackets, commas) is refused rather than encoded.
 */
export function mailtoAddress(raw: string | null | undefined): string {
  const a = (raw ?? "").trim();
  return /^[^\s@?&#%<>"',;:()[\]\\]+@[^\s@?&#%<>"',;:()[\]\\]+\.[^\s@?&#%<>"',;:()[\]\\]+$/.test(a) && a.length <= 254 ? a : "";
}

/**
 * RFC 6068: subject and body percent-encoded (spaces as %20, never "+"), line breaks as %0D%0A.
 */
export function mailtoUrl(to: string, subject: string, body: string): string {
  const enc = (s: string) => encodeURIComponent(s.replace(/\r?\n/g, "\r\n"));
  return `mailto:${to}?subject=${enc(subject)}&body=${enc(body)}`;
}

export function supplierMailto(input: SupplierMailtoInput, tr: T): SupplierMailto {
  const max = input.max ?? MAILTO_MAX;
  const to = mailtoAddress(input.to);
  const subject = fill(tr("Purchase order {number} from {store}"), { number: input.number, store: input.storeName });
  const greeting = input.supplierName ? fill(tr("Hello {name},"), { name: input.supplierName }) : tr("Hello,");
  const intro = fill(tr("{store} would like to order the items below."), { store: input.storeName });
  const lines = input.lines.map((l) => `- ${supplierLineText(l, input, tr)}`);
  const total = supplierTotalText(input, tr);
  const details = (input.details ?? []).map((r: PoDetailRow) => detailText(r));
  const linkPart = input.confirmUrl
    ? [tr("Confirm the ship date at this link. You can also download the order there as a PDF or CSV:"), input.confirmUrl]
    : [tr("The order is attached as a PDF.")];
  const signOff = [tr("Thank you,"), input.storeName];

  const more = (n: number) =>
    fill(
      input.confirmUrl
        ? plural(n, tr("+1 more line in the order link"), tr("+{n} more lines in the order link"))
        : plural(n, tr("+1 more line in the attached PDF"), tr("+{n} more lines in the attached PDF")),
      { n: new Intl.NumberFormat(input.locale).format(n) },
    );

  const build = (shown: number, detailBlock: string[]) => {
    const body = [
      greeting,
      "",
      intro,
      "",
      ...lines.slice(0, shown),
      ...(shown < lines.length ? [more(lines.length - shown)] : []),
      "",
      total,
      ...(detailBlock.length ? ["", ...detailBlock] : []),
      "",
      ...linkPart,
      "",
      ...signOff,
    ].join("\n");
    return { body, url: mailtoUrl(to, subject, body) };
  };

  // 1. Every line; else drop lines from the end (at least the "+N more" note says so).
  for (let shown = lines.length; shown >= 0; shown--) {
    const r = build(shown, details);
    if (r.url.length <= max) return { to, subject, ...r, shownLines: shown, moreLines: lines.length - shown, detailsCut: false };
  }
  // 2. No lines and still too long (a very long note or address): shorten the details block.
  const full = details.join("\n");
  let lo = 0;
  let hi = full.length;
  let best = build(0, []);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cut = mid > 0 ? `${full.slice(0, mid).trimEnd()}…` : "";
    const r = build(0, cut ? cut.split("\n") : []);
    if (r.url.length <= max) {
      best = r;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return { to, subject, ...best, shownLines: 0, moreLines: lines.length, detailsCut: true };
}
