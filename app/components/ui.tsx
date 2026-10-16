/**
 * Keha Inventory UI primitives — the design layer on top of Polaris web components.
 * Styles live in app/app.css (loaded by app/routes/app.tsx). Tiles keep the
 * @shopify/polaris-icons SVGs (the same icon set `<s-icon>` draws) so they can
 * take the tile's colour; everything else in the admin is an `<s-*>` element.
 */
import { cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useLinkProps } from "./wc";
import { UpgradeFromQuery } from "./plan";
import { useLocale } from "../lib/i18n";
import { formatPercent } from "../lib/dashboard-shared";
import { ProductIcon } from "@shopify/polaris-icons";

export type TileTone = "violet" | "teal" | "amber" | "rose" | "sky" | "emerald" | "slate";
type IconSource = React.FunctionComponent<React.SVGProps<SVGSVGElement>>;

/** Coloured rounded-square icon tile. */
export function IconTile({
  icon,
  tone = "violet",
  size = "md",
  className = "",
}: {
  icon: IconSource;
  tone?: TileTone;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const Svg = icon;
  return (
    <span
      className={`keha-tile keha-tile--${tone}${size !== "md" ? ` keha-tile--${size}` : ""} ${className}`.trim()}
      aria-hidden="true"
    >
      <Svg />
    </span>
  );
}

/** Staggered fade-up on mount. `index` sets the delay. */
export function Reveal({ index = 0, children, className = "" }: { index?: number; children: ReactNode; className?: string }) {
  return (
    <div className={`keha-reveal ${className}`.trim()} style={{ ["--i" as string]: index }}>
      {children}
    </div>
  );
}

/**
 * Count-up for numeric-looking values ("1,240", "PKR 0", "45%", "US$19.99").
 * Non-numeric strings render as-is. Respects prefers-reduced-motion.
 */
export function useCountUp(value: string, ms = 700): string {
  const [shown, setShown] = useState(value);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    const m = /^(.*?)(-?\d[\d,]*)(\.\d+)?(.*)$/.exec(value);
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!m || reduce) {
      setShown(value);
      return;
    }
    const [, pre, intPart, decPart = "", post] = m;
    const target = Number(intPart.replace(/,/g, ""));
    const decimals = decPart ? decPart.length - 1 : 0;
    const from = prev.current ?? 0;
    prev.current = target;
    const useGrouping = intPart.includes(",");
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      const n = from + (target - from) * eased;
      const txt = n.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        useGrouping,
      });
      setShown(`${pre}${txt}${decPart && p >= 1 ? "" : ""}${post}`);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setShown(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

/** KPI / stat card with a coloured tile, animated number and a delta pill. */
export function StatCard({
  label,
  value,
  delta,
  deltaTone = "subdued",
  sub,
  icon,
  tone = "violet",
  index = 0,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "success" | "critical" | "subdued";
  sub?: string;
  icon: IconSource;
  tone?: TileTone;
  index?: number;
}) {
  const shown = useCountUp(value);
  const deltaClass =
    deltaTone === "success" ? "keha-delta keha-delta--up" : deltaTone === "critical" ? "keha-delta keha-delta--down" : "keha-delta";
  return (
    <Reveal index={index}>
      <div className="keha-lift" style={{ borderRadius: 12 }}>
        <s-section>
          <div className="keha-stat">
            <div className="keha-stat__top">
              <s-text color="subdued" fontSize="small">
                {label}
              </s-text>
              <IconTile icon={icon} tone={tone} size="sm" />
            </div>
            <div className="keha-stat__value">{shown}</div>
            <div className="keha-stat__foot">
              {delta && delta !== "—" && (
                <span className={deltaClass}>
                  {deltaTone === "success" && <s-icon type="arrow-up" size="small" />}
                  {deltaTone === "critical" && <s-icon type="arrow-down" size="small" />}
                  {delta}
                </span>
              )}
              {sub && <span>{sub}</span>}
            </div>
          </div>
        </s-section>
      </div>
    </Reveal>
  );
}

/** Quick-action tile: icon, title, one-line sub, arrow. */
export function QuickAction({
  icon,
  tone,
  title,
  sub,
  onClick,
  index = 0,
}: {
  icon: IconSource;
  tone: TileTone;
  title: string;
  sub: string;
  onClick: () => void;
  index?: number;
}) {
  return (
    <Reveal index={index}>
      <button type="button" className="keha-quick keha-lift" onClick={onClick}>
        <IconTile icon={icon} tone={tone} />
        <span>
          <span className="keha-quick__title">{title}</span>
          <span className="keha-quick__sub" style={{ display: "block" }}>
            {sub}
          </span>
        </span>
        <span className="keha-quick__arrow">
          <s-icon type="chevron-right" />
        </span>
      </button>
    </Reveal>
  );
}

/** Card section heading with a coloured tile. */
export function SectionHead({
  icon,
  tone,
  title,
  sub,
  action,
}: {
  icon: IconSource;
  tone: TileTone;
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="keha-section-head" style={{ justifyContent: "space-between" }}>
      <div className="keha-section-head">
        <IconTile icon={icon} tone={tone} size="sm" />
        <div className="keha-section-head__text">
          <s-heading>{title}</s-heading>
          {sub && (
            <s-text color="subdued" fontSize="small">
              {sub}
            </s-text>
          )}
        </div>
      </div>
      {action}
    </div>
  );
}

/** Conic progress ring with a percentage label. */
export function ProgressRing({ percent, tone = "violet" }: { percent: number; tone?: TileTone }) {
  const { locale } = useLocale();
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const ring = `var(--tile-${tone}-fg)`;
  const text = formatPercent(p / 100, locale);
  return (
    <div className="keha-ring" style={{ ["--p" as string]: p, ["--ring" as string]: ring, position: "relative" }} aria-label={text}>
      <span>{text}</span>
    </div>
  );
}

/** Hero header for the dashboard. */
export function Hero({
  eyebrow,
  title,
  sub,
  actions,
  stats,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  actions: ReactNode;
  stats: { value: string; label: string }[];
}) {
  return (
    <Reveal>
      <section className="keha-hero">
        <div className="keha-hero__grid">
          <div>
            <div className="keha-hero__eyebrow">{eyebrow}</div>
            <h1 className="keha-hero__title">{title}</h1>
            <p className="keha-hero__sub">{sub}</p>
            <div className="keha-hero__actions">{actions}</div>
          </div>
          <div className="keha-hero__stats">
            {stats.map((s) => (
              <HeroStat key={s.label} value={s.value} label={s.label} />
            ))}
          </div>
        </div>
      </section>
    </Reveal>
  );
}

function HeroStat({ value, label }: { value: string; label: string }) {
  const shown = useCountUp(value);
  return (
    <div className="keha-hero__stat">
      <b>{shown}</b>
      <span>{label}</span>
    </div>
  );
}

export function HeroButton({
  children,
  primary,
  icon,
  onClick,
}: {
  children: ReactNode;
  primary?: boolean;
  icon?: IconSource;
  onClick: () => void;
}) {
  const Svg = icon;
  return (
    <button type="button" className={`keha-hero__btn${primary ? " keha-hero__btn--primary" : ""}`} onClick={onClick}>
      {Svg && <Svg />}
      {children}
    </button>
  );
}

/**
 * Compact page hero used by every page except the dashboard: icon tile,
 * title (+ optional badge), subtitle, actions on the right and optional stat
 * chips underneath. Replaces the Polaris Page title/subtitle/actions props so
 * the whole app shares one visual language.
 */
export function PageHero({
  icon,
  tone = "violet",
  title,
  sub,
  badge,
  actions,
  stats,
}: {
  icon: IconSource;
  tone?: TileTone;
  title: ReactNode;
  sub?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  stats?: { value: string; label: string }[];
}) {
  return (
    <Reveal>
      <header className={`keha-page-hero keha-page-hero--${tone}`}>
        <div className="keha-page-hero__main">
          <IconTile icon={icon} tone={tone} size="lg" />
          <div className="keha-page-hero__text">
            <h1 className="keha-page-hero__title">
              <span>{title}</span>
              {badge}
            </h1>
            {sub && <p className="keha-page-hero__sub">{sub}</p>}
          </div>
        </div>
        {actions && <div className="keha-page-hero__actions">{actions}</div>}
        {stats && stats.length > 0 && (
          <div className="keha-page-hero__stats">
            {stats.map((s) => (
              <span key={s.label} className="keha-page-hero__chip">
                <b>{s.value}</b> {s.label}
              </span>
            ))}
          </div>
        )}
      </header>
    </Reveal>
  );
}

// ---------------------------------------------------------------------------
// Dashboard v2 (2026-09-25) — denser, calmer primitives for the refreshed
// Shopify admin: one metric strip instead of four tall cards, compact card
// headers, list rows with hairline dividers. Page chrome is the native
// `<s-page heading>` so the header matches every Shopify page.
// ---------------------------------------------------------------------------

export type Metric = {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "success" | "critical" | "subdued";
  sub?: string;
  icon: IconSource;
  tone: TileTone;
  onClick?: () => void;
};

function MetricCell({ m }: { m: Metric }) {
  const shown = useCountUp(m.value, 450);
  const deltaClass =
    m.deltaTone === "success" ? "keha-delta keha-delta--up" : m.deltaTone === "critical" ? "keha-delta keha-delta--down" : "keha-delta";
  const body = (
    <>
      <span className="keha-metric__label">
        <IconTile icon={m.icon} tone={m.tone} size="xs" />
        {m.label}
      </span>
      <span className="keha-metric__value">{shown}</span>
      <span className="keha-metric__foot">
        {m.delta && m.delta !== "—" && <span className={deltaClass}>{m.delta}</span>}
        {m.sub && <span>{m.sub}</span>}
      </span>
    </>
  );
  return m.onClick ? (
    <button type="button" className="keha-metric keha-metric--link" onClick={m.onClick}>
      {body}
    </button>
  ) : (
    <div className="keha-metric">{body}</div>
  );
}

/** One card, N metrics side by side with hairline dividers (Shopify analytics style). */
export function MetricStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <Reveal>
      <s-section padding="none">
        <div className="keha-metrics" style={{ ["--n" as string]: metrics.length }}>
          {metrics.map((m) => (
            <MetricCell key={m.label} m={m} />
          ))}
        </div>
      </s-section>
    </Reveal>
  );
}

