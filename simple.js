/**
 * algoOptions - Simple Mode
 * A beginner-first, decision-focused view layered on top of the existing
 * pricing/backtest engine. It owns no math of its own beyond friendly framing —
 * everything is computed via OptionMath / OptionStrategies / OptionSimulator and
 * shared through the global `state` object defined in app.js.
 */

(function () {
    'use strict';

    // ---- Simple-mode UI state (separate from app.js `state`, but writes the
    //      built legs back into state.activeLegs so Pro mode + backtest reuse them).
    const sm = {
        direction: 'bullish',
        strategyKey: 'bull_call_spread',
        dte: 30,
        iv: 15,
        width: 2, // strike spacing in strike-steps (1 tight, 2 balanced, 3 wide)
        chart: null
    };

    // Which presets to suggest for each market view. Titles/descriptions come
    // from OptionStrategies.presets so wording stays in one place.
    const DIRECTION_MAP = {
        bullish: [
            { key: 'bull_call_spread', risk: 'defined' }
        ],
        neutral: [
            { key: 'iron_condor', risk: 'defined' },
            { key: 'iron_butterfly', risk: 'defined' },
            { key: 'short_strangle', risk: 'high' },
            { key: 'long_straddle', risk: 'defined', label: 'Big Swing Either Way' }
        ],
        bearish: [
            { key: 'bear_put_spread', risk: 'defined' }
        ]
    };

    const WIDTH_HINTS = { 1: 'Tight', 2: 'Balanced', 3: 'Wide' };

    /* ---------------------------------------------------------------------
       Leg construction (width-adjustable variants of the presets).
       Strikes are spaced in multiples of the symbol's strike step, priced
       theoretically via Black-Scholes at the current spot / horizon / mood.
       --------------------------------------------------------------------- */
    function buildLegs() {
        const spot = state.spotPrice;
        const step = OptionSimulator.getStrikeStep(state.symbol);
        const atm = Math.round(spot / step) * step;
        const w = sm.width;
        let raw = [];

        switch (sm.strategyKey) {
            case 'bull_call_spread':
                raw = [
                    { action: 'BUY', type: 'CE', strike: atm },
                    { action: 'SELL', type: 'CE', strike: atm + w * step }
                ];
                break;
            case 'bear_put_spread':
                raw = [
                    { action: 'BUY', type: 'PE', strike: atm },
                    { action: 'SELL', type: 'PE', strike: atm - w * step }
                ];
                break;
            case 'iron_condor':
                raw = [
                    { action: 'BUY', type: 'PE', strike: atm - (w + 1) * step },
                    { action: 'SELL', type: 'PE', strike: atm - w * step },
                    { action: 'SELL', type: 'CE', strike: atm + w * step },
                    { action: 'BUY', type: 'CE', strike: atm + (w + 1) * step }
                ];
                break;
            case 'iron_butterfly':
                raw = [
                    { action: 'BUY', type: 'PE', strike: atm - w * step },
                    { action: 'SELL', type: 'PE', strike: atm },
                    { action: 'SELL', type: 'CE', strike: atm },
                    { action: 'BUY', type: 'CE', strike: atm + w * step }
                ];
                break;
            case 'short_strangle':
                raw = [
                    { action: 'SELL', type: 'PE', strike: atm - w * step },
                    { action: 'SELL', type: 'CE', strike: atm + w * step }
                ];
                break;
            case 'long_straddle':
                raw = [
                    { action: 'BUY', type: 'CE', strike: atm },
                    { action: 'BUY', type: 'PE', strike: atm }
                ];
                break;
            default:
                raw = [];
        }

        // Price each leg with BSM at current spot / horizon / mood IV.
        return raw.map(leg => {
            const r = OptionMath.calculateOption(leg.type, spot, leg.strike, sm.dte, sm.iv);
            return {
                action: leg.action,
                type: leg.type,
                strike: leg.strike,
                entryPremium: r.price,
                iv: sm.iv,
                qty: 1
            };
        });
    }

    /* ---------------------------------------------------------------------
       Payoff statistics over the active legs. Mirrors the math in
       app.js:updatePayoffChart (lognormal-weighted POP + breakeven crossing +
       unbounded-tail detection) so Simple and Pro agree for identical legs.
       --------------------------------------------------------------------- */
    function computeStats(legs) {
        const lotSize = OptionSimulator.getLotSize(state.symbol);
        const spot = state.spotPrice;

        const strikes = legs.map(l => l.strike);
        const lowBound = Math.min(...strikes, spot) * 0.9;
        const highBound = Math.max(...strikes, spot) * 1.1;
        const step = (highBound - lowBound) / 100;

        const sweepSpots = [];
        const pnlData = [];
        let maxProfit = -Infinity;
        let maxLoss = Infinity;

        for (let i = 0; i <= 100; i++) {
            const s = lowBound + i * step;
            let pnl = 0;
            legs.forEach(leg => {
                pnl += OptionMath.calculateExpiryPayoff(
                    leg.type, leg.action, leg.strike, leg.entryPremium, s, leg.qty * lotSize
                );
            });
            sweepSpots.push(s);
            pnlData.push(pnl);
            maxProfit = Math.max(maxProfit, pnl);
            maxLoss = Math.min(maxLoss, pnl);
        }

        // Probability of profit, weighted by the lognormal terminal-price density.
        const sigma = (sm.iv / 100) * Math.sqrt(Math.max(1, sm.dte) / 365);
        let popNum = 0, popDen = 0;
        if (sigma > 0 && spot > 0) {
            const mu = Math.log(spot) - 0.5 * sigma * sigma;
            sweepSpots.forEach((s, idx) => {
                if (s <= 0) return;
                const z = (Math.log(s) - mu) / sigma;
                const wgt = Math.exp(-0.5 * z * z) / s;
                popDen += wgt;
                if (pnlData[idx] > 0) popNum += wgt;
            });
        }
        const pop = popDen > 0 ? (popNum / popDen) * 100 : 0;

        // Breakeven spots: linear interpolation where P&L crosses zero.
        const breakevens = [];
        for (let i = 1; i < pnlData.length; i++) {
            const a = pnlData[i - 1], b = pnlData[i];
            if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) {
                const sA = sweepSpots[i - 1], sB = sweepSpots[i];
                breakevens.push(sA + (sB - sA) * (0 - a) / (b - a));
            }
        }

        // Unbounded tails come from net call exposure (spot floored at 0).
        let netCE = 0;
        legs.forEach(l => { if (l.type === 'CE') netCE += (l.action === 'BUY' ? 1 : -1) * l.qty; });

        return {
            sweepSpots, pnlData, maxProfit, maxLoss, pop, breakevens,
            profitUnlimited: netCE > 0,
            lossUnlimited: netCE < 0,
            lotSize
        };
    }

    /* ---------------------------------------------------------------------
       Formatting helpers
       --------------------------------------------------------------------- */
    function fmtRupee(v) {
        return '₹' + Math.round(Math.abs(v)).toLocaleString('en-IN');
    }
    function symbolDisplayName() {
        const meta = window.NSE_SYMBOL_MAP && window.NSE_SYMBOL_MAP[state.symbol];
        return meta ? meta.name : state.symbol;
    }

    /* ---------------------------------------------------------------------
       Renderers
       --------------------------------------------------------------------- */
    function renderContext() {
        const nameEl = document.getElementById('simple-symbol-name');
        const spotEl = document.getElementById('simple-spot');
        const noteEl = document.getElementById('simple-data-note');
        if (nameEl) nameEl.textContent = symbolDisplayName();
        if (spotEl) spotEl.textContent = '₹' + state.spotPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 });
        if (noteEl) noteEl.textContent = state.dataSource === 'simulated' ? 'Simulated prices · NSE unreachable' : 'Live NSE prices';
    }

    function renderChips() {
        const container = document.getElementById('strategy-chips');
        if (!container) return;
        container.innerHTML = '';
        DIRECTION_MAP[sm.direction].forEach(item => {
            const preset = OptionStrategies.presets[item.key];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'strategy-chip' + (item.key === sm.strategyKey ? ' active' : '');
            btn.dataset.key = item.key;
            const riskLabel = item.risk === 'high' ? 'High risk' : 'Defined risk';
            btn.innerHTML =
                `<span class="chip-name">${item.label || preset.name}</span>` +
                `<span class="chip-risk ${item.risk}">${riskLabel}</span>`;
            btn.addEventListener('click', () => {
                sm.strategyKey = item.key;
                renderChips();
                refresh();
            });
            container.appendChild(btn);
        });

        const desc = document.getElementById('strategy-desc');
        if (desc) desc.textContent = OptionStrategies.presets[sm.strategyKey].description;
    }

    function renderSummary(stats) {
        const profitEl = document.getElementById('opp-profit');
        const riskEl = document.getElementById('opp-risk');
        const chanceEl = document.getElementById('opp-chance');
        const daysEl = document.getElementById('opp-days');

        if (profitEl) profitEl.textContent = stats.profitUnlimited ? 'Unlimited' : fmtRupee(stats.maxProfit);
        if (riskEl) {
            if (stats.lossUnlimited) riskEl.textContent = 'Unlimited';
            else if (stats.maxLoss >= 0) riskEl.textContent = '₹0';
            else riskEl.textContent = fmtRupee(stats.maxLoss);
        }
        if (chanceEl) chanceEl.textContent = stats.pop.toFixed(0) + '%';
        if (daysEl) daysEl.textContent = sm.dte;
    }

    function renderScenarios(legs, stats) {
        const spot = state.spotPrice;
        const lotSize = stats.lotSize;
        const scenarios = [
            { id: 'sc-up', spot: spot * 1.05 },
            { id: 'sc-flat', spot: spot },
            { id: 'sc-down', spot: spot * 0.95 }
        ];
        scenarios.forEach(sc => {
            let pnl = 0;
            legs.forEach(leg => {
                pnl += OptionMath.calculateExpiryPayoff(
                    leg.type, leg.action, leg.strike, leg.entryPremium, sc.spot, leg.qty * lotSize
                );
            });
            const card = document.getElementById(sc.id);
            if (!card) return;
            const valEl = card.querySelector('.sc-val');
            const verdictEl = card.querySelector('.sc-verdict');
            const isProfit = pnl > 1;
            const isLoss = pnl < -1;
            card.classList.toggle('profit', isProfit);
            card.classList.toggle('loss', isLoss);
            valEl.textContent = (pnl >= 0 ? '+' : '−') + fmtRupee(pnl);
            verdictEl.textContent = isProfit ? 'Profit' : (isLoss ? 'Loss' : 'Break-even');
        });
    }

    function renderChart(stats) {
        const canvas = document.getElementById('simplePayoffChart');
        if (!canvas || typeof Chart === 'undefined') return;
        const ctx = canvas.getContext('2d');

        if (sm.chart) sm.chart.destroy();

        // Split the curve into profit (green) and loss (red) fills.
        const profitSeries = stats.pnlData.map(v => (v >= 0 ? v : null));
        const lossSeries = stats.pnlData.map(v => (v < 0 ? v : null));

        sm.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: stats.sweepSpots.map(s => Math.round(s)),
                datasets: [
                    {
                        label: 'Profit zone', data: profitSeries,
                        borderColor: 'rgba(16,185,129,0.9)', backgroundColor: 'rgba(16,185,129,0.12)',
                        borderWidth: 2.5, fill: 'origin', tension: 0.1, pointRadius: 0, spanGaps: false
                    },
                    {
                        label: 'Loss zone', data: lossSeries,
                        borderColor: 'rgba(244,63,94,0.9)', backgroundColor: 'rgba(244,63,94,0.12)',
                        borderWidth: 2.5, fill: 'origin', tension: 0.1, pointRadius: 0, spanGaps: false
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        mode: 'index', intersect: false,
                        callbacks: {
                            title: c => 'Price: ₹' + c[0].label,
                            label: c => (c.parsed.y == null ? '' : 'P&L: ₹' + Math.round(c.parsed.y).toLocaleString('en-IN'))
                        }
                    }
                },
                scales: {
                    x: { grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { color: '#94a3b8', maxTicksLimit: 6, font: { family: 'JetBrains Mono' } } },
                    y: { grid: { color: 'rgba(148,163,184,0.12)' }, ticks: { color: '#94a3b8', font: { family: 'JetBrains Mono' } } }
                }
            }
        });

        // Plain-language breakeven caption.
        const cap = document.getElementById('payoff-caption');
        if (cap) {
            if (!stats.breakevens.length) {
                cap.textContent = stats.maxLoss >= 0
                    ? 'This trade profits across the whole range shown.'
                    : 'This trade loses across the whole range shown.';
            } else {
                const bes = stats.breakevens.map(b => '₹' + Math.round(b).toLocaleString('en-IN'));
                const name = symbolDisplayName();
                cap.textContent = bes.length === 1
                    ? `You start making money once ${name} moves past ${bes[0]} by expiry.`
                    : `You profit while ${name} stays between ${bes[0]} and ${bes[bes.length - 1]} by expiry.`;
            }
        }
    }

    /* ---------------------------------------------------------------------
       Master refresh: rebuild legs, push to shared state, render everything.
       --------------------------------------------------------------------- */
    function refresh() {
        if (!state.spotPrice) return;
        const legs = buildLegs();
        state.activeLegs = legs;          // share with Pro mode + backtest
        const stats = computeStats(legs);

        renderContext();
        renderSummary(stats);
        renderScenarios(legs, stats);
        renderChart(stats);
    }

    /* ---------------------------------------------------------------------
       Simplified backtest — runs the existing engine, frames the result kindly.
       --------------------------------------------------------------------- */
    function runSimpleBacktest() {
        const btn = document.getElementById('simple-run-btn');
        if (!state.spotPrice) return;
        btn.disabled = true;
        const original = btn.innerHTML;
        btn.innerHTML = 'Running simulation…';

        // Keep the Pro sidebar inputs in sync so a later "full report" matches.
        const dteSel = document.getElementById('dte-select');
        const ivSlider = document.getElementById('iv-slider');
        const ivVal = document.getElementById('iv-val');
        if (dteSel) dteSel.value = String(sm.dte);
        if (ivSlider) ivSlider.value = String(sm.iv);
        if (ivVal) ivVal.textContent = sm.iv.toFixed(1) + '%';

        const host = (window.location.origin === 'null' || window.location.protocol === 'file:') ? 'http://localhost:8080' : '';
        fetch(`${host}/api/historical-underlying?symbol=${encodeURIComponent(state.symbol)}`)
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(historical => {
                const num = (id, fallback) => {
                    const el = document.getElementById(id);
                    const v = el ? parseFloat(el.value) : NaN;
                    return isNaN(v) ? fallback : v;
                };
                const dateVal = (id, fallback) => {
                    const el = document.getElementById(id);
                    return el && el.value ? el.value : fallback;
                };

                const legs = buildLegs();
                state.activeLegs = legs;

                const results = OptionSimulator.runBacktest({
                    symbol: state.symbol,
                    historicalData: historical,
                    startDate: dateVal('start-date', '2025-01-01'),
                    endDate: dateVal('end-date', '2026-05-01'),
                    initialCapital: num('init-capital', 1000000),
                    strategyKey: 'custom',
                    customLegs: legs,
                    customLegsSpot: state.spotPrice,
                    dte: sm.dte,
                    iv: sm.iv,
                    slippagePct: num('slippage-input', 0.05),
                    brokeragePerOrder: num('brokerage-input', 20),
                    stopLossPct: 0,
                    takeProfitPct: 0,
                    r: 0.07
                });

                state.backtestResults = results;

                // Populate the hidden Pro DOM so "View full report" is ready.
                if (window.populateMetricsCards) window.populateMetricsCards(results);
                if (window.populateTradeLedger) window.populateTradeLedger(results);
                const hb = document.getElementById('header-balance');
                if (hb) hb.textContent = '₹' + results.finalCapital.toLocaleString('en-IN', { maximumFractionDigits: 0 });

                renderResultCard(results);
                btn.disabled = false;
                btn.innerHTML = original;
                if (typeof lucide !== 'undefined') lucide.createIcons();
            })
            .catch(err => {
                console.error('Simple backtest failed:', err);
                const out = document.getElementById('simple-result');
                out.hidden = false;
                out.innerHTML = '<div class="result-headline">Could not run the simulation. Make sure the local server is running.</div>';
                btn.disabled = false;
                btn.innerHTML = original;
                if (typeof lucide !== 'undefined') lucide.createIcons();
            });
    }

    function renderResultCard(res) {
        const out = document.getElementById('simple-result');
        if (!out) return;

        const initial = res.initialCapital;
        const final = res.finalCapital;
        const gained = final - initial;
        const beat = res.totalReturn - res.benchmarkReturn;
        const retClass = res.totalReturn >= 0 ? 'profit' : 'loss';
        const benchClass = res.benchmarkReturn >= 0 ? 'profit' : 'loss';

        out.hidden = false;
        out.innerHTML =
            `<div class="result-headline">` +
                `Over this period, ₹${initial.toLocaleString('en-IN')} would have ` +
                `<strong>${gained >= 0 ? 'grown to' : 'shrunk to'} ${fmtRupee(final)}</strong> ` +
                `— a <strong style="color:var(--color-${retClass})">${res.totalReturn >= 0 ? '+' : ''}${res.totalReturn.toFixed(1)}%</strong> change. ` +
                `That's <strong>${beat >= 0 ? 'ahead of' : 'behind'}</strong> simply buying & holding ${symbolDisplayName()}.` +
            `</div>` +
            `<div class="result-grid">` +
                `<div class="result-stat"><span class="rs-label">Your strategy</span><span class="rs-value ${retClass}">${res.totalReturn >= 0 ? '+' : ''}${res.totalReturn.toFixed(1)}%</span></div>` +
                `<div class="result-stat"><span class="rs-label">Buy &amp; hold</span><span class="rs-value ${benchClass}">${res.benchmarkReturn >= 0 ? '+' : ''}${res.benchmarkReturn.toFixed(1)}%</span></div>` +
                `<div class="result-stat"><span class="rs-label">Trades that won</span><span class="rs-value">${res.winRate.toFixed(0)}%</span></div>` +
                `<div class="result-stat"><span class="rs-label">Completed trades</span><span class="rs-value">${res.totalTrades}</span></div>` +
            `</div>` +
            `<div class="result-disclaimer">Illustrative only: prices are reconstructed from a simulated market path via Black-Scholes, not real historical trades.</div>` +
            `<button class="link-full-report" id="view-full-report" type="button">View full report →</button>`;

        const link = document.getElementById('view-full-report');
        if (link) {
            link.addEventListener('click', () => {
                if (window.setViewMode) window.setViewMode('pro');
                const tab = document.querySelector(".tab-btn[data-tab='backtest-results']");
                if (tab) tab.click();
            });
        }
    }

    /* ---------------------------------------------------------------------
       Wiring
       --------------------------------------------------------------------- */
    function init() {
        // Market direction
        document.querySelectorAll('#direction-grid .direction-card').forEach(card => {
            card.addEventListener('click', () => {
                sm.direction = card.dataset.direction;
                document.querySelectorAll('#direction-grid .direction-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                sm.strategyKey = DIRECTION_MAP[sm.direction][0].key; // sensible default
                renderChips();
                refresh();
            });
        });

        // Time horizon
        document.querySelectorAll('#horizon-seg button').forEach(b => {
            b.addEventListener('click', () => {
                sm.dte = parseInt(b.dataset.dte, 10);
                document.querySelectorAll('#horizon-seg button').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                refresh();
            });
        });

        // Market mood (IV)
        document.querySelectorAll('#mood-seg button').forEach(b => {
            b.addEventListener('click', () => {
                sm.iv = parseFloat(b.dataset.iv);
                document.querySelectorAll('#mood-seg button').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                refresh();
            });
        });

        // Strike width
        const widthSlider = document.getElementById('width-slider');
        const widthHint = document.getElementById('width-hint');
        if (widthSlider) {
            widthSlider.addEventListener('input', () => {
                sm.width = parseInt(widthSlider.value, 10);
                if (widthHint) widthHint.textContent = WIDTH_HINTS[sm.width];
                refresh();
            });
        }

        // Coaching banner dismiss (persisted)
        const banner = document.getElementById('coach-banner');
        const dismiss = document.getElementById('coach-dismiss');
        if (banner && localStorage.getItem('algo-coach-dismissed') === '1') banner.classList.add('hidden');
        if (dismiss) {
            dismiss.addEventListener('click', () => {
                banner.classList.add('hidden');
                localStorage.setItem('algo-coach-dismissed', '1');
            });
        }

        // Run backtest CTA
        const runBtn = document.getElementById('simple-run-btn');
        if (runBtn) runBtn.addEventListener('click', runSimpleBacktest);

        renderChips();
        refresh();

        // Re-render when chain/spot data finishes loading, and whenever the user
        // switches into Simple mode (so a hidden-at-load chart sizes correctly).
        window.onChainDataLoaded = function () { refresh(); };
        window.onEnterSimpleMode = function () { refresh(); };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
