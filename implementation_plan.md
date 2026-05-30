# Implementation Plan - algoOptions (NSE Options Simulator & Backtester)

We will build **algoOptions**, a premium, high-fidelity **NSE Options Trading Simulator & Strategy Backtester**. The application will focus exclusively on NSE options contracts (NIFTY, BANKNIFTY, FINNIFTY, and high-liquidity stock options).

When the user specifies an underlyer and input parameters, the system will **dynamically fetch real-time option chain data directly from the NSE website** using a Python-based secure HTTP bridge. It will then reconstruct historical options pricing using a client-side **Black-Scholes-Merton (BSM) Options Pricing Engine** to backtest multi-leg strategies over any selected date range.

---

## Technical Architecture & File Structure

We will create a self-contained local web server architecture in `E:\work\trader`:

```
algo-options/
├── server.py             # Python HTTP server serving the frontend, downloading live NSE data, and generating historical underlyer series
├── index.html            # Main UI structure using clean HTML5, Lucide Icons, and Chart.js CDNs
├── styles.css            # Vanilla CSS defining high-end glassmorphic dark theme and interactive tabs
├── app.js                # Core JS managing UI state, tabs, payoff graphs, and user controls
├── option-math.js        # Black-Scholes-Merton math engine calculating Option Prices & Greeks (Delta, Gamma, Theta, Vega)
├── simulator.js          # Options backtesting engine simulating daily step-through, DTE decay, and multi-leg PnL
└── strategies.js         # Pre-configured multi-leg option strategies (Iron Condor, Straddle, Spreads, etc.)
```

---

## Design System & Aesthetics (Vanilla CSS)
- **Theme**: Slate/Obsidian high-end financial dark mode with glowing accents.
  - **Neon Green** (`hsl(142, 70%, 45%)`) for Profits, Long Positions, and Buy Alerts.
  - **Neon Rose** (`hsl(346, 80%, 55%)`) for Losses, Short Positions, and Sell Alerts.
  - **Cyan/Sky** (`hsl(190, 85%, 55%)`) for Calls, Delta/Gamma curves.
  - **Warm Amber** (`hsl(40, 90%, 55%)`) for Puts, Theta/Vega metrics.
  - **Electric Indigo** (`hsl(250, 85%, 65%)`) for primary buttons and interactive hover borders.
- **Glassmorphism**: Panels with thin borders (`1px solid rgba(255,255,255,0.08)`) and high-end background blur for charts, payoff models, and ledger tables.
- **Layout**: Dynamic split-screen layout. Left side controls the ticker, parameters, and legs; right side visualizes the Payoff Graph, technical pricing, trade ledger, and historical backtests.

---

## Core Components & Implementation Details

### 1. Python Bridge & Server (`server.py`)
- Standard-library based Python HTTP server (`http.server` and `urllib.request`).
- Requires **zero external dependencies** (no pip install required) to guarantee 100% out-of-the-box reliability.
- **`/api/fetch-options` endpoint**:
  - Implements standard browser session spoofing: visits `nseindia.com` to capture cookies, then requests `https://www.nseindia.com/api/option-chain-indices?symbol=SYMBOL` with the session cookies.
  - Auto-decompresses gzip/deflate payloads and returns the structured option chain JSON directly to the JS frontend.
- **`/api/historical-underlying` endpoint**:
  - Delivers high-fidelity 2-year daily historical spot price data for NIFTY and other tickers to drive the BSM options reconstruction.

### 2. Black-Scholes Options Pricing Engine (`option-math.js`)
- Standard implementation of the Black-Scholes-Merton equations:
  - **Option Premium Pricing**: Call and Put theoretical values given Spot ($S$), Strike ($K$), time to expiry in years ($t$), volatility ($\sigma$), and risk-free interest rate ($r$).
  - **Option Greeks**:
    - **Delta**: Price sensitivity.
    - **Gamma**: Delta sensitivity.
    - **Theta**: Time decay (expressed in daily decay).
    - **Vega**: Volatility sensitivity.
  - **Cumulative Standard Normal Distribution ($N(x)$)**: High-accuracy numerical approximation.

### 3. Multi-Leg Strategy Builder & Interactive Option Chain
- **Option Chain Board**: Sleek table showing Call details on the left, Strikes in the middle, and Put details on the right.
- **Leg Builder**: Add up to 4 custom option legs with adjustable controls:
  - Buy/Sell toggles.
  - Option Type (Call `CE` / Put `PE`).
  - Strike Price selector (filled dynamically from the live NSE option chain).
  - Expiry Date selector (filled dynamically from live NSE expirations).
  - Quantity (Lots).
- **Payoff Graph**: A Chart.js curve modeling the net Profit & Loss at Expiry across a range of underlying spot prices. Displays Breakeven points, Max Profit, and Max Loss.