/** Compact card header: small tile, title, optional count + trailing action. */
export function CardHeader({
  icon,
  tone,
  title,
  sub,
  action,
}: {
  icon: IconSource;
  tone: TileTone;
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="keha-card-head">
      <IconTile icon={icon} tone={tone} size="xs" />
      <div className="keha-card-head__text">
        <span className="keha-card-head__title">{title}</span>
        {sub && <span className="keha-card-head__sub">{sub}</span>}
      </div>
      {action && <div className="keha-card-head__action">{action}</div>}
    </div>
  );
}

/** Product image, or a neutral tile when the product has none. */
export function ProductThumb({ src, alt, size = 40 }: { src?: string | null; alt: string; size?: 32 | 40 | 48 }) {
  return src ? (
    <img className="keha-thumb" src={src} alt={alt} width={size} height={size} loading="lazy" style={{ width: size, height: size }} />
  ) : (
    <span className="keha-thumb keha-thumb--empty" style={{ width: size, height: size }} aria-hidden="true">
      <ProductIcon />
    </span>
  );
}

/**
 * App page shell (2026-09-25). Every page uses the admin's own title bar —
 * `<s-page heading>` with primary / secondary actions and an optional
 * breadcrumb in their slots — instead of a custom hero, so Keha Inventory reads as
 * part of Shopify. An optional one-line intro sits above the content, and
 * `size="base"` (every page, including tables — one width across the app)
 * keeps line lengths readable on wide screens.
 *
 * Action elements are cloned with the right `slot`; pass plain `<s-button>`s.
 */
