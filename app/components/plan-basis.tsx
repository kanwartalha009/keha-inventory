/**
 * "How we plan: …" — the store's planning rules said once under the page title (clarity pass
 * 2026-10-23, lib/plan-basis-shared), with a link to change them. Pages say only what differs
 * per product.
 */
import type { ReactNode } from "react";
import { useLocale } from "../lib/i18n";
import { planBasisParts, type PlanBasis } from "../lib/plan-basis-shared";
import { useLinkProps } from "./wc";

export function HowWePlan({ basis }: { basis: PlanBasis | null | undefined }) {
  const { t, locale } = useLocale();
  const link = useLinkProps();
  if (!basis) return null;
  return (
    <span className="keha-plan-basis">
      <s-text color="subdued">{`${t("How we plan:")} ${planBasisParts(basis, t, locale).join(" · ")}.`}</s-text>{" "}
      <s-link {...link("/app/settings?more=1")}>{t("Change")}</s-link>
    </span>
  );
}

/** A page intro: one plain sentence, then the How we plan line. */
export function IntroWithPlan({ text, basis }: { text: ReactNode; basis: PlanBasis | null | undefined }) {
  return (
    <s-stack direction="block" gap="small-100">
      <span>{text}</span>
      <HowWePlan basis={basis} />
    </s-stack>
  );
}