### 4. Options Backtester Engine (`simulator.js`)
- Step-by-step timeline execution.
- Steps through the historical date range, pricing the options legs daily based on the actual historical price of the underlying, subtracting Theta (time decay), adjusting for Delta/Gamma (price movement), and executing target profit or stop losses.
- Computes aggregate portfolio Greeks (Net Delta, Gamma, Theta, Vega) dynamically at every day in the simulation.
- Records a detailed trade ledger showing initial leg entry pricing, daily valuations, and final settlement details.

---

## Pre-Built Option Strategies (`strategies.js`)
1. **Long Straddle / Strangle**: Pure volatility plays. Buy ATM/OTM CE and PE.
2. **Bull Call / Bear Put Spread**: Directional risk-defined spreads.
3. **Iron Condor**: Neutral range play. Sell OTM Put/Call, buy further OTM Put/Call for protection.
4. **Iron Butterfly**: Neutral ATM play. Sell ATM Put/Call, buy OTM Put/Call.
5. **Short Strangle**: Premium collection strategy. Sell OTM CE and PE.

---

## Verification Plan

### Automated / Formula Tests
- Verify Black-Scholes engine matches standard benchmark options calculators (e.g. S=18000, K=18000, t=30/365, r=0.07, IV=0.15 should result in standard premiums).
- Check that the Python bridge successfully handles cookie generation and decompresses binary gzip streams.

### Manual Verification
- Test running the server locally, loading the application, downloading the live NIFTY option chain.
- Construct various multi-leg strategies and verify that the payoff diagram recalculates dynamically when modifying quantity or premiums.
- Run a historical backtest and verify that the equity curve and Greek changes are correctly displayed on the charts.

---

## Open Questions & Review Required

> [!IMPORTANT]
> To comply with NSE data constraints:
> - **Live Option Chain**: Real data is downloaded directly from NSE.
> - **Historical Options Prices**: Because NSE does not offer free historical options data, we reconstruct past options values dynamically using the BSM formula mapped to real historical daily underlying prices. This creates an incredibly powerful, mathematically sound backtester.
> 
> Once you approve this, I will create `server.py`, the frontend assets, and run the server so you can experience it.

---

## Post-Build Hardening (added after first implementation)

The initial build was complete but its backtester did not yet measure what it
claimed. The following steps were added and implemented to make the results
trustworthy, the data honest, and the promised features real. Tiers run by
severity (T0 = trust, highest).

### T0 — Trust (the backtester must measure what it claims)
1. **Reproducible underlying.** Replaced Python's per-process-randomized
   `hash(symbol)` seed with a deterministic `stable_seed()` so a symbol's
   2-year path is identical across server restarts (`server.py`).
2. **Dynamic IV path → live vega P&L.** `server.py` now emits a per-day IV
   (mean-reverting, rises on down moves); `simulator.js` prices entry *and*
   daily revaluation at each day's IV instead of one frozen constant — so
   short-premium strategies (Iron Condor, Short Strangle) finally show real
   IV-driven P&L.
3. **Margin model.** `simulator.js` `estimatePositionMargin()` blocks worst-case
   loss for defined-risk spreads and a SPAN-style % of notional for naked
   shorts; trades exceeding available capital are skipped. Results expose
   "Peak Margin Utilization", making return-on-capital meaningful.

### T1 — Correctness bugs
4. Custom legs **re-strike** relative to entry-day spot each roll (offsets via
   `customLegsSpot`), instead of clinging to stale absolute strikes.
5. Documented that **historical entry must be priced theoretically** (BSM),
   reconciling the payoff-diagram-vs-backtest premium difference.
6. **Updated NSE lot sizes** (NIFTY 75, BANKNIFTY 35, FINNIFTY 65, …).
7. Fixed PE exit-premium bug (`l.spot` → `spot`) that wrote NaN to the ledger.
8. Greeks chart now actually **plots Gamma** (was promised in the legend only).

### T2 — Honesty & fidelity
9. `dataSource: "live" | "simulated"` flag surfaced in the status pill — no more
   "Live" label on mock fallback.
10. Robust response decompression (gzip **and** deflate); dropped the
    unsupported `br` from `Accept-Encoding`.
11. Target-DTE change now reprices the active legs.
12. **Real lognormal-weighted POP** (not a point-count heuristic); "Unlimited"
    profit/loss derived from net call exposure instead of a magic threshold.

### T3 — Features
13. **Breakeven markers** + zero reference line on the payoff diagram.
14. **Automated BSM tests** in `test/option-math.test.js`
    (`node test/option-math.test.js`) — benchmark case + put-call parity,
    validated against an independent erf-based reference.
15. **CSV export** of the trade ledger and equity curve.
16. `README.md` documenting run steps, the zero-dependency design, and the
    live-vs-simulated / illustrative-backtest caveats.

> [!NOTE]
> The historical backtest remains a **BSM reconstruction over a *simulated*
> underlying path**, not real market history (NSE offers no free historical
> options data). This is now labeled in the UI and README. To make it a *real*
> backtester, plug a genuine OHLC + IV source behind the existing
> `/api/historical-underlying` contract.
