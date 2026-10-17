# Forecast accuracy on real data (R4, 2026-10-17)

How well Keha's forecast and order advice do on a real store's history, measured with the
app's own engine (`app/lib/engine`), not a re-implementation. Aggregates only: no store name,
no product names, no customer data. The throwaway scripts and the transcribed daily figures
stayed outside the repository.

## Data

- One live Shopify store (accessories, one currency: EUR), read **read-only** through
  ShopifyQL: `sales` (net items sold per variant per day, per sales channel) and `inventory`
  (ending units per variant per day). Nothing was written to the store; no order or customer
  data was read.
- 38 of the store's best-selling variants: A 25, B 8, C 5 (ABC by 90-day revenue).
  26 of them launched inside the history.
- 776 days, 2024-09-01 … 2026-10-16, plus the store's total units per day (the store-level
  seasonal index, as compute uses for variants without a season group).
- Sold-out days: 155 variant-days since 2025-07-01 where the variant ended the day at ≤ 0 units
  across the store and sold nothing (the engine's sold-out rule). Stock-outs were read from
  2025-07-01 on only (earlier inventory rows came back without a variant through the read-only
  tool), so earlier stock-outs count as days that sold 0: every method looks slightly worse
  there, not better.
- Each transcription was checked against the store's own totals (ShopifyQL `summaryMetric`)
  before use.

## Method

- **Rolling origin.** 13 cutoffs, every 28 days from 2025-10-06. At each cutoff the engine sees
  only the days before it: the 90-day series, the 14-month older series for the in-stock pace,
  the store's seasonal index as of that day. Horizons 28 and 56 days (12 cutoffs for 56).
- **Forecast** = the engine's `cumulativeDemand(projection, H)`: pace × season shape × trend
  (trend off, the app default).
- **Baselines.** *Naive*: the last 28 days' mean × H. *Seasonal naive*: the same H days a year
  earlier (falls back to naive for variants younger than a year).
- **Error.** WAPE = Σ|forecast − actual| ÷ Σ actual; bias = Σ(forecast − actual) ÷ Σ actual
  (negative = forecast too low). Variant-cutoffs where the engine gives no forecast (not enough
  in-stock days) are left out of every method: 5.
- **No overfitting.** Parameters were chosen on the first 11 cutoffs ("tune"); the last 2
  ("hold") were only looked at after the choice.
- **Service simulation.** Day by day from 2025-10-06 (or 28 days after a launch) to the end, on
  the real daily demand (a censored sold-out day imputed at the trailing 28-day in-stock mean),
  lost sales when out (DENY). Keha: the real `computeVariant` + `planVariant`, ordering what the
  forward plan says to order today; lead time L, order cycle R = 14 days, Keha's safety levels
  lean / balanced / safe. Naive: order-up-to on the last 28 days' mean and σ, reorder point
  m·L + SS, order up to m·(L+R) + SS, SS = c · z(role) · σ · √(L+R), c = 1 … 3. Measured after a
  warm-up of L + R days. Fill = units served ÷ demand; stock value at the variant's average
  selling price (cost was not read, so euros are inflated by the margin, the same way for both).

## Forecast error (final engine: spikes capped at k = 4)

| H = 28 days | n | Keha WAPE | Keha bias | Naive WAPE | Naive bias | Seasonal naive WAPE |
|---|---:|---:|---:|---:|---:|---:|
| All | 440 | **32.2 %** | −7.7 % | 37.5 % | −3.2 % | 61.0 % |
| A | 279 | 32.0 % | −8.1 % | 36.9 % | −3.4 % | 60.9 % |
| B | 96 | 35.5 % | +2.5 % | 46.9 % | +2.3 % | 62.5 % |
| C | 65 | 46.3 % | +2.7 % | 59.6 % | +2.3 % | 64.6 % |
| Tune (11 cutoffs) | 364 | 32.9 % | −7.1 % | 39.8 % | −4.3 % | 62.5 % |
| **Hold-out (last 2)** | 76 | 28.9 % | −10.5 % | **26.3 %** | +2.0 % | 54.0 % |

| H = 56 days | n | Keha WAPE | Keha bias | Naive WAPE | Naive bias | Seasonal naive WAPE |
|---|---:|---:|---:|---:|---:|---:|
| All | 402 | **31.4 %** | −11.0 % | 39.7 % | −7.0 % | 60.6 % |
| A | 254 | 31.3 % | −11.6 % | 39.4 % | −7.4 % | 60.6 % |
| B | 88 | 32.3 % | +3.9 % | 47.0 % | +3.5 % | 59.2 % |
| C | 60 | 37.0 % | +4.1 % | 53.8 % | +4.1 % | 62.0 % |
| Tune (10 cutoffs) | 328 | 31.4 % | −8.0 % | 43.3 % | −5.6 % | 62.2 % |
| **Hold-out (last 2)** | 74 | 31.2 % | −24.3 % | **24.1 %** | −13.4 % | 53.5 % |

Before R4 (no spike capping, everything else equal): H = 28 all 33.5 % (bias −4.2 %),
hold-out 30.8 %; H = 56 all 32.8 % (bias −7.7 %), hold-out 30.9 %. Spike capping lowers WAPE by
1.3–1.4 points overall and ~1.9 points on the hold-out at H = 28, and moves the bias 3–3.5
points further negative (capped days were partly real demand).

**Reading it honestly.** Keha beats both baselines over the whole year, in every ABC role, at
both horizons. It does **not** beat the naive last-28-days forecast on the two hold-out cutoffs:
in August–October 2026 this store's sales level stepped up (new range, a promotion pattern the
year before didn't have), and a forecast that leans on last year's shape lags a level change
that the last 28 days already show. The bias is negative throughout for A items: Keha
under-forecasts the fast sellers by 8–12 %.

## Service level vs stock (L = 14, R = 14)

| Policy | Fill | Stock-out days / variant / year | Avg stock (€, at price) |
|---|---:|---:|---:|
| Keha lean | 87.6 % | 23.4 | 362,205 |
| Keha balanced | 90.2 % | 18.5 | 403,497 |
| Keha safe | 91.2 % | 15.5 | 438,249 |
| Keha before R4, lean | 89.9 % | 21.2 | 412,711 |
| Keha before R4, balanced | 91.7 % | 15.2 | 480,096 |
| Keha before R4, safe | 93.1 % | 12.4 | 523,222 |
| Naive c = 1 | 88.5 % | 23.5 | 530,788 |
| Naive c = 1.5 | 90.9 % | 16.5 | 626,543 |
| Naive c = 2 | 92.7 % | 12.6 | 718,139 |
| Naive c = 3 | 95.5 % | 7.4 | 894,521 |

- **At the same fill Keha holds about a third less stock than the naive reorder point**:
  90.2 % fill for €403 k vs ≈ €599 k for naive (interpolated), 91.2 % for €438 k vs ≈ €642 k
  (−32 … −33 %).
- **R4 against before R4, at equal stock:** ≈ +0.6 points of fill (at €413 k: 90.5 % vs 89.9 %;
  at €438 k: 91.2 % vs 90.6 %, interpolated). The trade-off curve moved the right way.
- **But each safety level now holds less.** With spikes capped, σ is smaller, so the same
  "balanced" setting holds 16 % less stock and fills 1.5 points less (91.7 → 90.2 %).
- **Calibration gap.** Keha's levels target ~90–97 % per item (z by ABC role); the fills reached
  are 88–91 %. Safety stock comes from σ of daily sales, not from the forecast's own error, so
  it under-protects when the forecast is biased low (A items, above). See "What would move it".

Lead time 42 days (R = 14): Keha lean / balanced / safe 85.2 / 86.9 / 88.0 % fill for
€464 k / €528 k / €574 k. The naive policy's lowest setting already holds €1.06 M for 89.3 %;
the two curves don't overlap, so no equal-fill comparison is claimed there. Long lead times
widen the calibration gap: the 42-day forecast error is larger than σ·√(L+R) assumes.

## Choices made from this data

| Choice | Value | Why |
|---|---|---|
| Spike cap | median + 4 × max(1.4826 · MAD, √mean), 90 most recent in-stock days, ≥ 14 days | H = 28 WAPE for k = 3 / 4 / 5 / off: 31.8 / 32.2 / 32.5 / 33.5 %, bias −9.6 / −7.7 / −6.6 / −4.2 %. Each step down in k buys a little WAPE with more under-forecast; k = 4 takes most of the gain for half the extra bias of k = 3. On by default; per product "Don't cap"; `spikeCapK = 0` turns it off for a store. |
| σ on de-seasonalised sales | on, only when it is below the raw σ; levels bounded to 0.5 … 2 | Service simulation (whole period, spikes not capped): ≈ +0.6 points of fill at equal stock (91.4 % at €447 k vs 90.8 % interpolated). Unguarded it inflated σ up to 8× for steady sellers in a collection that filled up during the window (the compute golden fixture showed it), hence the guard and the bounds. |
| Seasonal shrink (one year of history) | 0.5, unchanged | w = 0.4 … 0.8 with k = 4: H = 28 WAPE 32.2 … 33.1 % (best at 0.4–0.5), H = 56 31.4 … 30.5 % (best at 0.8), hold-out worse at higher w. The horizons disagree, so 0.5 stays. |
| Rate windows 28 / 56 / 90 × 0.5 / 0.3 / 0.2 | unchanged (owner decision proposed) | Adding a 14-day window (14 / 28 / 56 / 90 × 0.3 / 0.4 / 0.2 / 0.1) with k = 4: H = 28 31.6 % (vs 32.2), H = 56 30.4 % (vs 31.4), hold-out 30.7 / 26.2 % (vs 28.9 / 31.2). Better overall, worse on the H = 28 hold-out. The windows are in the spec (§7.2), so this is left for Kanwar to decide. |
| Draft Orders channel | counted by default | 5,479 items in 427 days (1.45 % of items), 1.0–1.25 items per order in every month (103 … 649 items a month, following the store's own season): steady single-item service orders that take stock, not wholesale ordered to order. Merchants who do sell wholesale through drafts can untick it (Settings → Defaults). |

## Limits

- One store, 38 variants. Another catalogue (long-tail, B2B, very seasonal) can rank the
  choices differently. The cap and the guard are robust by construction, but k = 4 is tuned here.
- Net items sold (returns netted out) is the demand measure, as the app stores it.
- Stock is valued at selling price (cost not read); ratios between policies are unaffected.
- Sold-out days before July 2025 are not marked (see Data).
- The partial-day rule (a day it ran out counts at the pace of full days) needs stock at day
  end per location; the transcribed data marks whole sold-out days only, so its effect is
  covered by the unit tests, not by these numbers.
- Bundles: this store sells none, so counting bundle sales on components is not measured here.

## What would move it toward 10/10 (not built: Feature Rule)

1. **Safety stock from forecast error** — σ of the engine's own past H-day errors per variant
   (or per ABC role while a variant is young) instead of σ of daily sales × √(L+R). It fixes the
   calibration gap and the long-lead-time case in one step.
2. **Level-shift detection** — when the last 28 days run well above the 90-day pace for several
   weeks, lean on the recent window (or the 14-day window above). It is what the hold-out cutoffs
   needed.
3. **Bias correction for A items** — measured on the store's own backtest (the app already runs
   one: `app/lib/engine/backtest-shared.ts`), shown to the merchant before it is applied.
