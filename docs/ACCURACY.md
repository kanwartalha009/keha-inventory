# Forecast accuracy on real data

Two rounds on the same data and method (below): **2026-10-17 engine round** (this section) and
**R4** (the original measurement, kept further down). Aggregates only: no store name, no product
names, no customer data. The throwaway scripts and the transcribed daily figures stay outside the
repository. Every number below comes from the app's own engine (`app/lib/engine`) run on the
read-only real-store data R4 transcribed (38 variants, 776 days); no new store data was read.

## Engine round 2026-10-17: what changed

| Change | Where | Why |
|---|---|---|
| Seasonal index with one year of history: soft threshold in log space (`exp(sign(l)·max(0, \|l\| − 0.2))`, l = ln raw) instead of `1 + 0.5 × (raw − 1)` | `season-shared` shrinkRaw | The linear shrink halved every season: swimwear in winter was planned at ~60 % of its summer base instead of ~30 %, and peaks were cut. A change within −18 % … +22 % is still treated as noise. |
| Season groups' daily sales loaded for every day through yesterday | `season.server` | The days between last year's horizon and the last 28 days were not loaded and read as zero sales (in the loader's test fixture a group's 90-day levels covered 38 of the 90 days). |
| Spike cap removes one-offs only: when more than 1 % of the 14 months' in-stock days are above the robust cap, the cap rises to the highest day outside that top 1 % | `outliers-shared` | Cause of the fast-seller under-forecast (below). |
| Level-shift detection (×2 up / below ⅓ down, ≥ 4 weeks, weekly-block z ≥ 4, raw sales moving the same way, de-seasonalised by the group's level) | `level-shift-shared` | Viral / dead products. Deliberately strict: see "Level shifts". |
| Safety stock from the forecast's own error and the fill target | `error-shared` | The calibration gap (fills 88–91 % against 95 / 90 / 85 %). |
| Off season, overdue dates, minimums in the forward plan | `forward-plan-shared` | Merchant-trust anomalies found by the simulator (end of this section). |

### Why fast sellers ran 8–12 % low (B6)

Two causes, measured on the A items at 28 days (bias = Σ(F − A) ÷ ΣA):

1. **The spike cap clipped recurring demand.** 2.5 % of A items' in-stock days were above the
   k = 4 robust cap, removing 3.3 % of their units. Those were not one-offs (promotion and campaign
   days recur). k = 4 had been chosen on WAPE, which is minimised by the *median* of the demand
   distribution; on right-skewed daily sales the median is below the mean the order quantity
   needs. Fixed by capping only the top 1 % of the item's own 14 months (a single wholesale day is
   still capped). A bias −8.8 → −6.4 % (with the new seasonal index), WAPE +0.7 points: the honest
   price of an unbiased mean.
