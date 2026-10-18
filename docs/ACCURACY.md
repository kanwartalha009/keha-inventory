# Forecast accuracy on real data

Three rounds on the same store: **accuracy audit 2026-10-18** (this section), the **2026-10-17
engine round** and **R4** (the original measurement), both kept further down. Aggregates only: no
store name, no product names, no customer data, no money.

## Reproduce it: `npm run accuracy`

Since 2026-10-18 the harness and its data are in the repository (`scripts/accuracy/`): the app's
real engine on a frozen, anonymised copy of the R4 data, `scripts/accuracy/data/store.json.gz`
(18 KB). It holds random variant ids, the ABC role, net units sold per day, the sold-out days and the
store's total units per day — no product names, SKUs, titles, handles, prices, money or store name
(`tests/accuracy-dataset.test.ts` keeps it that way). The calendar start (2024-09-01) is kept:
weekdays and Black Friday must line up for the seasonal index. 38 variants (25 A, 8 B, 5 C), 776
days. It reproduces the 2026-10-17 forecast-error numbers below exactly (that round's service
simulation valued stock in euros and refreshed the role priors daily; `--service` reports units and
refreshes them weekly, so its figures are not comparable one to one).

| Command | What it runs |
|---|---|
| `npm run accuracy` | the three cutoff sets below, H = 28 / 56 / 90 days, Keha vs naive vs seasonal naive |
| `-- --mode holdout --strict` | the hold-out only; refuses any parameter change |
| `-- --mode random --samples 600 --seed 7` | another random sample |
| `-- --young 365` | as if the store had only 365 days of history at each cutoff |
| `-- --service '{"L":90,"R":30,"late":0.25,"lateMax":0.3,"moqDays":30,"start":"2025-06-01"}'` | the service simulation: fill vs each role's target, stock in units and days |