export function AppPage({
  heading,
  intro,
  meta,
  primaryAction,
  secondaryActions,
  breadcrumb,
  size = "base",
  children,
}: {
  heading: string;
  intro?: ReactNode;
  /** Status badges etc. shown on the intro line (s-page has no title badge). */
  meta?: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode[];
  breadcrumb?: { label: string; to: string };
  size?: "small" | "base" | "large";
  children: ReactNode;
}) {
  const link = useLinkProps();
  const slotted = (el: ReactNode, slot: string, key?: number) =>
    isValidElement(el) ? cloneElement(el as ReactElement<{ slot?: string; key?: number }>, { slot, key }) : null;
  return (
    <s-page heading={heading} inlineSize={size}>
      {breadcrumb && (
        <s-link slot="breadcrumb-actions" {...link(breadcrumb.to)}>
          {breadcrumb.label}
        </s-link>
      )}
      {slotted(primaryAction, "primary-action")}
      {(secondaryActions ?? []).map((a, i) => slotted(a, "secondary-actions", i))}
      <div className="keha-stack">
        {(intro || meta) && (
          <div className="keha-page-intro">
            {meta}
            {intro && <span>{intro}</span>}
          </div>
        )}
        <UpgradeFromQuery />
        {children}
      </div>
    </s-page>
  );
}

