/**
 * Store simulator (owner 2026-10-17: "Explore with sample data" and the end-to-end simulation
 * tests). Pure and seeded: the same options give the same store, byte for byte.
 *
 * A realistic apparel store over 14 calendar months (the backfill's window, ending yesterday):
 *  - N products × 5 variants (sizes, waist sizes, colours or gift-card amounts); S = 60 products,
 *    M = 600, L configurable; product types with a season (winter, summer, all year), collections
 *    (a catch-all "All products" plus Winter / Summer / Basics / New in / Sale);
 *  - 3 locations: Main warehouse and Second warehouse (both fulfil online orders) and a POS shop;
 *  - 5–6 suppliers in Portugal, Turkey, China and Spain: lead 10–75 days, transit, minimums per style
 *    or per variant, order minimums in units and money, case packs, USD with an exchange rate,
 *    order cycles;
 *  - daily demand with a weekly pattern, yearly seasonality, Black Friday / Christmas / January sale
 *    peaks, a growth trend, promotions and viral spikes, a wholesale channel (lumpy orders), returns
 *    (restocked), stock-outs (most variants DENY = lost sales; some CONTINUE = backorders and
 *    negative stock), discontinued / new / archived / draft products, flops (dead stock), bundles,
 *    an untracked gift card, POS-only items and missing cost prices;
 *  - a merchant who reorders each supplier on its cycle with an imperfect forecast, minimums and case
 *    packs; deliveries land after the lead time (late sometimes), split between the warehouses; the
 *    POS shop is topped up weekly and the second warehouse refills the main one.
 *
 * Stock history is consistent with sales, returns, deliveries and transfers by construction (the
 * same daily ledger writes them all; `ledger` keeps the movements so tests can re-add them). Open
 * purchase orders at the end become Keha orders (sent, some confirmed with a ship date, a fresh and
 * a stale draft) and Shopify orders (their units in Shopify's incoming).
 *
 * The output is dense typed arrays (a large store's stock history is millions of cells) plus the
 * catalogue; lib/sim/sim-rows-shared turns it into the rows Shopify would return (ShopifyQL) and the
 * rows the sync writes.
 */
import { addDays, dayIndex, fromDayIndex, weekday, type DayKey } from "../engine/dates-shared";
import { historyRange } from "../sync/store-time-shared";
import { createRng, hash32, type Rng } from "./rng-shared";

export type SimSize = "S" | "M" | "L";
export const SIM_PRODUCTS: Record<SimSize, number> = { S: 60, M: 600, L: 2000 };
export const VARIANTS_PER_PRODUCT = 5;
/** Days simulated before the history starts (not emitted), so day one has natural stock and open orders. */
export const BURN_IN_DAYS = 150;
/** Shopify sales channel names (ShopifyQL `sales_channel`). */
export const CHANNELS = ["Online Store", "Point of Sale", "Wholesale"] as const;
export type ChannelIdx = 0 | 1 | 2;
/** Indexes into SimStore.locations. */
export const W1 = 0;
export const W2 = 1;
export const POS = 2;

export type SimOptions = {
  size?: SimSize;
  /** Overrides the size's product count (L is "configurable"). */
  products?: number;
  seed?: number;
  /** Store-local today; the history ends the day before (I-12). */
  today: DayKey;
  /** Calendar months of history, the current one included (default 14, as the backfill). */
  months?: number;
  /** Digits that start every numeric id (default from the seed). Sample data uses a reserved range. */
  idPrefix?: string;
  currency?: string;
  timezone?: string;
  locale?: string;
};

export type Season = "winter" | "summer" | "all";

export type SimLocation = { id: string; name: string; active: boolean; online: boolean; role: "warehouse" | "store" };

export type SimSupplier = {
  key: string;
  id: string;
  name: string;
  country: "PT" | "TR" | "CN" | "ES";
  leadTimeDays: number;
  transitDays: number;
  minOrder: number | null;
  minOrderScope: "variant" | "product";
  minOrderTotal: number | null;
  minOrderValue: number | null;
  casePack: number | null;
  currency: string;
  exchangeRate: number | null;
  orderCycleDays: number;
  vendorMatch: string[];
  /** Orders go through Shopify purchase orders (source "shopify") instead of Keha. */
  viaShopify: boolean;
  /** Delivery delay range (days) around the lead time. */
  delay: [number, number];
};

export type Lifecycle = "normal" | "new" | "brandNew" | "discontinued" | "archived" | "draft" | "flop" | "overstock" | "oversold";

export type SimProduct = {
  idx: number;
  id: string;
  title: string;
  handle: string;
  productType: string;
  vendor: string;
  season: Season;
  archetype: string;
  supplierKey: string | null;
  collections: string[];
  createdDay: DayKey;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  lifecycle: Lifecycle;
  /** Units per day for the whole product at season factor 1, at today's trend level. */
  base: number;
  price: number;
  tracked: boolean;
  isBundle: boolean;
  /** Stocked and sold at the POS shop / kept in the second warehouse. */
  atPos: boolean;
  atW2: boolean;
  posOnly: boolean;
  wholesale: boolean;
  returnRate: number;
  noReorder: boolean;
  caseQty: number | null;
  /** Day index (simulation days) from which the product no longer sells (archived) / is no longer reordered. */
  stopDay: number | null;
};

export type SimVariant = {
  idx: number;
  id: string;
  product: SimProduct;
  variantTitle: string;
  sku: string;
  share: number;
  cost: number | null;
  inventoryPolicy: "DENY" | "CONTINUE";
  /** Explicit supplier (Settings → Suppliers by product) rather than the vendor match. */
  supplierId: string | null;
  /** Locations carrying it (W1, W2, POS). */
  at: [boolean, boolean, boolean];
  /** First output day index with a stock row (D = never). */
  firstStock: number;
};

export type SimPoLine = { variantIdx: number; qty: number };

export type SimPurchaseOrder = {
  /** Sequence within the store (PO numbers). */
  n: number;
  supplierKey: string;
  source: "keha" | "shopify";
  status: "draft" | "sent" | "confirmed" | "received" | "cancelled";
  createdDay: DayKey;
  sentDay: DayKey | null;
  /** Lead-time estimate (order day + lead). */
  expectedDay: DayKey | null;
  confirmedShipDay: DayKey | null;
  receivedDay: DayKey | null;
  cancelledDay: DayKey | null;
  /** True arrival (sent orders still on their way: after yesterday). */
  arrivalDay: DayKey | null;
  lines: SimPoLine[];
};

export type LedgerEntry = { day: number; variantIdx: number; location: number; units: number; kind: "delivery" | "transfer" };