Cutoff sets: **rolling** — every 28 days from 2025-10-06 (the earlier rounds' grid); "tune" =
horizon ends before the hold-out, "hold" = starts in it. **Hold-out** — weekly cutoffs whose whole
horizon lies in the last 120 days (2026-06-19 … 2026-10-16); `--strict`: engine defaults, nothing
tuned in this round looked at these numbers first (the earlier rounds' last two cutoffs fall in this
period, so it is not data no one has ever seen). **Random** — 400 seeded (cutoff, variant) pairs,
cutoffs anywhere from day 120 (before the seasonal index exists, "season unknown") to the end.
Baselines: naive = the last 28 days' mean × H; seasonal naive = the same H days 364 days earlier,
naive where the variant is younger than that (the count in brackets in the harness output).

Limit that the random mode does not remove: the 38 variants are today's best sellers. A sample of
"what the store sold then" would need the whole catalogue, which was not transcribed.

## What changed (accuracy audit 2026-10-18)

| # | Defect found | Fix | Fixture before → after |
|---|---|---|---|
| 1 | Spike cap could cap only max(1, ⌊1 % × days⌋) days: with < ~200 days of history two wholesale days passed uncapped | High days grouped into bursts; bursts ≤ 7 days are spikes and capped; recurring when ≥ 3 such days in ≥ 3 months, then their units above the cap and above their own weeks' level are averaged over the last year and added back; longer runs (a season, a viral product) are not capped | 2 × 300 units on a 2-a-day product, 150 days: pace 11.84 → 2.39, order 606 → 42. Five 300-unit orders a year: order 602 / 431 (two vs one in the last 90 days) → 93 / 90 |
| 2 | Long lead times: the fill-rate rule gave k ≈ 0 (lead 75 + cycle 60: safety 0 on 1,350 units) and A items fell short of 95 % | A items: k ≥ 1.5 × z, ramped in from a 42- to a 90-day lead time (error-shared `longLeadFloor`) | k 0 → 1.70, safety 0 → 120 units; service below |
| 3 | A group needed 2,000 units / 12 months for its own seasonal index, else the store's: a small store's swimwear got the store's flat shape | Smaller groups (≥ 50 units) blend: group^w × store^(1 − w), w = u(2000 + K) ÷ (2000(u + K)), K = 100 (1 from 2,000 units: unchanged there) | Small store (swimwear and coats ~620 units a year each): swimwear in January ordered now → "Next season" |
| 4 | < 13 months of sales: no seasonal index, so no level-shift detection | Without an index the shift test runs on raw sales and keeps only drops; Dashboard and product page say "Seasons: learning — {n} of 13 months" (a status, not a banner) | 10 → 1 a day: pace 3.18 → 1.00, order 64 → 12 |
| 5 | The backtest lived outside the repository | `npm run accuracy` on the frozen anonymised data (above) | — |
| 6 | A late purchase order counted as arriving today without a word | Still lands today in the projection; "An open order is {n} days late: counted as arriving now, with {units} more safety while it is late." in Why this quantity; safety + the forecast × min(days late, 7) | 200 units 12 days late, 10 a day: no word, safety 0, order 140 → "12 days late", safety 70, order 210 |

Parts measured and not used:
- **Bias correction for A items** (adding the role's measured backtest bias × the protection
  period's demand to safety): at lead 90 days +1.3 points of A fill for +21 % stock — the floor did
  more per unit of stock.
- **Raw-sales level shifts in both directions** for young stores: 28 / 56 / 90-day WAPE 34.6 / 37.0
  / 38.9 % → 36.0 / 38.7 / 41.2 % (`--young 365`; the November peak read as a new level). Drops
  only: 34.6 / 37.2 / 39.1 % — kept.
- **Every run of high days as a spike** (no 7-day limit): the real store's hold-out was slightly
  better (28 days 25.7 %), but in a store without a seasonal index yet the December peak was spread
  over its first months (28-day bias +25 → +35 % on those cutoffs).
- **Short bursts without the own-level floor**: the simulated store ordered its winter coats 40 % up
  in October (last winter's days added back against this summer's cap).
- **A partial year** (e.g. 9 months) for a seasonal comparison: the index compares the coming weeks
  with the same weeks a year earlier, which a 9-month history has not seen; nothing sound to
  measure on this data (a group-vs-store shape over the months seen needs groups, which the frozen
  data does not hold).

## Forecast error now (HEAD 51de671 → this round)

WAPE / bias, %. Keha before → after; naive and seasonal naive don't change.

**Hold-out** (weekly cutoffs in the last 120 days, strict):

| H | n | Keha before | **Keha after** | Naive | Seasonal naive |
|---|---:|---:|---:|---:|---:|
| 28 days | 520 | 27.5 / −9.6 | **27.2 / −10.3** | 28.2 / −6.8 | 55.1 / −45.2 |
| 56 days | 368 | 25.5 / −16.1 | **25.7 / −16.3** | 25.1 / −15.6 | 53.5 / −49.1 |
| 90 days | 180 | 31.3 / −21.1 | **31.4 / −21.2** | 34.8 / −23.8 | 53.5 / −49.0 |

**Rolling** (13 / 12 / 11 cutoffs every 28 days from 2025-10-06):

| H | Group | n | Keha before | **Keha after** | Naive | Seasonal naive |
|---|---|---:|---:|---:|---:|---:|
| 28 | All | 440 | 31.7 / −5.4 | **31.6 / −6.3** | 37.5 / −3.2 | 61.0 / −17.5 |
| 28 | A / B / C WAPE | 279 / 96 / 65 | 31.5 / 34.3 / 45.3 | **31.4 / 34.1 / 45.0** | 36.9 / 46.9 / 59.6 | 60.9 / 62.5 / 64.6 |
| 56 | All | 402 | 30.2 / −9.1 | **30.3 / −9.7** | 39.7 / −7.0 | 60.6 / −17.8 |
| 56 | A / B / C WAPE | 254 / 88 / 60 | 30.1 / 30.2 / 34.6 | **30.3 / 29.1 / 34.2** | 39.4 / 47.0 / 53.8 | 60.6 / 59.2 / 62.0 |
| 90 | All | 364 | 29.8 / −6.2 | **29.7 / −6.8** | 42.9 / −4.9 | 60.9 / −15.0 |
| 90 | A / B / C WAPE | 229 / 80 / 55 | 29.7 / 33.1 / 30.7 | **29.6 / 31.9 / 30.4** | 42.7 / 48.8 / 50.0 | 61.0 / 57.5 / 61.8 |

**Random** (400 pairs, seed 1; "season unknown" = cutoffs in the store's first 13 months):

| H | Group | n | Keha before | **Keha after** | Naive | Seasonal naive |
|---|---|---:|---:|---:|---:|---:|
| 28 | All | 400 | 37.7 / +7.4 | **37.8 / +6.8** | 44.8 / +11.5 | 58.1 / +0.5 |
| 28 | Season known / unknown WAPE | 211 / 189 | 32.2 / 46.3 | **32.4 / 46.1** | 41.4 / 50.0 | 62.1 / 52.0 |
| 56 | All | 400 | 40.1 / +12.1 | **40.1 / +11.1** | 46.9 / +15.4 | 62.1 / +2.0 |
| 90 | All | 400 | 43.9 / +11.7 | **43.0 / +10.3** | 54.8 / +11.5 | 67.3 / +7.2 |

Reading it honestly:
- **This round fixes the audit's cases; it does not make this store's forecast better.** The
  all-variant WAPE moved by at most 0.3 points on the rolling and hold-out cutoffs (random sample:
  −0.9 at 90 days); bias moved 0.1–0.9 points further negative there (fewer high days kept in the
  pace windows).
- **On the hold-out Keha beats naive at 28 days (27.2 vs 28.2 %) and 90 days (31.4 vs 34.8 %) but
  still loses at 56 days (25.7 vs 25.1 %).** It beats seasonal naive everywhere by a wide margin
  (seasonal naive misses this store's doubling year on year).
- **Bias stays negative for A items** (−10.5 % at 28 days, −16.8 / −21.5 % at 56 / 90 days on the
  hold-out): the store's growth, which the forecast doesn't extrapolate (trend off, owner decision
  C4). The long-lead floor (below) protects the fill against it; the forecast itself still lags.
- In the store's first 13 months (no seasonal index) Keha is only a little better than naive
  (28 days 46.1 vs 50.0 %) and both run ~25 % high: after the first Black Friday the pace falls
  slower than demand, and without a year of history there is no season to say so.

## Service level at long lead times (fill vs target)

`--service`, balanced safety level, lost sales when out, 25 % of deliveries late by up to 30 % of
the lead time (seeded; the engine gets their measured σ after 3 deliveries, as compute does), a
supplier minimum of 30 days of each variant's demand, simulated from 2025-06-01, measured after a
warm-up of L + R days. Fill per role (target), stock = the average units on the shelf; days =
each variant's average stock ÷ its average daily demand, averaged.

| Lead / cycle | Role (target) | Fill before | **Fill after** | Stock before | **Stock after** |
|---|---|---:|---:|---:|---:|
| 90 / 30 | A (95) | 90.2 % | **94.3 %** | 35.9 k u · 105 days | 56.4 k u · 163 days (+57 %) |
| 90 / 30 | B (90) / C (85) | 95.8 / 100.0 % | 95.8 / 100.0 % | | unchanged |
| 135 / 30 | A (95) | 92.1 % | **94.4 %** | 59.2 k u · 173 days | 81.7 k u · 234 days (+38 %) |
| 135 / 30 | B / C | 97.8 / 100.0 % | 97.8 / 100.0 % | | unchanged |
| 75 / 60 | A (95) | 92.6 % | **95.1 %** | 46.1 k u · 121 days | 55.4 k u · 147 days (+20 %) |
| 75 / 60 | B / C | 96.4 / 100.0 % | 96.4 / 100.0 % | | unchanged |
| 14 / 14 (no late, no minimum) | A / B / C | 94.1 / 93.4 / 89.3 % | unchanged (the floor starts above 42 days) | 5.8 k u | unchanged |
| 42 / 14 (no late, no minimum) | A / B / C | 94.9 / 99.1 / 96.5 % | unchanged | 12.8 k u | unchanged |

Naive order-up-to (c × z × σ × √(L + R)) at lead 90: A fills 77.4 / 80.6 / 84.4 % at c = 1 / 2 / 3
for 30.3 / 35.0 / 41.7 k units; at lead 135: 80.9 / 81.4 / 82.2 % for 47.6 / 55.6 / 64.4 k units.

- **Calibration met for A** at 90 / 135 days and at lead 75 + cycle 60 (within 0.7 points).
- **The cost is real stock**: +20 % to +57 % of A units at those lead times. On the simulator store
  (sim:check, 17 Oct, Ningbo Outerwear: lead 75, winter coats in season) the week's order rose from
  1,090 to 1,980 units (€72 k → €125 k) while the next 13 weeks rose 10,105 → 10,345 units: the floor
  pulls stock forward into the season. A multiple of 1.3 instead of 1.5 (measured with the earlier
  spike rule): A 92.9 % at both 90 and 135 days for +39 % / +23 % stock — about 2 points short.
- **B and C overshoot** (96–100 % against 90 / 85 %) and the floor doesn't touch them: at these lead
  times the supplier minimum (30 days of demand) and the order cycle already hold more than the
  target needs; lowering safety can't go below 0.
- Late deliveries themselves cost little here (lead 90, no minimum, an earlier engine of this round:
  A 91.0 % with none late, 90.6 % with 25 % late): the measured lead-time spread already sits in
  the safety stock. The shortfall was the forecast running low on fast sellers over long horizons.

## Limits of the 2026-10-18 numbers

- One store, 38 variants (B and C rest on 8 and 5 products), today's best sellers.
- No season groups in the frozen data: the group blend (3) is pinned by the unit fixture and seen
  on the simulator store only (sim:check: next 13 weeks 10,193 → 10,105 units).
- The service simulation refreshes the roles' pooled error ratios weekly (compute does it nightly).
- Stock in units, not money: the dataset holds no prices.

---

# 2026-10-17 engine round (before this audit)

Measured with the throwaway scripts of that round, on the same data now frozen in
`scripts/accuracy/data` (`npm run accuracy` reproduces the forecast-error tables exactly).

## What changed

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