/** A card of click-through rows (Shopify settings-list style). */
export function NavList({
  items,
  heading,
  sub,
}: {
  items: { icon: IconSource; tone: TileTone; title: string; sub?: string; meta?: ReactNode; onClick: () => void }[];
  heading?: string;
  sub?: string;
}) {
  return (
    <s-section padding="none">
      <div className="keha-navlist">
        {heading && (
          <div className="keha-navlist__head">
            <span className="keha-card-head__title">{heading}</span>
            {sub && <span className="keha-card-head__sub">{sub}</span>}
          </div>
        )}
        {items.map((it) => (
          <button key={it.title} type="button" className="keha-row" onClick={it.onClick}>
            <IconTile icon={it.icon} tone={it.tone} size="sm" />
            <span className="keha-row__main">
              <span className="keha-row__title">{it.title}</span>
              {it.sub && <span className="keha-row__sub">{it.sub}</span>}
            </span>
            <span className="keha-row__meta">
              {it.meta}
              <span className="keha-row__arrow">
                <s-icon type="chevron-right" size="small" />
              </span>
            </span>
          </button>
        ))}
      </div>
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// Form building blocks so every settings screen has the same anatomy:
// titled cards in a main column, a summary/checklist + live preview sidebar,
// optional "More options" disclosure and a bottom action bar.
// ---------------------------------------------------------------------------

/**
 * Titled card. Typography comes from Polaris itself (`<s-heading>` inside an
 * `<s-section>` renders at the admin's card-heading size, `<s-paragraph
 * color="subdued">` at body size), so every card title and description in the
 * app matches Shopify's own pages and follows any Polaris restyle (2026-10-09
 * design-consistency pass: no hand-set font sizes here).
 */
export function FormCard({
  title,
  sub,
  action,
  children,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <s-section>
      <s-stack gap="base">
        <div className="keha-form-card__head">
          <s-stack gap="small-500">
            <s-heading>{title}</s-heading>
            {sub && <s-paragraph color="subdued">{sub}</s-paragraph>}
          </s-stack>
          {action}
        </div>
        {children}
      </s-stack>
    </s-section>
  );
}

/** Collapsed card for optional settings ("More options"). */
export function Disclosure({
  title,
  sub,
  open,
  onToggle,
  id,
  children,
}: {
  title: string;
  sub?: string;
  open: boolean;
  onToggle: () => void;
  id: string;
  children: ReactNode;
}) {
  return (
    <s-section>
      <button type="button" className="keha-disclosure" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <s-stack gap="small-500">
          <s-heading>{title}</s-heading>
          {sub && <s-paragraph color="subdued">{sub}</s-paragraph>}
        </s-stack>
        <s-icon type={open ? "chevron-up" : "chevron-down"} />
      </button>
      {open && (
        <div id={id} className="keha-adv">
          {children}
        </div>
      )}
    </s-section>
  );
}

/**
 * A titled group inside a card (e.g. "Discount" inside "More options"). A
 * nested `<s-section>` is how Polaris draws a sub-section: its heading renders
 * one level below the card heading, with no second card border.
 */
export function FormGroup({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="keha-adv__group">
      <s-section heading={title}>
        <s-stack gap="base">
          {sub && <s-paragraph color="subdued">{sub}</s-paragraph>}
          {children}
        </s-stack>
      </s-section>
    </div>
  );
}

/** Label → value row (sidebar summaries). */
export function KvRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="keha-kv__row">
      <s-text color="subdued">{label}</s-text>
      <s-text fontWeight="medium">{value}</s-text>
    </div>
  );
}

/** Checklist row: done/not-done icon, label, value. */
export function CheckRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className={`keha-check${ok ? " keha-check--ok" : ""}`}>
      <s-icon type={ok ? "check-circle-filled" : "circle"} tone={ok ? "success" : "neutral"} size="small" />
      <s-text color="subdued">{label}</s-text>
      <span className="keha-check__value">
        <s-text color={ok ? "base" : "subdued"} fontWeight={ok ? "medium" : "base"}>
          {value}
        </s-text>
      </span>
    </div>
  );
}

/** Bottom action bar for long forms (mirrors the title-bar actions). */
export function ActionBar({ left, children }: { left?: ReactNode; children: ReactNode }) {
  return (
    <div className="keha-actionbar">
      {left ?? <span />}
      <div className="keha-actionbar__right">{children}</div>
    </div>
  );
}

/**
 * Segmented control (single choice) for switching between views. Drawn by us:
 * Polaris' <s-button-group> renders only slotted <s-button>s (no pressed
 * state), and press buttons placed in it did not render at all (live check
 * 2026-10-09). For a persistent setting use a choice list instead (Shopify's
 * guidance).
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="keha-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`keha-seg__btn${value === o.value ? " keha-seg__btn--active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