2. **The store's own growth.** It doubled year on year; every forecast built from past weeks lags
   it. The naive last-28-days forecast is itself −3.4 % (28 days) / −7.4 % (56 days) on A items.
   The rest of Keha's bias beyond naive (≈ 2 points) is the 28 / 56 / 90-day blend being older than
   28 days. Not corrected: the growth assumption (trend) is off by owner decision (C4), and a
   store-level "acceleration" factor tested here (YoY of the last 28 days ÷ YoY of the blend) did
   not predict the next 28 days (it pointed up before both of the store's dips).

Partial days (the day it ran out) were checked too: marking them in the transcribed data (a sold
day followed by a sold-out day) moved nothing measurable (only 155 sold-out variant-days).

### Forecast error, before → after (rolling origin, 13 / 12 cutoffs, last 2 held out)

WAPE / bias, %. "Before" = HEAD 2e09ad6 (R4), "after" = this round; naive = last 28 days.

| H = 28 days | n | Before WAPE | Before bias | **After WAPE** | **After bias** | Naive WAPE | Naive bias |
|---|---:|---:|---:|---:|---:|---:|---:|
| All | 440 | 32.2 | −7.7 | **31.7** | **−5.4** | 37.5 | −3.2 |
| A | 279 | 32.0 | −8.1 | **31.5** | **−5.8** | 36.9 | −3.4 |
| B | 96 | 35.5 | +2.5 | **34.3** | +3.6 | 46.9 | +2.3 |
| C | 65 | 46.3 | +2.7 | **45.3** | +2.5 | 59.6 | +2.3 |
| Tune (11) | 364 | 32.9 | −7.1 | **32.4** | −4.9 | 39.8 | −4.3 |
| **Hold-out (2)** | 76 | 28.9 | −10.5 | **28.7** | −8.0 | **26.3** | +2.0 |

| H = 56 days | n | Before WAPE | Before bias | **After WAPE** | **After bias** | Naive WAPE | Naive bias |
|---|---:|---:|---:|---:|---:|---:|---:|
| All | 402 | 31.4 | −11.0 | **30.2** | **−9.1** | 39.7 | −7.0 |
| A | 254 | 31.3 | −11.6 | **30.1** | **−9.6** | 39.4 | −7.4 |
| B | 88 | 32.3 | +3.9 | **30.2** | +4.6 | 47.0 | +3.5 |
| C | 60 | 37.0 | +4.1 | **34.6** | +3.5 | 53.8 | +4.1 |
| Tune (10) | 328 | 31.4 | −8.0 | **30.9** | −7.0 | 43.3 | −5.6 |
| **Hold-out (2)** | 74 | 31.2 | −24.3 | **27.0** | −18.3 | **24.1** | −13.4 |

Reading it honestly:
- Better than before at both horizons, in every ABC role, on the tune and the held-out cutoffs.
- **Still not better than naive on the two held-out cutoffs** (28.7 vs 26.3 at 28 days, 27.0 vs
  24.1 at 56). Both start in July–August 2026, when this store's sales did not follow last
  year's August dip (index 0.87; the store sold 0.97 × its last 28 days). A forecast that uses
  last year's shape loses to "same as last month" when the shape does not repeat; no change here
  can fix that without hurting the other eleven cutoffs (a softer index, δ = 0.3, beats naive on
  the 28-day hold-out — 24.3 % — but was not the choice on the tune cutoffs, so it is not used).
- Bias is within ±5 % for B and C and overall at 28 days only after rounding (−5.4 %); A items
  stay −5.8 % at 28 days and −9.6 % at 56 (the growth, above).

Seasonal shrinkage chosen on the tune cutoffs (28 + 56-day WAPE): linear 0.5 (before) 64.3;
soft δ 0.10 61.9, **0.15 61.5, 0.20 61.7**, 0.25 62.0, 0.30 62.8. 0.15 and 0.20 are within noise;
0.20 (a change within −18 % … +22 % of a normal week is noise) was kept.

### Level shifts (B5)

On this store a third to a half of the products "shift" by a looser test (×1.3, z 3.5, two weeks)
and those changes mostly reverted: using the new level raised 28-day WAPE from 31.6 to 37 %; even
×2 with weekly-block variance lost on the cases it fired on (44 % vs 36 % WAPE). Detection on raw
sales flagged the November peak (store-wide) as a product shift. So the bar is high (×2 up, below
⅓ down, four weeks, z ≥ 4 on weekly blocks, de-seasonalised, raw sales moving the same way) and
it is effectively neutral here (WAPE 31.6 → 31.7 %, bias −6.1 → −5.4 %); it exists for the viral
/ dead product the unit tests pin. Without a seasonal index (no group levels) nothing is detected.

### Safety stock from the forecast's own error (B4)

safety = k × σ_P, P = lead time + order cycle:
- σ_P = ρ × √(P·σ² + P²·Var(pace)) — the daily noise (σ ≥ the Poisson √forecast) plus the error
  of the pace estimate itself, which multiplies all P days (σ² × Σᵢⱼ wᵢwⱼ ÷ max(nᵢ, nⱼ) over the
  overlapping 28 / 56 / 90-day windows); + d²σ_L² with a measured lead-time spread.
- ρ = how much larger the engine's real error has been than that model: a rolling backtest at
  compute time, 13 weekly origins whose P days are in the past, the engine's own pace as of each
  day × the season multiplier those days really had (with 14 months of history the index itself
  can't be recomputed for a day months back), sold-out days left out on both sides. The ABC role's
  ratio is the median of up to 200 of its variants (a pre-pass, so chunking changes nothing); a
  variant's own backtest is pooled with it (role worth 8 windows; the variant's ≤ (84 + P) ÷ P).
- k = the fill-rate safety factor for the role's target (the safety level's service level,
  Balanced 95 / 90 / 85 %): σ_P·G(k) = (1 − β) × one cycle's demand (G = standard normal loss),
  k ≥ 0. The product page shows the fill target and the error; Why this quantity says what the
  safety covers.

Measured ratios on this store (median, A / B / C): 1.9 / 1.3 / 0.9 — A items' real 28-day errors
were about twice what daily noise suggests. Pooled by role vs. each variant's own ratio: the
variant's own 13 overlapping weeks put stock where the error *had been*: at equal stock about one
one to one and a half points of fill less (daily review, Balanced: 93.8 % for €588 k on the
variant's own ratio, 94.1 % for €584 k pooled at 2 windows; fully pooled 92.3 % for €456 k at
Balanced and 95.1 % for €550 k at Safe). Out of sample the next 28 days' errors were still larger than the
backtest's for A items (RMS of the standardised error ≈ 2.1–2.3 instead of 1): surges don't repeat on
schedule — the remaining reason A stays under its target.

### Service level vs stock, before → after (L = 14, R = 14; lost sales when out)