export type SimStore = {
  meta: {
    size: SimSize | "custom";
    seed: number;
    today: DayKey;
    yesterday: DayKey;
    from: DayKey;
    /** Output days (from … yesterday). */
    days: number;
    currency: string;
    timezone: string;
    locale: string;
    idPrefix: string;
  };
  locations: SimLocation[];
  suppliers: SimSupplier[];
  collections: { id: string; title: string; handle: string }[];
  products: SimProduct[];
  variants: SimVariant[];
  /** End-of-day units per location: [location][variant * days + day]. */
  stock: [Int32Array, Int32Array, Int32Array];
  /** Gross units sold per channel (before returns): [channel][variant * days + day]. */
  sold: [Int32Array, Int32Array, Int32Array];
  /** Units returned per channel on the day the return was processed. */
  returned: [Int32Array, Int32Array, Int32Array];
  /** Product page sessions per product and day (two traffic types) and checkouts. */
  sessions: { search: Int32Array; direct: Int32Array; checkouts: Int32Array };
  /** Store orders per day (all channels). */
  orders: Int32Array;
  /** Stock now per variant × location (onHand / committed / available / incoming). */
  stockNow: { variantIdx: number; location: number; onHand: number; committed: number; available: number; incoming: number }[];
  purchaseOrders: SimPurchaseOrder[];
  /** Deliveries and transfers per output day (stock moves that are not sales or returns). */
  ledger: LedgerEntry[];
  /** What the simulator knows and the store doesn't (tests): per variant. */
  truth: {
    /** Expected units per day today (all channels, season and trend applied, no promos). */
    rateNow: Float64Array;
    /** Demand not met while out of stock (DENY), output days. */
    lost: Int32Array;
  };
};

// ── Catalogue ──────────────────────────────────────────────────────────────────────────────

type SizeSet = { labels: string[]; codes: string[]; shares: number[] };
const APPAREL: SizeSet = { labels: ["XS", "S", "M", "L", "XL"], codes: ["XS", "S", "M", "L", "XL"], shares: [0.07, 0.2, 0.33, 0.26, 0.14] };
const WAIST: SizeSet = { labels: ["28", "30", "32", "34", "36"], codes: ["28", "30", "32", "34", "36"], shares: [0.1, 0.22, 0.3, 0.25, 0.13] };
const COLOURS5: SizeSet = { labels: ["Black", "Navy", "Grey", "Camel", "Green"], codes: ["BLK", "NVY", "GRY", "CML", "GRN"], shares: [0.3, 0.25, 0.2, 0.15, 0.1] };
const AMOUNTS: SizeSet = { labels: ["25", "50", "75", "100", "150"], codes: ["25", "50", "75", "100", "150"], shares: [0.3, 0.32, 0.14, 0.18, 0.06] };

type Archetype = {
  key: string;
  type: string;
  code: string;
  season: Season;
  /** Products per 60 (S); scaled for larger stores. */
  weight: number;
  styles: string[];
  colours: string[];
  sizes: SizeSet;
  vendor: string;
  supplierKey: string | null;
  price: [number, number];
  costRatio: [number, number];
  base: [number, number];
  pos: number;
  w2: number;
  returnRate: number;
  wholesale: boolean;
  continueShare: number;
  kind?: "giftcard" | "bundle" | "posOnly";
};

const ARCHETYPES: Archetype[] = [
  { key: "coat", type: "Coats", code: "COAT", season: "winter", weight: 5, styles: ["Harbour wool coat", "Alpine parka", "City trench", "Nordic duffle", "Longline overcoat", "Field jacket coat"], colours: ["Navy", "Camel", "Charcoal", "Olive", "Black"], sizes: APPAREL, vendor: "Atlas Outerwear", supplierKey: "ningbo", price: [149, 229], costRatio: [0.3, 0.38], base: [1.2, 2.6], pos: 0.5, w2: 0.8, returnRate: 0.1, wholesale: false, continueShare: 0 },
  { key: "puffer", type: "Jackets", code: "PUFF", season: "winter", weight: 4, styles: ["Summit puffer", "Featherlight down jacket", "Ridge padded jacket", "Polar bomber"], colours: ["Black", "Forest", "Sand", "Navy"], sizes: APPAREL, vendor: "Atlas Outerwear", supplierKey: "ningbo", price: [119, 179], costRatio: [0.3, 0.36], base: [1.4, 3.0], pos: 0.5, w2: 0.8, returnRate: 0.09, wholesale: false, continueShare: 0 },
  { key: "knit", type: "Knitwear", code: "KNIT", season: "winter", weight: 8, styles: ["Merino crew jumper", "Cable knit sweater", "Lambswool cardigan", "Ribbed roll neck", "Fisherman jumper", "Cashmere blend v-neck"], colours: ["Oatmeal", "Navy", "Bottle green", "Burgundy", "Grey marl"], sizes: APPAREL, vendor: "Porto Knit", supplierKey: "porto", price: [59, 99], costRatio: [0.32, 0.4], base: [1.5, 3.2], pos: 0.6, w2: 0.4, returnRate: 0.07, wholesale: true, continueShare: 0.1 },
  { key: "winteracc", type: "Winter accessories", code: "WACC", season: "winter", weight: 4, styles: ["Wool beanie", "Chunky scarf", "Merino gloves", "Ribbed snood"], colours: ["One size"], sizes: COLOURS5, vendor: "Porto Knit", supplierKey: "porto", price: [19, 39], costRatio: [0.28, 0.35], base: [1.5, 3.5], pos: 0.7, w2: 0.2, returnRate: 0.02, wholesale: true, continueShare: 0 },
  { key: "swim", type: "Swimwear", code: "SWIM", season: "summer", weight: 5, styles: ["Riviera swim shorts", "Coast bikini", "Lido swimsuit", "Tide board shorts", "Cove one-piece"], colours: ["Coral", "Navy", "Sea green", "Black", "Print"], sizes: APPAREL, vendor: "Mare Swim", supplierKey: "guangzhou", price: [35, 65], costRatio: [0.26, 0.33], base: [1.2, 2.8], pos: 0.4, w2: 0.3, returnRate: 0.12, wholesale: false, continueShare: 0 },
  { key: "linen", type: "Linen shirts", code: "LINN", season: "summer", weight: 5, styles: ["Linen resort shirt", "Linen grandad shirt", "Linen camp collar shirt", "Linen popover"], colours: ["White", "Sky", "Sand", "Sage"], sizes: APPAREL, vendor: "Studio Linen", supplierKey: null, price: [49, 79], costRatio: [0.3, 0.38], base: [1.0, 2.4], pos: 0.5, w2: 0.2, returnRate: 0.08, wholesale: false, continueShare: 0 },
  { key: "shorts", type: "Shorts", code: "SHRT", season: "summer", weight: 4, styles: ["Chino shorts", "Denim shorts", "Drawstring shorts", "Cargo shorts"], colours: ["Stone", "Navy", "Olive", "Washed blue"], sizes: WAIST, vendor: "Indigo Denim", supplierKey: "istanbul", price: [39, 59], costRatio: [0.28, 0.34], base: [1.0, 2.2], pos: 0.4, w2: 0.3, returnRate: 0.1, wholesale: true, continueShare: 0 },
  { key: "jeans", type: "Jeans", code: "JEAN", season: "all", weight: 6, styles: ["Slim fit jeans", "Straight leg jeans", "Relaxed jeans", "Selvedge jeans", "Tapered jeans"], colours: ["Indigo", "Black", "Mid wash", "Light wash"], sizes: WAIST, vendor: "Indigo Denim", supplierKey: "istanbul", price: [69, 119], costRatio: [0.28, 0.35], base: [1.6, 3.2], pos: 0.6, w2: 0.5, returnRate: 0.15, wholesale: true, continueShare: 0.1 },
  { key: "tee", type: "T-shirts", code: "TEE", season: "all", weight: 10, styles: ["Organic cotton tee", "Heavyweight tee", "Pocket tee", "Long sleeve tee", "Breton stripe tee", "Slub tee"], colours: ["White", "Black", "Navy", "Grey", "Ecru"], sizes: APPAREL, vendor: "Everyday Basics", supplierKey: "lisbon", price: [25, 39], costRatio: [0.25, 0.32], base: [2.5, 5.5], pos: 0.7, w2: 0.5, returnRate: 0.06, wholesale: true, continueShare: 0.25 },
  { key: "socks", type: "Socks", code: "SOCK", season: "all", weight: 4, styles: ["Everyday socks 3-pack", "Wool hiking socks", "Ankle socks 5-pack", "Ribbed socks"], colours: ["Multi"], sizes: COLOURS5, vendor: "Everyday Basics", supplierKey: "lisbon", price: [12, 22], costRatio: [0.22, 0.3], base: [2.0, 4.5], pos: 0.7, w2: 0.3, returnRate: 0.02, wholesale: true, continueShare: 0 },
  { key: "tote", type: "Accessories", code: "TOTE", season: "all", weight: 2, styles: ["Canvas shop tote", "Market bag"], colours: ["Natural"], sizes: COLOURS5, vendor: "Casa Accessories", supplierKey: "barcelona", price: [18, 29], costRatio: [0.3, 0.36], base: [0.8, 1.6], pos: 1, w2: 0, returnRate: 0.01, wholesale: false, continueShare: 0, kind: "posOnly" },
  { key: "giftcard", type: "Gift cards", code: "GIFT", season: "all", weight: 1, styles: ["Gift card"], colours: [""], sizes: AMOUNTS, vendor: "Keha Sample Store", supplierKey: null, price: [25, 25], costRatio: [0, 0], base: [1.0, 1.4], pos: 0, w2: 0, returnRate: 0, wholesale: false, continueShare: 0, kind: "giftcard" },
  { key: "bundle", type: "Bundles", code: "BNDL", season: "all", weight: 2, styles: ["Basics bundle", "Winter warm bundle"], colours: [""], sizes: APPAREL, vendor: "Everyday Basics", supplierKey: null, price: [69, 99], costRatio: [0.3, 0.3], base: [0.4, 0.9], pos: 0, w2: 0, returnRate: 0.05, wholesale: false, continueShare: 0, kind: "bundle" },
];

