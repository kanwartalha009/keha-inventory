/**
 * Asking for an App Store review (App Bridge `shopify.reviews.request()`, audit 2026-10-17).
 * Pure, client-safe.
 *
 * Shopify's rules (shopify.dev/docs/api/app-bridge-library/apis/reviews): never within 24 h of
 * install, not on a merchant's click (the modal may be rate-limited and the app would look
 * broken), at the end of a successful workflow; Shopify itself shows it at most once per 60 days
 * and three times a year. Our rules on top:
 *  - only after a success moment: the first supplier confirmation received, the store-total
 *    forecast within ACCURACY_TARGET_PCT last month, or the first clearance discount created;
 *  - on the next app open (the Dashboard loads), never from Sidekick or an email;
 *  - once: "asked at" is kept in Shop.settings JSON (`reviewAsk`), so we don't ask again;
 *  - neutral: Shopify's own modal, no text of ours and no incentive.
 */

/** The store-total forecast error (AccuracyMonth.storeErrorPct) that counts as "within target". */
export const ACCURACY_TARGET_PCT = 20;

/** Shopify refuses within 24 h of install; we wait the same. */
export const REVIEW_MIN_INSTALL_MS = 24 * 60 * 60 * 1000;

export type ReviewMoment = "supplier_confirmed" | "accuracy" | "clearance";

export type ReviewAskState = { askedAt: string; code: string } | null;

/** Shop.settings.reviewAsk, defensively. */
export function readReviewAsk(settings: unknown): ReviewAskState {
  const s = settings && typeof settings === "object" ? (settings as Record<string, unknown>).reviewAsk : null;
  if (!s || typeof s !== "object") return null;
  const r = s as Record<string, unknown>;
  return typeof r.askedAt === "string" && r.askedAt ? { askedAt: r.askedAt, code: typeof r.code === "string" ? r.code : "" } : null;
}

/** The first success moment that happened (in this order), or null. */
export function reviewMoment(facts: {
  supplierConfirmations: number;
  lastStoreErrorPct: number | null;
  clearances: number;
}): ReviewMoment | null {
  if (facts.supplierConfirmations > 0) return "supplier_confirmed";
  const e = facts.lastStoreErrorPct;
  if (e !== null && Number.isFinite(e) && e >= 0 && e <= ACCURACY_TARGET_PCT) return "accuracy";
  if (facts.clearances > 0) return "clearance";
  return null;
}

/** Should this app open ask for a review? */
export function shouldAskForReview(input: {
  installedAt: Date | string | null;
  now: Date;
  asked: ReviewAskState;
  moment: ReviewMoment | null;
}): boolean {
  if (input.asked || !input.moment || !input.installedAt) return false;
  const at = new Date(input.installedAt).getTime();
  return Number.isFinite(at) && input.now.getTime() - at >= REVIEW_MIN_INSTALL_MS;
}

/**
 * Which answers mean "don't ask again": the modal was shown, or Shopify won't show it to this
 * merchant for a long time. Transient answers (on mobile, already opening, cancelled, our install
 * date off) leave it for the next open.
 */
const FINAL_CODES = new Set(["success", "already-reviewed", "annual-limit-reached", "cooldown-period", "merchant-ineligible"]);

export function isFinalReviewCode(code: unknown): boolean {
  return typeof code === "string" && FINAL_CODES.has(code);
}

/** Delay after the page settles, so the modal never lands on a click or mid-task. */
export const REVIEW_ASK_DELAY_MS = 4000;