Two ways the merchant can follow the plan: **daily** — place each order on its order-by date (R4's
simulation, the plan's own semantics) — and **every cycle** — every R days order everything due
within the cycle (the supplier order builder's "due + can join"), the review the safety formula
assumes. Fill per role (target in brackets), stock-out days per variant-year, average stock (€ at
selling price).

| Daily review | A (95) | B (90) | C (85) | All | Stock-out days | Avg stock |
|---|---:|---:|---:|---:|---:|---:|
| Before, balanced | 90.0 | 94.9 | 91.3 | 90.2 | 18.5 | €403 k |
| **After, balanced** | **93.7** | **95.1** | **87.7** | **93.7** | **14.2** | **€528 k** |
| Before, lean (85 / 80 / 75) | 87.5 | 92.8 | 87.9 | 87.6 | 23.4 | €362 k |
| After, lean | 87.7 | 89.2 | 84.3 | 87.7 | 27.7 | €376 k |
| Before, safe (98 / 95 / 90) | 91.0 | 96.8 | 93.9 | 91.2 | 15.5 | €438 k |
| After, safe | 95.9 | 96.9 | 91.3 | 95.9 | 8.8 | €642 k |
| Naive c = 1 / 1.5 / 2 / 3 | — | — | — | 88.5 / 90.9 / 92.7 / 95.5 | 23.5 / 16.5 / 12.6 / 7.4 | €531 / 627 / 718 / 895 k |

| Every cycle | A (95) | B (90) | C (85) | All | Stock-out days | Avg stock |
|---|---:|---:|---:|---:|---:|---:|
| Before, balanced | 85.9 | 91.8 | 88.5 | 86.1 | 24.9 | €489 k |
| **After, balanced** | **92.6** | **93.7** | **86.2** | **92.6** | **18.5** | **€723 k** |
| Before, safe | 87.0 | 93.0 | 89.4 | 87.2 | 21.7 | €521 k |
| After, safe | 94.3 | 95.0 | 89.6 | 94.3 | 13.3 | €848 k |
| Naive c = 1 / 1.5 / 2 / 3 | — | — | — | 83.8 / 86.0 / 87.6 / 90.4 | 32.1 / 25.2 / 20.9 / 14.7 | €565 / 649 / 739 / 931 k |

- **Calibration.** Mean absolute gap to the targets at Balanced: daily 5.4 → 3.0 points, every
  cycle 4.8 → 2.4; at Safe (daily) 4.2 → 1.8. A is now 1.3 (daily) / 2.4 (cycle) points short
  (before 5.0 / 9.1); B is 3.7–5.1 points over (8 B items), C within 1.2–2.7. Lean overshoots B
  and C by ~9 points: k is 0 there and the order-up-to alone already fills ~85–90 %.
- **Stock against naive at equal fill:** daily Balanced 93.7 % for €528 k vs ≈ €781 k naive
  (−32 %); every cycle 92.6 % for €723 k, above naive's best setting (90.4 % for €931 k).
- **More stock than before** (Balanced daily €403 k → €528 k, +31 %) — that is the fill the
  targets ask for (A 90 → 93.7 %). At the low end the old σ model with this round's forecast was a
  little more stock-efficient (89.8 % for €378 k vs 87.7 % for €376 k at Lean); the error model
  wins on calibration, not on the lean end of the curve.
- Not met: "within 1–2 points of target per role" holds for A (daily) and C, not for B (+3.7 /
  +5.1) nor for A when ordering once per cycle (−2.4).

### Simulator anomalies (sim:check, S store, 17 Oct 2026)

| | Before | After |
|---|---|---|
| Swimwear in October | ordered now ("Overdue since 13 Jul"), arriving 16 Dec | "Next season: order by 10 Jan 2027", arriving 11 Mar (19 products) |
| Order this week | 6 suppliers, 1,617 units, €56 k; 6 of 6 suppliers "overdue", Guangzhou since 13 Jul, Ningbo since 14 Jun | 4 suppliers, 1,459 units, €75 k (winter coats for the season); dates within one lead time |
| "Overdue since" dates | 49 overdue products, dates back to 14 Jun (4 months) | none more than one lead time back (checked in sim:check and the e2e invariants); beyond it "Overdue · sold out since / runs out {date}" |
| Today's order-by date | printed "(overdue)" | "Due today" (one label rule, every screen) |
| Tiny need raised to a full style minimum | swimwear ordered in October (Guangzhou 336 units) | held back ("Below the supplier's minimum — wait for the next season or add to a larger order"; 2 styles in the January run, 0 in October) |

## Limits of the 2026-10-17 numbers

- One store, 38 variants (25 A, 8 B, 5 C): role results for B and C rest on few products.
- The compute-time backtest uses the season multiplier the days really had (the index can't be
  recomputed months back with 14 months of history): it measures the product's own error given
  its season, not the index's error — part of why A's real error is still larger.
- Level-shift detection is not applied at the backtest's origins (their levels are not stored).
- Per-location metrics (Pro) have no backtest of their own: the model's error × 1.
- The simulator store (sim:check, e2e-sim) checks the plan's behaviour, not accuracy: its demand is
  generated, so it is not used for any number above.

---

# R4 (2026-10-17, before this round)


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