function supplierTable(prefix: string, withBarcelona: boolean, currency: string): SimSupplier[] {
  const id = (k: string) => `sample-${prefix}-${k}`;
  // Chinese suppliers quote in USD (with the rate for a EUR store); the others in the store's currency.
  const usd = currency === "EUR" ? { currency: "USD", exchangeRate: 0.92 } : { currency, exchangeRate: null };
  const local = { currency, exchangeRate: null };
  const all: SimSupplier[] = [
    { key: "ningbo", id: id("ningbo"), name: "Ningbo Outerwear Co.", country: "CN", leadTimeDays: 75, transitDays: 35, minOrder: 60, minOrderScope: "product", minOrderTotal: null, minOrderValue: 4000, casePack: 10, ...usd, orderCycleDays: 60, vendorMatch: ["Atlas Outerwear"], viaShopify: false, delay: [-3, 10] },
    { key: "guangzhou", id: id("guangzhou"), name: "Guangzhou Swim Ltd.", country: "CN", leadTimeDays: 60, transitDays: 30, minOrder: 50, minOrderScope: "product", minOrderTotal: null, minOrderValue: 3000, casePack: 12, ...usd, orderCycleDays: 45, vendorMatch: ["Mare Swim"], viaShopify: false, delay: [-2, 8] },
    { key: "istanbul", id: id("istanbul"), name: "Istanbul Denim A.Ş.", country: "TR", leadTimeDays: 35, transitDays: 6, minOrder: 30, minOrderScope: "product", minOrderTotal: null, minOrderValue: 2500, casePack: 6, ...local, orderCycleDays: 30, vendorMatch: ["Indigo Denim"], viaShopify: false, delay: [-2, 4] },
    { key: "porto", id: id("porto"), name: "Porto Knitwear Lda.", country: "PT", leadTimeDays: 28, transitDays: 3, minOrder: 12, minOrderScope: "variant", minOrderTotal: 120, minOrderValue: null, casePack: null, ...local, orderCycleDays: 30, vendorMatch: ["Porto Knit"], viaShopify: false, delay: [-1, 3] },
    { key: "lisbon", id: id("lisbon"), name: "Lisbon Basics Lda.", country: "PT", leadTimeDays: 14, transitDays: 2, minOrder: 6, minOrderScope: "variant", minOrderTotal: null, minOrderValue: 500, casePack: 6, ...local, orderCycleDays: 14, vendorMatch: ["Everyday Basics"], viaShopify: true, delay: [-1, 2] },
    { key: "barcelona", id: id("barcelona"), name: "Barcelona Accessories S.L.", country: "ES", leadTimeDays: 10, transitDays: 1, minOrder: null, minOrderScope: "variant", minOrderTotal: null, minOrderValue: 300, casePack: null, ...local, orderCycleDays: 21, vendorMatch: ["Casa Accessories"], viaShopify: true, delay: [-1, 2] },
  ];
  return withBarcelona ? all : all.filter((s) => s.key !== "barcelona");
}

// ── Demand shape ───────────────────────────────────────────────────────────────────────────

/** Modified Bessel I0 (series): the mean of exp(a·cos θ), so a season curve averages 1 over a year. */
function besselI0(a: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (a / (2 * k)) * (a / (2 * k));
    sum += term;
  }
  return sum;
}

const SEASON_SHAPE: Record<Season, { amp: number; peak: number }> = {
  winter: { amp: 1.1, peak: 355 },
  summer: { amp: 1.4, peak: 182 },
  all: { amp: 0.12, peak: 345 },
};

function dayOfYear(day: DayKey): number {
  return dayIndex(day) - dayIndex(`${day.slice(0, 4)}-01-01`);
}

/** Seasonal factor (mean 1 over a year) for a season on a day. */
export function seasonFactor(season: Season, day: DayKey): number {
  const { amp, peak } = SEASON_SHAPE[season];
  return Math.exp(amp * Math.cos((2 * Math.PI * (dayOfYear(day) - peak)) / 365)) / besselI0(amp);
}

/** Black Friday (the day after the fourth Thursday of November) of a year. */
export function blackFriday(year: number): DayKey {
  const first = `${year}-11-01`;
  const thursday = (4 - weekday(first) + 7) % 7; // first Thursday offset
  return addDays(first, thursday + 21 + 1);
}

/** Calendar events: Black Friday weekend, Christmas, the January sale (winter items). */
export function eventFactor(season: Season, day: DayKey): number {
  const y = Number(day.slice(0, 4));
  const bf = blackFriday(y);
  const off = dayIndex(day) - dayIndex(bf);
  let f = 1;
  if (off >= -6 && off <= -1) f *= 0.88; // people wait for the deals
  else if (off === 0) f *= 3.6;
  else if (off === 1) f *= 2.2;
  else if (off === 2) f *= 1.8;
  else if (off === 3) f *= 2.6; // Cyber Monday
  const md = day.slice(5);
  if (md >= "12-01" && md <= "12-21" && season !== "summer") f *= 1.45;
  if (md === "12-24") f *= 0.6;
  if (md === "12-25" || md === "12-26") f *= 0.3;
  if (md >= "12-27" && md <= "12-31") f *= 1.2;
  if (md >= "01-02" && md <= "01-20" && season === "winter") f *= 1.5;
  return f;
}

