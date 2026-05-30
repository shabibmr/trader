# algoOptions — NSE Options Simulator & Strategy Backtester

A self-contained, **zero-dependency** local web app for exploring NSE option
chains and backtesting multi-leg option strategies. The frontend is vanilla
HTML/CSS/JS (Chart.js + Lucide via CDN); the backend is a single Python file
using only the standard library.

## Run it

```bash
python server.py
```

Then open <http://localhost:8080> in a browser. (No `pip install` needed.)

To run the math tests:

```bash
node test/option-math.test.js
```

## File structure

| File | Role |
|------|------|
| `server.py` | Stdlib HTTP server: serves the frontend, fetches live NSE option chains, and generates synthetic historical series |
| `index.html` | UI layout (option chain board, payoff diagram, backtest results, ledger) |
| `styles.css` | Glassmorphic dark theme |
| `app.js` | UI state, tabs, payoff chart, backtest orchestration, CSV export |
| `option-math.js` | Black-Scholes-Merton pricing + Greeks (Node-exportable, tested) |
| `simulator.js` | Daily-step backtest engine: rolling entries, IV path, margin, exits |
| `strategies.js` | Preset multi-leg strategies (Iron Condor, Straddle, spreads, …) |
| `test/option-math.test.js` | Independent-reference tests for the BSM engine |

## ⚠️ Important: what is real vs. simulated

This tool is **honest about its data**, because the distinction matters:

- **Live option chain** — `server.py` attempts to download the real chain from
  `nseindia.com` (cookie/session spoofing). NSE frequently blocks automated
  requests; when that happens the server returns a **synthetic** chain instead.
  The UI status pill shows **"NSE Live Feed Connected"** vs **"Simulated Chain
  (NSE unreachable)"** so you always know which you're looking at. (The server
  tags every chain response with a `dataSource: "live" | "simulated"` field.)

- **Historical backtests are illustrative, not real history.** NSE does not
  offer free historical options data, so the backtester runs on a **simulated
  underlying price path** (a reproducible random walk) and reconstructs option
  prices with Black-Scholes. The backtest results tab carries a visible
  disclaimer. Treat the equity curve as a *model illustration of strategy
  mechanics*, not as evidence of real-world performance.

## Methodology notes

- **Reproducibility** — the synthetic underlying is seeded deterministically
  from the symbol (`stable_seed`), so a given symbol produces the **same** path
  across server restarts. (Previously it used Python's per-process-randomized
  `hash()`, so every restart gave a different path.)
- **Dynamic IV** — each historical day carries its own implied volatility from a
  mean-reverting path that rises on down moves (leverage effect). The simulator
  prices entry and daily revaluation at that day's IV, so **vega P&L is real**
  rather than frozen at a single constant.
- **Margin** — short/credit positions block estimated capital (defined-risk
  spreads block their worst-case loss; naked shorts block a SPAN-style % of
  notional). Trades that exceed available capital are skipped, so
  return-on-capital and "Peak Margin Utilization" are meaningful.
- **Historical entry pricing is theoretical.** A live-chain LTP only exists for
  "today", so entries on past dates are necessarily priced via BSM at the
  historical spot/IV. This is why the payoff diagram (live LTP) and the
  backtest (theoretical) can differ for the same custom strategy.
- **Custom legs re-strike per roll** relative to the entry-day spot, keeping the
  strategy's moneyness consistent as the underlying drifts (presets already did
  this).

## Strategies included

Bull Call Spread, Bear Put Spread, Iron Condor, Long Straddle, Short Strangle,
Iron Butterfly — plus a custom up-to-4-leg builder driven from the option chain.