const WEEKLY_ONLINE = [1.1, 0.95, 0.92, 0.95, 1.0, 1.05, 1.03]; // Sun … Sat
const WEEKLY_POS = [0.5, 0.8, 0.85, 0.9, 1.0, 1.3, 1.65];
/** Yearly growth of the store. */
export const TREND_PER_YEAR = 1.18;

// ── Helpers ────────────────────────────────────────────────────────────────────────────────

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
const round2 = (x: number) => Math.round(x * 100) / 100;
const price95 = (x: number) => Math.max(1, Math.round(x)) - 0.05;

/** Largest-remainder split of `total` by `shares`. */
export function splitByShares(total: number, shares: readonly number[]): number[] {
  const sum = shares.reduce((a, b) => a + b, 0) || 1;
  const raw = shares.map((s) => (total * s) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  return out;
}

/** Products per archetype for a store of `n` products (S proportions; one gift card). */
function allocate(n: number): number[] {
  const total = ARCHETYPES.reduce((a, x) => a + x.weight, 0);
  const counts = ARCHETYPES.map((a) => (a.kind === "giftcard" ? 1 : Math.max(1, Math.round((a.weight * n) / total))));
  const tee = ARCHETYPES.findIndex((a) => a.key === "tee");
  let diff = n - counts.reduce((a, b) => a + b, 0);
  counts[tee] = Math.max(1, counts[tee]! + diff);
  diff = n - counts.reduce((a, b) => a + b, 0);
  // Tiny stores: trim from the largest archetypes until it fits.
  while (diff < 0) {
    const i = counts.indexOf(Math.max(...counts));
    counts[i]!--;
    diff++;
  }
  return counts;
}

// ── The simulation ─────────────────────────────────────────────────────────────────────────

type OpenOrder = {
  supplierKey: string;
  day: number; // simulation day placed
  arrival: number; // simulation day it lands
  lines: SimPoLine[];
  late: boolean;
};

export function simulateStore(opts: SimOptions): SimStore {
  const size: SimSize | "custom" = opts.products !== undefined ? "custom" : (opts.size ?? "S");
  const nProducts = Math.max(5, Math.floor(opts.products ?? SIM_PRODUCTS[opts.size ?? "S"]));
  const seed = (opts.seed ?? 20261017) >>> 0;
  const rng = createRng(seed);
  const today = opts.today;
  const yesterday = addDays(today, -1);
  const from = historyRange(yesterday, opts.months ?? 14).from;
  const D = dayIndex(yesterday) - dayIndex(from) + 1;
  const prefix = opts.idPrefix ?? `99${pad(hash32(`sim:${seed}`) % 100_000_000, 8)}`;
  if (!/^\d{1,12}$/.test(prefix)) throw new Error(`sim: idPrefix must be 1–12 digits, got ${prefix}`);
  const gid = (kind: string, n: number) => `gid://shopify/${kind}/${prefix}${pad(n, 7)}`;
  const currency = opts.currency ?? "EUR";

  // Simulation days: BURN_IN_DAYS before `from`, then the D output days.
  const S0 = dayIndex(from) - BURN_IN_DAYS;
  const SD = BURN_IN_DAYS + D;
  const dayOf = (s: number) => fromDayIndex(S0 + s);
  const todayS = dayIndex(today) - S0; // simulation index of today (one past the last simulated day)

  const locations: SimLocation[] = [
    { id: gid("Location", 1), name: "Main warehouse", active: true, online: true, role: "warehouse" },
    { id: gid("Location", 2), name: "Second warehouse", active: true, online: true, role: "warehouse" },
    { id: gid("Location", 3), name: "Madrid shop", active: true, online: false, role: "store" },
  ];
  const suppliers = supplierTable(prefix, nProducts >= 200, currency);
  const supplierByKey = new Map(suppliers.map((s) => [s.key, s]));
  const collections = [
    { id: gid("Collection", 1), title: "All products", handle: "all-products" },
    { id: gid("Collection", 2), title: "Winter collection", handle: "winter" },
    { id: gid("Collection", 3), title: "Summer collection", handle: "summer" },
    { id: gid("Collection", 4), title: "Basics", handle: "basics" },
    { id: gid("Collection", 5), title: "New in", handle: "new-in" },
    { id: gid("Collection", 6), title: "Sale", handle: "sale" },
  ];
  const [cAll, cWinter, cSummer, cBasics, cNew, cSale] = collections.map((c) => c.id) as [string, string, string, string, string, string];

  // ---- products ----
  const counts = allocate(nProducts);
  const products: SimProduct[] = [];
  const archetypeOf: Archetype[] = [];
  const cat = rng.fork("catalogue");
  const titles = new Map<string, number>();
  ARCHETYPES.forEach((a, ai) => {
    for (let k = 0; k < counts[ai]!; k++) {
      const idx = products.length;
      const style = a.styles[k % a.styles.length]!;
      const colour = a.colours[Math.floor(k / a.styles.length) % a.colours.length] ?? "";
      let title = colour && a.sizes !== COLOURS5 && a.kind !== "giftcard" && a.kind !== "bundle" ? `${style} · ${colour}` : style;
      const seen = titles.get(title) ?? 0;
      titles.set(title, seen + 1);
      if (seen) title = `${title} No. ${seen + 1}`;
      const supplierKey = a.supplierKey && supplierByKey.has(a.supplierKey) ? a.supplierKey : null;
      const base = (a.base[0] + cat.next() * (a.base[1] - a.base[0])) * cat.logNormal(0.35);
      const p: SimProduct = {
        idx,
        id: gid("Product", idx + 1),
        title,
        handle: `${slug(title)}-${idx + 1}`,
        productType: a.type,
        vendor: a.vendor,
        season: a.season,
        archetype: a.key,
        supplierKey,
        collections: [cAll],
        createdDay: addDays(from, -cat.int(200, 900)),
        status: "ACTIVE",
        lifecycle: "normal",
        base: a.kind === "giftcard" ? a.base[0] : base,
        price: a.kind === "giftcard" ? 25 : price95(a.price[0] + cat.next() * (a.price[1] - a.price[0])),
        tracked: a.kind !== "giftcard",
        isBundle: a.kind === "bundle",
        atPos: a.kind === "posOnly" ? true : a.kind ? false : cat.chance(a.pos),
        atW2: a.kind ? false : cat.chance(a.w2),
        posOnly: a.kind === "posOnly",
        wholesale: a.wholesale && cat.chance(0.6),
        returnRate: a.returnRate,
        noReorder: false,
        caseQty: a.key === "socks" ? 12 : null,
        stopDay: null,
      };
      if (a.season === "winter") p.collections.push(cWinter);
      if (a.season === "summer") p.collections.push(cSummer);
      if (a.key === "tee" || a.key === "socks" || a.key === "jeans") p.collections.push(cBasics);
      products.push(p);
      archetypeOf.push(a);
    }
  });

  // Lifecycles: a few products each (never the gift card or bundles), spread over the archetypes.
  const life = rng.fork("lifecycle");
  const eligible = products.filter((p) => !archetypeOf[p.idx]!.kind);
  const shuffled = [...eligible];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = life.int(0, i);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const take = (n: number) => shuffled.splice(0, Math.max(0, Math.min(n, shuffled.length)));
  const scale = Math.max(1, Math.round(nProducts / 60));
  for (const p of take(3 * scale)) {
    p.lifecycle = "new";
    p.createdDay = addDays(today, -life.int(25, 55));
    p.collections.push(cNew);
  }
  for (const p of take(1 * scale)) {
    p.lifecycle = "brandNew";
    p.createdDay = addDays(today, -life.int(5, 8));
    p.collections.push(cNew);
  }
  for (const [i, p] of take(2 * scale).entries()) {
    p.lifecycle = "discontinued";
    p.stopDay = todayS - life.int(170, 230); // last reorder
    p.noReorder = i % 2 === 0; // the merchant marked half of them "Don't reorder"
    p.collections.push(cSale);
  }
  for (const p of take(1 * scale)) {
    p.lifecycle = "archived";
    p.status = "ARCHIVED";
    p.stopDay = todayS - life.int(90, 120);
  }
  for (const p of take(1 * scale)) {
    p.lifecycle = "draft";
    p.status = "DRAFT";
    p.createdDay = addDays(today, -life.int(10, 20));
  }
  for (const p of take(2 * scale)) {
    p.lifecycle = "flop";
    p.createdDay = addDays(today, -life.int(220, 280));
    p.collections.push(cSale);
  }
  for (const p of take(1 * scale)) p.lifecycle = "overstock";
  // A best seller that keeps selling when out of stock (CONTINUE) whose last orders were missed:
  // oversold now, its backorders owed.
  const continueKinds = new Set(["tee", "jeans"]);
  const oversold = shuffled.filter((p) => continueKinds.has(archetypeOf[p.idx]!.key) && p.supplierKey);
  for (const p of oversold.slice(0, scale)) {
    shuffled.splice(shuffled.indexOf(p), 1);
    p.lifecycle = "oversold";
    p.atW2 = false;
    p.base *= 1.5;
  }
  // One product with a returns problem (Fix returns action).
  const problem = take(1)[0];
  if (problem) problem.returnRate = 0.35;

  // ---- variants ----
  const variants: SimVariant[] = [];
  for (const p of products) {
    const a = archetypeOf[p.idx]!;
    const missingCost = !a.kind && cat.chance(0.06);
    const ratio = a.costRatio[0] + cat.next() * (a.costRatio[1] - a.costRatio[0]);
    for (let s = 0; s < VARIANTS_PER_PRODUCT; s++) {
      const idx = variants.length;
      const label = a.sizes.labels[s]!;
      const variantTitle = a.kind === "giftcard" ? label : label;
      const price = a.kind === "giftcard" ? Number(label.replace(/\D/g, "")) : p.price;
      const cont = p.lifecycle === "oversold" || (a.continueShare > 0 && cat.chance(a.continueShare));
      variants.push({
        idx,
        id: gid("ProductVariant", idx + 1),
        product: p,
        variantTitle,
        sku: `${a.code}-${pad(p.idx + 1, 4)}-${a.sizes.codes[s]}`,
        share: a.sizes.shares[s]! * cat.logNormal(0.12),
        cost: a.kind === "giftcard" ? null : missingCost ? null : round2(price * ratio),
        inventoryPolicy: cont ? "CONTINUE" : "DENY",
        supplierId: null,
        at: [!p.posOnly && p.tracked && !p.isBundle, p.atW2 && p.tracked && !p.isBundle, p.atPos && p.tracked && !p.isBundle],
        firstStock: D,
      });
    }
  }
  // Variant prices for the gift card come from the label; keep the product's own price for the rest.
  const priceOf = (v: SimVariant) => (archetypeOf[v.product.idx]!.kind === "giftcard" ? Number(v.variantTitle.replace(/\D/g, "")) : v.product.price);
  // A few products assigned to their supplier by hand (Settings → Suppliers), not by vendor.
  for (const p of products.filter((x) => x.supplierKey && x.idx % 7 === 3)) {
    for (const v of variants.filter((x) => x.product === p)) v.supplierId = supplierByKey.get(p.supplierKey!)!.id;
  }
  // Normalise shares per product.
  for (const p of products) {
    const vs = variants.filter((v) => v.product === p);
    const sum = vs.reduce((s, v) => s + v.share, 0);
    for (const v of vs) v.share /= sum;
  }

  // ---- demand ----
  const created = products.map((p) => dayIndex(p.createdDay) - S0);
  // Season × events × trend per season and simulation day (+ a year ahead for the merchant's forecast).
  const AHEAD = 260;
  const curve: Record<Season, Float64Array> = { winter: new Float64Array(SD + AHEAD), summer: new Float64Array(SD + AHEAD), all: new Float64Array(SD + AHEAD) };
  for (const season of ["winter", "summer", "all"] as const) {
    for (let s = 0; s < SD + AHEAD; s++) {
      const day = dayOf(s);
      curve[season][s] = seasonFactor(season, day) * eventFactor(season, day) * Math.pow(TREND_PER_YEAR, (s - todayS) / 365);
    }
  }
  const lifeFactor = (p: SimProduct, s: number): number => {
    const c = created[p.idx]!;
    if (p.lifecycle === "draft") return 0;
    if (s < c + 3) return 0; // stock lands a few days after the product is created
    if (p.stopDay !== null && p.lifecycle === "archived" && s >= p.stopDay) return 0;
    const age = s - c;
    if (p.lifecycle === "flop") return age < 40 ? 0.5 : 0.012;
    if ((p.lifecycle === "new" || p.lifecycle === "brandNew") && age < 14) return 1.3;
    return 1;
  };
  // Promotions (5–10 days at ×2.2) and viral spikes (×4–6 for 1–3 days).
  const promo = new Map<number, [number, number, number][]>();
  const prm = rng.fork("promos");
  for (const p of products) {
    const n = prm.int(0, 2);
    for (let k = 0; k < n; k++) {
      const start = prm.int(0, SD - 12);
      (promo.get(p.idx) ?? promo.set(p.idx, []).get(p.idx)!).push([start, start + prm.int(5, 10), 2.2]);
    }
  }
  for (let k = 0; k < 2 * scale + 1; k++) {
    const p = products[prm.int(0, products.length - 1)]!;
    const start = prm.int(BURN_IN_DAYS, SD - 4);
    (promo.get(p.idx) ?? promo.set(p.idx, []).get(p.idx)!).push([start, start + prm.int(1, 3), 4 + prm.next() * 2]);
  }
  const promoFactor = (p: SimProduct, s: number) => {
    let f = 1;
    for (const [a, b, m] of promo.get(p.idx) ?? []) if (s >= a && s < b) f *= m;
    return f;
  };
  /** Expected units per day for a variant (all channels, no promos): what the merchant plans with. */
  const expected = (v: SimVariant, s: number) => {
    const p = v.product;
    return p.base * v.share * curve[p.season][Math.min(s, SD + AHEAD - 1)]! * lifeFactor(p, s);
  };
  const onlineShare = (p: SimProduct) => (p.posOnly ? 0 : p.atPos ? 0.74 : 1);

  // ---- state ----
  const V = variants.length;
  const level = [new Int32Array(V), new Int32Array(V), new Int32Array(V)];
  const stock: [Int32Array, Int32Array, Int32Array] = [new Int32Array(V * D), new Int32Array(V * D), new Int32Array(V * D)];
  const sold: [Int32Array, Int32Array, Int32Array] = [new Int32Array(V * D), new Int32Array(V * D), new Int32Array(V * D)];
  const returned: [Int32Array, Int32Array, Int32Array] = [new Int32Array(V * D), new Int32Array(V * D), new Int32Array(V * D)];
  const lost = new Int32Array(V);
  const P = products.length;
  const sessions = { search: new Int32Array(P * D), direct: new Int32Array(P * D), checkouts: new Int32Array(P * D) };
  const orders = new Int32Array(D);
  const ledger: LedgerEntry[] = [];
  const pendingReturns = new Map<number, Map<number, number>>(); // sim day → variant → units
  const open: OpenOrder[] = [];
  const history: OpenOrder[] = [];
  const stocked = new Uint8Array(V); // stock rows started
  const sim = rng.fork("days");

  const onOrder = new Int32Array(V);
  const position = (v: SimVariant) => level[W1]![v.idx]! + level[W2]![v.idx]! + level[POS]![v.idx]! + onOrder[v.idx]!;
  const openOrder = (o: OpenOrder) => {
    open.push(o);
    for (const l of o.lines) onOrder[l.variantIdx]! += l.qty;
  };
  const addStock = (s: number, v: SimVariant, loc: number, units: number, kind: LedgerEntry["kind"]) => {
    if (!units) return;
    level[loc]![v.idx]! += units;
    if (s >= BURN_IN_DAYS) ledger.push({ day: s - BURN_IN_DAYS, variantIdx: v.idx, location: loc, units, kind });
  };
  const deliver = (s: number, o: OpenOrder) => {
    for (const l of o.lines) {
      const v = variants[l.variantIdx]!;
      onOrder[v.idx]! -= l.qty;
      if (v.at[POS] && !v.at[W1]) {
        addStock(s, v, POS, l.qty, "delivery");
        continue;
      }
      const toW2 = v.at[W2] ? Math.floor(l.qty * 0.3) : 0;
      addStock(s, v, W1, l.qty - toW2, "delivery");
      addStock(s, v, W2, toW2, "delivery");
    }
  };
  const tracked = (v: SimVariant) => v.product.tracked && !v.product.isBundle;
  const variantsOf = new Map<string, SimVariant[]>();
  for (const v of variants) {
    if (!tracked(v) || !v.product.supplierKey) continue;
    (variantsOf.get(v.product.supplierKey) ?? variantsOf.set(v.product.supplierKey, []).get(v.product.supplierKey)!).push(v);
  }
  const vendorOnly = variants.filter((v) => tracked(v) && !v.product.supplierKey);

  /** The merchant's order for one supplier on day s (imperfect forecast, minimums, packs). */
  const placeOrder = (s: number, sup: SimSupplier | null, list: SimVariant[], leadTime: number, cycle: number): OpenOrder | null => {
    const err = sim.logNormal(0.22) * (sim.chance(0.1) ? (sim.chance(0.5) ? 0.55 : 1.7) : 1);
    const horizon = leadTime + cycle + 10;
    const want = new Map<number, number>();
    for (const v of list) {
      const p = v.product;
      if (p.status === "DRAFT" || p.noReorder) continue;
      if (p.lifecycle === "flop" && s > created[p.idx]! + 10) continue;
      if (p.stopDay !== null && s >= p.stopDay) continue;
      if (s < created[p.idx]!) continue;
      if (p.lifecycle === "oversold" && s > todayS - 50) continue;
      let need = 0;
      for (let k = 0; k < horizon; k++) need += expected(v, s + k);
      need *= err * (p.lifecycle === "overstock" && s > todayS - 120 ? 3.5 : 1);
      const pack = (p.caseQty ?? sup?.casePack ?? 1) || 1;
      let q = Math.max(0, Math.ceil(need - position(v)));
      if (q > 0) q = Math.ceil(q / pack) * pack;
      if (q > 0 && sup?.minOrder && sup.minOrderScope === "variant" && q < sup.minOrder) q = q >= sup.minOrder * 0.4 ? Math.ceil(sup.minOrder / pack) * pack : 0;
      if (q > 0) want.set(v.idx, q);
    }
    // Minimum per style: top a style up to it (by size share), or wait when far below.
    if (sup?.minOrder && sup.minOrderScope === "product") {
      const byProduct = new Map<number, SimVariant[]>();
      for (const v of list) (byProduct.get(v.product.idx) ?? byProduct.set(v.product.idx, []).get(v.product.idx)!).push(v);
      for (const vs of byProduct.values()) {
        const total = vs.reduce((a, v) => a + (want.get(v.idx) ?? 0), 0);
        if (!total || total >= sup.minOrder) continue;
        if (total < sup.minOrder * 0.3) {
          for (const v of vs) want.delete(v.idx);
          continue;
        }
        const pack = sup.casePack ?? 1;
        const split = splitByShares(Math.ceil(sup.minOrder / pack), vs.map((v) => v.share));
        vs.forEach((v, i) => (split[i]! > 0 ? want.set(v.idx, split[i]! * pack) : want.delete(v.idx)));
      }
    }
    let units = 0;
    let value = 0;
    for (const [i, q] of want) {
      units += q;
      value += q * (variants[i]!.cost ?? priceOf(variants[i]!) * 0.33) / (sup?.exchangeRate ?? 1);
    }
    if (!units) return null;
    // Order minimums: scale up when close, otherwise wait for the next cycle.
    const short = Math.max(sup?.minOrderTotal ? sup.minOrderTotal / units : 0, sup?.minOrderValue ? sup.minOrderValue / Math.max(1, value) : 0);
    if (short > 1) {
      if (short > 3) return null;
      for (const [i, q] of want) {
        const pack = (variants[i]!.product.caseQty ?? sup?.casePack ?? 1) || 1;
        want.set(i, Math.ceil((q * short) / pack) * pack);
      }
    }
    const delay = sup ? sim.int(sup.delay[0], sup.delay[1]) : sim.int(-1, 3);
    return { supplierKey: sup?.key ?? "", day: s, arrival: s + leadTime + delay, lines: [...want].map(([variantIdx, qty]) => ({ variantIdx, qty })), late: false };
  };

  // Initial stock (the burn-in's day 0): about one cycle ahead of demand.
  for (const v of variants) {
    if (!tracked(v) || v.product.status === "DRAFT") continue;
    if (created[v.product.idx]! > 0) continue;
    const sup = v.product.supplierKey ? supplierByKey.get(v.product.supplierKey)! : null;
    const cover = (sup?.leadTimeDays ?? 21) * 0.6 + (sup?.orderCycleDays ?? 21);
    let units = 0;
    for (let k = 0; k < cover; k++) units += expected(v, k);
    units = Math.round(units * sim.logNormal(0.3));
    if (v.at[W1]) {
      const w2 = v.at[W2] ? Math.floor(units * 0.3) : 0;
      level[W1]![v.idx] = units - w2;
      level[W2]![v.idx] = w2;
    }
    if (v.at[POS]) level[POS]![v.idx] = Math.max(1, Math.round(units * (v.at[W1] ? 0.15 : 1)));
  }

  // The latest order of the long-lead supplier is held at the port (a late delivery right now).
  let lateMarked = false;
  const supplierOffset = new Map(suppliers.map((s, i) => [s.key, 2 + i * 3]));

  for (let s = 0; s < SD; s++) {
    const day = dayOf(s);
    const d = s - BURN_IN_DAYS;
    const out = d >= 0;
    const dow = weekday(day);

    // New products: their first delivery a few days after creation (and the draft's stock).
    for (const p of products) {
      if (!p.tracked || p.isBundle) continue;
      const c = created[p.idx]!;
      if (s !== Math.max(0, c + 2) || c <= 0) continue;
      const hype = p.lifecycle === "flop" ? 4 : 1;
      for (let k = p.idx * VARIANTS_PER_PRODUCT; k < (p.idx + 1) * VARIANTS_PER_PRODUCT; k++) {
        const v = variants[k]!;
        let units = 0;
        for (let k = 0; k < 45; k++) units += expected(v, s + 3 + k) * hype;
        units = Math.max(p.lifecycle === "draft" ? 6 : 3, Math.round(units));
        if (v.at[W1]) addStock(s, v, W1, units, "delivery");
        else if (v.at[POS]) addStock(s, v, POS, units, "delivery");
      }
    }

    // Deliveries landing today.
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i]!.arrival === s) {
        deliver(s, open[i]!);
        history.push(open[i]!);
        open.splice(i, 1);
      }
    }

    // Returns processed today (restocked at the main warehouse; counted in the online channel).
    const rets = pendingReturns.get(s);
    if (rets) {
      for (const [vi, units] of rets) {
        const v = variants[vi]!;
        if (tracked(v)) level[v.at[W1] ? W1 : POS]![vi]! += units;
        if (out) returned[0]![vi * D + d] += units;
      }
      pendingReturns.delete(s);
    }

    let onlineUnits = 0;
    let posUnits = 0;
    let wholesaleOrders = 0;
    const wholesaleDay = (s + 5) % 14 === 0;
    for (const v of variants) {
      const p = v.product;
      const lf = lifeFactor(p, s);
      if (!lf) continue;
      const base = p.base * v.share * curve[p.season][s]! * lf * promoFactor(p, s);
      // Online demand: main warehouse first, then the second one; CONTINUE oversells (backorders).
      const dOnline = sim.poisson(base * onlineShare(p) * WEEKLY_ONLINE[dow]!);
      let sOnline = 0;
      if (dOnline) {
        if (!tracked(v)) sOnline = dOnline;
        else {
          const avail = Math.max(0, level[W1]![v.idx]!) + Math.max(0, level[W2]![v.idx]!);
          sOnline = v.inventoryPolicy === "CONTINUE" ? dOnline : Math.min(dOnline, avail);
          let left = sOnline;
          const fromW1 = Math.min(left, Math.max(0, level[W1]![v.idx]!));
          level[W1]![v.idx]! -= fromW1;
          left -= fromW1;
          const fromW2 = Math.min(left, Math.max(0, level[W2]![v.idx]!));
          level[W2]![v.idx]! -= fromW2;
          left -= fromW2;
          if (left > 0) level[v.at[W1] ? W1 : POS]![v.idx]! -= left; // backorders: negative stock
          if (out && sOnline < dOnline) lost[v.idx] += dOnline - sOnline;
        }
      }
      // POS: what is on the shop floor.
      let sPos = 0;
      if (p.atPos) {
        const dPos = sim.poisson(base * (p.posOnly ? 1 : 0.26) * WEEKLY_POS[dow]!);
        sPos = tracked(v) ? Math.min(dPos, Math.max(0, level[POS]![v.idx]!)) : dPos;
        if (tracked(v)) level[POS]![v.idx]! -= sPos;
        if (out && sPos < dPos) lost[v.idx] += dPos - sPos;
      }
      // Wholesale: every two weeks a buyer orders a few weeks of a style (only what is in stock).
      let sWh = 0;
      if (p.wholesale && wholesaleDay && tracked(v) && sim.chance(0.35)) {
        const want = Math.round(base * 14 * 0.3 * sim.logNormal(0.4));
        sWh = Math.min(want, Math.max(0, level[W1]![v.idx]!));
        level[W1]![v.idx]! -= sWh;
        if (sWh) wholesaleOrders++;
      }
      // Returns of today's online sales, processed 5–25 days later.
      if (sOnline && p.returnRate > 0) {
        let r = 0;
        for (let k = 0; k < sOnline; k++) if (sim.chance(p.returnRate)) r++;
        if (r) {
          const at = s + sim.int(5, 25);
          const m = pendingReturns.get(at) ?? pendingReturns.set(at, new Map()).get(at)!;
          m.set(v.idx, (m.get(v.idx) ?? 0) + r);
        }
      }
      onlineUnits += sOnline;
      posUnits += sPos;
      if (out) {
        const i = v.idx * D + d;
        sold[0]![i] = sOnline;
        sold[1]![i] = sPos;
        sold[2]![i] = sWh;
      }
    }

    // Transfers: the second warehouse refills the main one; the POS shop is topped up on Mondays.
    for (const v of variants) {
      if (!tracked(v)) continue;
      const e = expected(v, s);
      if (v.at[W1] && v.at[W2] && level[W2]![v.idx]! > 0 && level[W1]![v.idx]! < e * 5) {
        const move = Math.min(level[W2]![v.idx]!, Math.max(1, Math.round(e * 14)));
        addStock(s, v, W2, -move, "transfer");
        addStock(s, v, W1, move, "transfer");
      }
      if (dow === 1 && v.at[POS] && v.at[W1]) {
        const target = Math.max(1, Math.round(e * 0.26 * 14));
        const move = Math.min(target - level[POS]![v.idx]!, level[W1]![v.idx]! - Math.round(e * 3));
        if (move > 0) {
          addStock(s, v, W1, -move, "transfer");
          addStock(s, v, POS, move, "transfer");
        }
      }
    }

    // The merchant's orders: each supplier on its cycle; vendor-only products every 21 days.
    for (const sup of suppliers) {
      if ((s + supplierOffset.get(sup.key)!) % sup.orderCycleDays !== 0) continue;
      const o = placeOrder(s, sup, variantsOf.get(sup.key) ?? [], sup.leadTimeDays, sup.orderCycleDays);
      if (!o) continue;
      if (!lateMarked && sup.key === "ningbo" && s >= todayS - sup.leadTimeDays - 10 && s < todayS - sup.leadTimeDays + 25) {
        o.arrival = Math.max(o.arrival, todayS + 9);
        o.late = true;
        lateMarked = true;
      }
      openOrder(o);
    }
    if ((s + 11) % 21 === 0 && vendorOnly.length) {
      const o = placeOrder(s, null, vendorOnly, 21, 21);
      if (o) openOrder(o);
    }

    // End of day: stock rows (from the day a location first holds the variant) and the day's orders.
    if (out) {
      for (const v of variants) {
        if (!tracked(v)) continue;
        if (!stocked[v.idx]) {
          const any = v.at.some((on, loc) => on && level[loc]![v.idx]! !== 0);
          if (!any && s < created[v.product.idx]! + 2) continue;
          if (!any && created[v.product.idx]! > s) continue;
          stocked[v.idx] = 1;
          v.firstStock = d;
        }
        for (let loc = 0; loc < 3; loc++) if (v.at[loc]) stock[loc]![v.idx * D + d] = level[loc]![v.idx]!;
      }
      orders[d] = Math.round(onlineUnits / 1.6) + Math.round(posUnits / 1.3) + wholesaleOrders;
      // Product page visits: demand (not sales — sold-out pages still get visits) at ~2.2 % conversion.
      for (const p of products) {
        if (p.posOnly || !lifeFactor(p, s)) continue;
        let demand = 0;
        let soldOnline = 0;
        for (let k = p.idx * VARIANTS_PER_PRODUCT; k < (p.idx + 1) * VARIANTS_PER_PRODUCT; k++) {
          demand += p.base * variants[k]!.share * curve[p.season][s]! * lifeFactor(p, s) * promoFactor(p, s) * onlineShare(p) * WEEKLY_ONLINE[dow]!;
          soldOnline += sold[0]![k * D + d]!;
        }
        const visits = Math.round((demand / 0.022) * sim.logNormal(0.15));
        const search = Math.round(visits * 0.55);
        sessions.search[p.idx * D + d] = search;
        sessions.direct[p.idx * D + d] = visits - search;
        sessions.checkouts[p.idx * D + d] = Math.min(visits, Math.round(soldOnline / 1.6));
      }
    }
  }

  // ---- stock now and the open orders ----
  const stockNow: SimStore["stockNow"] = [];
  const incoming = new Map<number, number>();
  for (const o of open) {
    const sup = supplierByKey.get(o.supplierKey);
    if (sup?.viaShopify) for (const l of o.lines) incoming.set(l.variantIdx, (incoming.get(l.variantIdx) ?? 0) + l.qty);
  }
  for (const v of variants) {
    if (!tracked(v) || v.firstStock >= D) continue;
    for (let loc = 0; loc < 3; loc++) {
      if (!v.at[loc]) continue;
      const lv = level[loc]![v.idx]!;
      const onHand = Math.max(0, lv);
      // Today's online orders not shipped yet (main warehouse), and backorders (negative stock).
      const todayOrders = loc === W1 ? Math.min(onHand, sim.poisson(expected(v, todayS) * onlineShare(v.product) * 0.4)) : 0;
      const committed = todayOrders + Math.max(0, -lv);
      const inc = loc === W1 || (!v.at[W1] && loc === POS) ? (incoming.get(v.idx) ?? 0) : 0;
      stockNow.push({ variantIdx: v.idx, location: loc, onHand, committed, available: onHand - committed, incoming: inc });
    }
  }

  const purchaseOrders: SimPurchaseOrder[] = [];
  let n = 0;
  const dayS = (s: number) => dayOf(s);
  const expectedDayOf = (o: OpenOrder) => {
    const sup = supplierByKey.get(o.supplierKey);
    return dayS(o.day + (sup?.leadTimeDays ?? 21));
  };
  // History: the last received orders per supplier, and one cancelled order.
  for (const sup of suppliers) {
    const done = history.filter((o) => o.supplierKey === sup.key && o.arrival >= BURN_IN_DAYS).slice(-3);
    for (const o of done) {
      purchaseOrders.push({
        n: ++n,
        supplierKey: sup.key,
        source: sup.viaShopify ? "shopify" : "keha",
        status: "received",
        createdDay: dayS(o.day),
        sentDay: dayS(o.day),
        expectedDay: expectedDayOf(o),
        confirmedShipDay: null,
        receivedDay: dayS(o.arrival),
        cancelledDay: null,
        arrivalDay: dayS(o.arrival),
        lines: o.lines,
      });
    }
  }
  // Open (on their way): sent; long-lead orders confirmed with a ship date (arrival = ship + transit).
  for (const o of open) {
    const sup = supplierByKey.get(o.supplierKey) ?? null;
    if (!sup) continue; // vendor-only products: ordered outside Keha and Shopify (their stock just arrives)
    const confirmed = !sup.viaShopify && (sup.country === "CN" || sup.country === "TR");
    purchaseOrders.push({
      n: ++n,
      supplierKey: sup.key,
      source: sup.viaShopify ? "shopify" : "keha",
      status: confirmed ? "confirmed" : "sent",
      createdDay: dayS(o.day),
      sentDay: dayS(o.day),
      expectedDay: expectedDayOf(o),
      confirmedShipDay: confirmed ? dayS(o.arrival - sup.transitDays) : null,
      receivedDay: null,
      cancelledDay: null,
      arrivalDay: dayS(o.arrival),
      lines: o.lines,
    });
  }
  const knit = suppliers.find((s) => s.key === "porto");
  const denim = suppliers.find((s) => s.key === "istanbul");
  const firstLines = (key: string, k: number, qty: number) =>
    (variantsOf.get(key) ?? []).filter((v) => v.product.status === "ACTIVE" && !v.product.noReorder && v.product.lifecycle === "normal").slice(0, k).map((v) => ({ variantIdx: v.idx, qty }));
  const draftLines = { porto: firstLines("porto", 5, 12), istanbul: firstLines("istanbul", 5, 18), cancelled: firstLines("istanbul", 3, 30) };
  if (knit && draftLines.porto.length) {
    // A fresh draft (counts as ordered) and an old one nobody sent (stops counting after 14 days).
    purchaseOrders.push({ n: ++n, supplierKey: "porto", source: "keha", status: "draft", createdDay: addDays(today, -2), sentDay: null, expectedDay: null, confirmedShipDay: null, receivedDay: null, cancelledDay: null, arrivalDay: null, lines: draftLines.porto });
  }
  if (denim && draftLines.istanbul.length) {
    purchaseOrders.push({ n: ++n, supplierKey: "istanbul", source: "keha", status: "draft", createdDay: addDays(today, -20), sentDay: null, expectedDay: null, confirmedShipDay: null, receivedDay: null, cancelledDay: null, arrivalDay: null, lines: draftLines.istanbul });
    purchaseOrders.push({ n: ++n, supplierKey: "istanbul", source: "keha", status: "cancelled", createdDay: addDays(today, -60), sentDay: addDays(today, -59), expectedDay: addDays(today, -24), confirmedShipDay: null, receivedDay: null, cancelledDay: addDays(today, -50), arrivalDay: null, lines: draftLines.cancelled });
  }

  const rateNow = new Float64Array(V);
  for (const v of variants) rateNow[v.idx] = lifeFactor(v.product, todayS - 1) ? v.product.base * v.share * curve[v.product.season][todayS]! : 0;

  return {
    meta: { size, seed, today, yesterday, from, days: D, currency, timezone: opts.timezone ?? "Europe/Madrid", locale: opts.locale ?? "en", idPrefix: prefix },
    locations,
    suppliers,
    collections,
    products,
    variants,
    stock,
    sold,
    returned,
    sessions,
    orders,
    stockNow,
    purchaseOrders,
    ledger,
    truth: { rateNow, lost },
  };
}

/** Unit price of a variant (the gift card's amounts are its variants). */
export function simPrice(v: SimVariant): number {
  return v.product.productType === "Gift cards" ? Number(v.variantTitle.replace(/\D/g, "")) : v.product.price;
}

/** Output day index → day. */
export function simDay(store: SimStore, d: number): DayKey {
  return addDays(store.meta.from, d);
}

/** Supplier of a variant as the store would match it (explicit, then vendor). */
export function simSupplierOf(store: SimStore, v: SimVariant): SimSupplier | null {
  if (v.supplierId) return store.suppliers.find((s) => s.id === v.supplierId) ?? null;
  return store.suppliers.find((s) => s.vendorMatch.includes(v.product.vendor)) ?? null;
}
