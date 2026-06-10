/**
 * algoOptions - Core UI & Application Orchestrator
 */

// Application Global State
const state = {
    activeTab: 'option-chain',
    symbol: 'NIFTY',
    spotPrice: 22500,
    timestamp: '',
    optionChainRecords: [],
    expirations: [],
    selectedExpiry: '',
    activeLegs: [],
    historicalUnderlying: [],
    backtestResults: null,
    dataSource: 'live',
    
    // Chart References
    payoffChart: null,
    equityChart: null,
    greeksChart: null
};

// Initialization on DOM Load
document.addEventListener("DOMContentLoaded", async () => {
    // 1. Initialize Lucide Icons
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // 2. Apply saved theme before first paint
    initTheme();

    // 3. Setup Tab Handlers
    initTabs();

    // 4. Populate the NSE symbol universe (drives the ticker dropdown and the
    //    lot-size / strike-step lookups). Must finish before wiring controls so
    //    the dropdown reflects state.symbol.
    await loadSymbolUniverse();

    // 5. Setup Config Control Listeners
    initControls();

    // 6. Load Initial Data
    fetchOptionChainData();
});

/* =========================================================================
   NSE Symbol Universe (single source of truth: symbols.json)
   ========================================================================= */
async function loadSymbolUniverse() {
    const tickerSelect = document.getElementById("ticker-select");
    const host = window.location.origin === "null" || window.location.protocol === "file:" ? "http://localhost:8080" : "";

    try {
        const res = await fetch(`${host}/symbols.json`);
        if (!res.ok) throw new Error("HTTP error " + res.status);
        const list = await res.json();

        // Expose for simulator.js (lot size / strike step) and other consumers.
        window.NSE_SYMBOLS = list;
        window.NSE_SYMBOL_MAP = list.reduce((map, s) => (map[s.symbol] = s, map), {});

        // Build the dropdown, grouping indices and equities.
        tickerSelect.innerHTML = "";
        const groups = {
            index: document.createElement("optgroup"),
            equity: document.createElement("optgroup")
        };
        groups.index.label = "Indices";
        groups.equity.label = "Equities (F&O)";

        list.forEach(s => {
            const opt = document.createElement("option");
            opt.value = s.symbol;
            opt.text = s.type === "index" ? `${s.name} (Index)` : `${s.name} (${s.symbol})`;
            (groups[s.type] || groups.equity).appendChild(opt);
        });
        if (groups.index.children.length) tickerSelect.appendChild(groups.index);
        if (groups.equity.children.length) tickerSelect.appendChild(groups.equity);

        // Keep the initial selection in sync with state (defaults to NIFTY).
        if (window.NSE_SYMBOL_MAP[state.symbol]) {
            tickerSelect.value = state.symbol;
        } else if (list.length) {
            state.symbol = list[0].symbol;
            tickerSelect.value = state.symbol;
        }
    } catch (err) {
        // The dropdown already contains a static NIFTY fallback option in HTML,
        // so the app still works against the default symbol if this fails.
        console.error("Failed to load symbol universe:", err);
    }
}

/* =========================================================================
   Theme Toggle
   ========================================================================= */
function initTheme() {
    // Precedence: explicit ?theme= deep link > saved preference.
    const urlTheme = new URLSearchParams(window.location.search).get('theme');
    const saved = (urlTheme === 'light' || urlTheme === 'dark') ? urlTheme : localStorage.getItem('algo-theme');
    if (saved === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    }
    document.getElementById('theme-toggle').addEventListener('click', () => {
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        document.documentElement.setAttribute('data-theme', isLight ? 'dark' : 'light');
        localStorage.setItem('algo-theme', isLight ? 'dark' : 'light');
    });
}

/* =========================================================================
   1. Tab Panel Management
   ========================================================================= */
function initTabs() {
    const tabButtons = document.querySelectorAll(".tab-btn");
    tabButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            const targetTab = btn.getAttribute("data-tab");
            
            // Toggle active classes on buttons
            tabButtons.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            
            // Toggle active classes on tab panels
            document.querySelectorAll(".tab-content").forEach(panel => {
                panel.classList.remove("active");
            });
            
            const activePanel = document.getElementById(`tab-${targetTab}`);
            if (activePanel) {
                activePanel.classList.add("active");
            }
            
            state.activeTab = targetTab;
            
            // Trigger chart redraws if opening tab
            if (targetTab === 'payoff') {
                setTimeout(updatePayoffChart, 50);
            } else if (targetTab === 'backtest-results') {
                setTimeout(renderBacktestCharts, 50);
            }
        });
    });
}

/* =========================================================================
   2. Config & Control Event Handlers
   ========================================================================= */
function initControls() {
    // Ticker select change
    const tickerSelect = document.getElementById("ticker-select");
    tickerSelect.addEventListener("change", (e) => {
        state.symbol = e.target.value;
        state.activeLegs = []; // Reset custom legs when symbol changes
        updateLegsBuilderUI();
        fetchOptionChainData();
    });

    // Date validators (ensure start < end)
    const startDateInput = document.getElementById("start-date");
    const endDateInput = document.getElementById("end-date");
    
    startDateInput.addEventListener("change", () => {
        if (startDateInput.value >= endDateInput.value) {
            endDateInput.value = addDays(startDateInput.value, 30);
        }
    });

    // Expiry dropdown change
    const expirySelect = document.getElementById("expiry-select");
    expirySelect.addEventListener("change", (e) => {
        state.selectedExpiry = e.target.value;
        renderOptionChainBoard();
    });

    // Strategy preset selector
    const presetSelect = document.getElementById("preset-select");
    presetSelect.addEventListener("change", (e) => {
        const selectedPreset = e.target.value;
        if (selectedPreset) {
            loadStrategyPreset(selectedPreset);
        }
    });

    // Target DTE change should reprice the active legs (they were priced at the
    // previous DTE). Previously only the IV slider triggered a reprice.
    const dteSelect = document.getElementById("dte-select");
    dteSelect.addEventListener("change", () => {
        if (state.activeLegs.length > 0) {
            updateOptionLegsPremiums();
        }
    });

    // Baseline IV Slider
    const ivSlider = document.getElementById("iv-slider");
    const ivVal = document.getElementById("iv-val");
    ivSlider.addEventListener("input", (e) => {
        ivVal.innerText = parseFloat(e.target.value).toFixed(1) + "%";
        if (state.activeLegs.length > 0) {
            updateOptionLegsPremiums(); // Recalculate options pricing under new baseline IV
        }
    });

    // Risk Sliders text updates
    const slSlider = document.getElementById("sl-slider");
    const slVal = document.getElementById("sl-val");
    slSlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        slVal.innerText = val === 0 ? "Disabled" : `-${val.toFixed(1)}%`;
    });

    const tpSlider = document.getElementById("tp-slider");
    const tpVal = document.getElementById("tp-val");
    tpSlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        tpVal.innerText = val === 0 ? "Disabled" : `+${val.toFixed(1)}%`;
    });

    // Leg Builder Reset
    const clearLegsBtn = document.getElementById("clear-legs-btn");
    clearLegsBtn.addEventListener("click", () => {
        state.activeLegs = [];
        presetSelect.value = "";
        updateLegsBuilderUI();
        updatePayoffChart();
    });

    // Run Backtest
    const runBacktestBtn = document.getElementById("run-backtest-btn");
    runBacktestBtn.addEventListener("click", () => {
        triggerHistoricalBacktest();
    });
}

function addDays(dateStr, days) {
    const date = new Date(dateStr);
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
}

/* =========================================================================
   3. Live Option Chain Download (Python API Bridge)
   ========================================================================= */
function fetchOptionChainData() {
    const statusDot = document.getElementById("status-dot");
    const statusText = document.getElementById("status-text");
    
    statusDot.className = "status-dot fetching";
    statusText.innerText = `Fetching ${state.symbol} live chain...`;
    
    const host = window.location.origin === "null" || window.location.protocol === "file:" ? "http://localhost:8080" : "";
    const url = `${host}/api/fetch-options?symbol=${encodeURIComponent(state.symbol)}`;
    
    fetch(url)
        .then(response => {
            if (!response.ok) throw new Error("HTTP error " + response.status);
            return response.json();
        })
        .then(data => {
            // Honestly reflect whether this is a live NSE feed or the server's
            // synthetic fallback (NSE blocks/cookies often fail).
            state.dataSource = data.dataSource || 'live';
            if (state.dataSource === 'simulated') {
                statusDot.className = "status-dot fetching";
                statusText.innerText = "Simulated Chain (NSE unreachable)";
            } else {
                statusDot.className = "status-dot";
                statusText.innerText = "NSE Live Feed Connected";
            }

            const rec = data.records;
            state.spotPrice = rec.underlyingValue;
            state.timestamp = rec.timestamp;
            state.optionChainRecords = rec.data;
            state.expirations = rec.expiryDates;
            state.selectedExpiry = rec.expiryDates[0];
            
            // Update Displays
            document.getElementById("underlying-spot-display").innerText = `Spot Price: ₹${state.spotPrice.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            document.getElementById("chain-timestamp").innerText = `Timestamp: ${state.timestamp}`;
            
            // Fill Expiries Select
            const expirySelect = document.getElementById("expiry-select");
            expirySelect.innerHTML = "";
            state.expirations.forEach(exp => {
                const opt = document.createElement("option");
                opt.value = exp;
                opt.text = exp;
                expirySelect.appendChild(opt);
            });
            
            renderOptionChainBoard();

            // Let Simple mode re-render against the freshly loaded spot/chain.
            if (window.onChainDataLoaded) window.onChainDataLoaded();
        })
        .catch(err => {
            console.error("Option Chain API Fetch error:", err);
            statusDot.className = "status-dot loss";
            statusText.innerText = "Connection Failed. Check local Server.";
        });
}

/* =========================================================================
   4. Render Option Chain Board
   ========================================================================= */
function renderOptionChainBoard() {
    const tbody = document.getElementById("chain-table-body");
    tbody.innerHTML = "";
    
    // Filter chain by selected expiry date
    const filtered = state.optionChainRecords.filter(r => r.expiryDate === state.selectedExpiry);
    
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="13" style="text-align: center; padding: 30px; color: var(--text-secondary);">No options available for selected expiry.</td></tr>`;
        return;
    }

    // Sort strikes ascending
    filtered.sort((a, b) => a.strikePrice - b.strikePrice);
    
    filtered.forEach(record => {
        const strike = record.strikePrice;
        const ce = record.CE || {};
        const pe = record.PE || {};
        
        const isATM = Math.abs(strike - state.spotPrice) <= (OptionSimulator.getStrikeStep(state.symbol) / 2);
        const rowClass = isATM ? "style='background: rgba(99,102,241,0.06);'" : "";
        
        const tr = document.createElement("tr");
        if (isATM) tr.style.background = "rgba(255, 255, 255, 0.02)";
        
        tr.innerHTML = `
            <!-- CALLS -->
            <td style="color: var(--text-secondary);">${ce.openInterest ? ce.openInterest.toLocaleString('en-IN') : '--'}</td>
            <td style="color: ${ce.changeinOpenInterest >= 0 ? 'var(--color-profit)' : 'var(--color-loss)'};">
                ${ce.changeinOpenInterest ? (ce.changeinOpenInterest > 0 ? '+' : '') + ce.changeinOpenInterest.toLocaleString('en-IN') : '--'}
            </td>
            <td>${ce.totalBuyQuantity ? (ce.totalBuyQuantity + ce.totalSellQuantity).toLocaleString('en-IN') : '--'}</td>
            <td style="color: var(--color-call);">${ce.impliedVolatility ? ce.impliedVolatility + '%' : '--'}</td>
            <td style="font-weight: 700; color: var(--text-primary);">${ce.lastPrice ? '₹' + ce.lastPrice.toFixed(2) : '--'}</td>
            <td>
                ${ce.lastPrice ? `
                    <div style="display: flex; gap: 4px; justify-content: center;">
                        <button class="add-leg-btn buy" onclick="addCustomLeg('BUY', 'CE', ${strike}, ${ce.lastPrice}, ${ce.impliedVolatility || state.iv})">BUY</button>
                        <button class="add-leg-btn sell" onclick="addCustomLeg('SELL', 'CE', ${strike}, ${ce.lastPrice}, ${ce.impliedVolatility || state.iv})">SELL</button>
                    </div>
                ` : '--'}
            </td>
            
            <!-- STRIKE -->
            <td class="strike-cell">${strike}</td>
            
            <!-- PUTS -->
            <td>
                ${pe.lastPrice ? `
                    <div style="display: flex; gap: 4px; justify-content: center;">
                        <button class="add-leg-btn buy" onclick="addCustomLeg('BUY', 'PE', ${strike}, ${pe.lastPrice}, ${pe.impliedVolatility || state.iv})">BUY</button>
                        <button class="add-leg-btn sell" onclick="addCustomLeg('SELL', 'PE', ${strike}, ${pe.lastPrice}, ${pe.impliedVolatility || state.iv})">SELL</button>
                    </div>
                ` : '--'}
            </td>
            <td style="font-weight: 700; color: var(--text-primary);">${pe.lastPrice ? '₹' + pe.lastPrice.toFixed(2) : '--'}</td>
            <td style="color: var(--color-put);">${pe.impliedVolatility ? pe.impliedVolatility + '%' : '--'}</td>
            <td>${pe.totalBuyQuantity ? (pe.totalBuyQuantity + pe.totalSellQuantity).toLocaleString('en-IN') : '--'}</td>
            <td style="color: ${pe.changeinOpenInterest >= 0 ? 'var(--color-profit)' : 'var(--color-loss)'};">
                ${pe.changeinOpenInterest ? (pe.changeinOpenInterest > 0 ? '+' : '') + pe.changeinOpenInterest.toLocaleString('en-IN') : '--'}
            </td>
            <td style="color: var(--text-secondary);">${pe.openInterest ? pe.openInterest.toLocaleString('en-IN') : '--'}</td>
        `;
        
        tbody.appendChild(tr);
    });
}

/* =========================================================================
   5. Interactive Option Leg Builder
   ========================================================================= */
window.addCustomLeg = function(action, type, strike, premium, iv) {
    // Max 4 legs standard constraint
    if (state.activeLegs.length >= 4) {
        alert("Maximum of 4 option legs allowed in standard strategy portfolios!");
        return;
    }
    
    state.activeLegs.push({
        action: action,
        type: type,
        strike: strike,
        entryPremium: premium,
        iv: iv || parseFloat(document.getElementById("iv-slider").value),
        qty: 1
    });
    
    updateLegsBuilderUI();
    updatePayoffChart();
};

window.removeLeg = function(idx) {
    state.activeLegs.splice(idx, 1);
    document.getElementById("preset-select").value = "";
    updateLegsBuilderUI();
    updatePayoffChart();
};

window.updateLegQty = function(idx, newQty) {
    state.activeLegs[idx].qty = Math.max(1, parseInt(newQty) || 1);
    updatePayoffChart();
};

function updateLegsBuilderUI() {
    const container = document.getElementById("legs-builder-container");
    container.innerHTML = "";
    
    if (state.activeLegs.length === 0) {
        container.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 13px; padding: 20px;">
            No active contract legs configured. Click "BUY" or "SELL" in the Option Chain above or choose a Preset Strategy to build legs!
        </div>`;
        return;
    }
    
    state.activeLegs.forEach((leg, index) => {
        const item = document.createElement("div");
        item.className = "leg-card";
        
        const actionClass = leg.action.toLowerCase();
        const typeClass = leg.type.toLowerCase();
        
        item.innerHTML = `
            <div>
                <span class="leg-badge ${actionClass}">${leg.action}</span>
            </div>
            <div>
                <span class="leg-badge ${typeClass}">${leg.type}</span>
            </div>
            <div style="font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 14px;">
                Strike: ${leg.strike}
            </div>
            <div style="font-size: 13px; color: var(--text-secondary);">
                Premium: <span style="font-family: 'JetBrains Mono', monospace; font-weight: 600; color: var(--text-primary);">₹${leg.entryPremium.toFixed(2)}</span>
            </div>
            <div class="form-group" style="flex-direction: row; align-items: center; gap: 8px;">
                <label style="margin-bottom: 0;">Lots</label>
                <input type="number" value="${leg.qty}" min="1" max="100" style="width: 70px; padding: 4px 8px; font-size: 13px; text-align: center;" onchange="updateLegQty(${index}, this.value)">
            </div>
            <div>
                <button class="btn-secondary" style="padding: 6px; color: var(--color-loss); border-color: rgba(244,63,94,0.15); background: var(--color-loss-bg);" onclick="removeLeg(${index})">
                    <i data-lucide="x" style="width: 14px; height: 14px;"></i>
                </button>
            </div>
        `;
        container.appendChild(item);
    });
    
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
}

// Loads pre-defined options leg matrices
function loadStrategyPreset(key) {
    const step = OptionSimulator.getStrikeStep(state.symbol);
    const preset = OptionStrategies.presets[key];
    
    if (!preset) return;
    
    // Generate legs dynamically from preset calculations relative to spot price
    const templateLegs = preset.getLegs(state.spotPrice, step);
    
    state.activeLegs = templateLegs.map(leg => {
        // Calculate dynamic premium from Black-Scholes using selected expiration DTE
        const dte = parseInt(document.getElementById("dte-select").value);
        const baselineIV = parseFloat(document.getElementById("iv-slider").value);
        
        const result = OptionMath.calculateOption(
            leg.type,
            state.spotPrice,
            leg.strike,
            dte,
            baselineIV
        );
        
        return {
            action: leg.action,
            type: leg.type,
            strike: leg.strike,
            entryPremium: result.price,
            iv: baselineIV,
            qty: leg.qty
        };
    });
    
    updateLegsBuilderUI();
    updatePayoffChart();
}

function updateOptionLegsPremiums() {
    const dte = parseInt(document.getElementById("dte-select").value);
    const baselineIV = parseFloat(document.getElementById("iv-slider").value);
    
    state.activeLegs = state.activeLegs.map(leg => {
        const result = OptionMath.calculateOption(
            leg.type,
            state.spotPrice,
            leg.strike,
            dte,
            baselineIV
        );
        return {
            ...leg,
            entryPremium: result.price,
            iv: baselineIV
        };
    });
    
    updateLegsBuilderUI();
    updatePayoffChart();
}

/* =========================================================================
   6. Sweep & Draw Payoff Curve Chart
   ========================================================================= */
function updatePayoffChart() {
    if (state.activeTab !== 'payoff') return;
    
    const ctx = document.getElementById("payoffChart").getContext("2d");
    const lotSize = OptionSimulator.getLotSize(state.symbol);
    
    if (state.activeLegs.length === 0) {
        if (state.payoffChart) state.payoffChart.destroy();
        ctx.clearRect(0, 0, 400, 400);
        return;
    }
    
    const strikes = state.activeLegs.map(l => l.strike);
    const minStrike = Math.min(...strikes, state.spotPrice);
    const maxStrike = Math.max(...strikes, state.spotPrice);
    
    // Sweep range: 10% below minimum strike to 10% above maximum strike
    const lowBound = minStrike * 0.90;
    const highBound = maxStrike * 1.10;
    
    const sweepSpots = [];
    const step = (highBound - lowBound) / 100;
    for (let i = 0; i <= 100; i++) {
        sweepSpots.push(lowBound + i * step);
    }
    
    const pnlData = [];
    let maxProfit = -Infinity;
    let maxLoss = Infinity;

    sweepSpots.forEach(s => {
        let spotPnL = 0;
        state.activeLegs.forEach(leg => {
            const qtyShares = leg.qty * lotSize;
            spotPnL += OptionMath.calculateExpiryPayoff(
                leg.type,
                leg.action,
                leg.strike,
                leg.entryPremium,
                s,
                qtyShares
            );
        });

        pnlData.push(spotPnL);
        maxProfit = Math.max(maxProfit, spotPnL);
        maxLoss = Math.min(maxLoss, spotPnL);
    });

    // Probability of Profit: weight each sweep spot by the lognormal density of
    // the terminal price (drift-free), not just the raw count of profitable
    // points — that's a real probability rather than a geometry heuristic.
    const dte = parseInt(document.getElementById("dte-select").value) || 30;
    const ivPct = parseFloat(document.getElementById("iv-slider").value) || 15;
    const sigma = (ivPct / 100) * Math.sqrt(Math.max(1, dte) / 365);
    const spot0 = state.spotPrice;
    let popNum = 0, popDen = 0;
    if (sigma > 0 && spot0 > 0) {
        const mu = Math.log(spot0) - 0.5 * sigma * sigma;
        sweepSpots.forEach((s, idx) => {
            if (s <= 0) return;
            const z = (Math.log(s) - mu) / sigma;
            const w = Math.exp(-0.5 * z * z) / s; // lognormal pdf (constant factors cancel)
            popDen += w;
            if (pnlData[idx] > 0) popNum += w;
        });
    }
    const pop = popDen > 0 ? (popNum / popDen) * 100 : 0;

    // Breakeven points: interpolate where the P&L curve crosses zero.
    const breakevens = [];
    for (let i = 1; i < pnlData.length; i++) {
        const a = pnlData[i - 1], b = pnlData[i];
        if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) {
            const sA = sweepSpots[i - 1], sB = sweepSpots[i];
            const be = sA + (sB - sA) * (0 - a) / (b - a);
            breakevens.push(be);
        }
    }

    // Unbounded tails come from net call exposure only (spot is floored at 0, so
    // puts are always bounded). Net long calls => unlimited profit on the upside;
    // net short calls => unlimited loss on the upside.
    let netCE = 0;
    state.activeLegs.forEach(l => {
        if (l.type === 'CE') netCE += (l.action === 'BUY' ? 1 : -1) * l.qty;
    });
    const profitUnlimited = netCE > 0;
    const lossUnlimited = netCE < 0;

    // Update labels UI
    document.getElementById("payoff-pop").innerText = `${pop.toFixed(1)}%`;
    document.getElementById("payoff-max-profit").innerText = profitUnlimited ? "Unlimited" : `₹${maxProfit.toLocaleString('en-IN', {maximumFractionDigits: 0})}`;
    document.getElementById("payoff-max-loss").innerText = lossUnlimited ? "Unlimited" : `₹${maxLoss.toLocaleString('en-IN', {maximumFractionDigits: 0})}`;

    const beEl = document.getElementById("payoff-breakeven");
    if (beEl) {
        beEl.innerText = breakevens.length
            ? breakevens.map(b => Math.round(b).toLocaleString('en-IN')).join(' / ')
            : '—';
    }

    // Adjust colors of text
    document.getElementById("payoff-max-profit").className = `metric-value ${maxProfit >= 0 ? 'profit' : 'loss'}`;
    document.getElementById("payoff-max-loss").className = `metric-value ${maxLoss >= 0 ? 'profit' : 'loss'}`;
    
    // Chart.js render
    if (state.payoffChart) {
        state.payoffChart.destroy();
    }
    
    // Gradients
    const profitGrad = ctx.createLinearGradient(0, 0, 0, 300);
    profitGrad.addColorStop(0, 'rgba(16, 185, 129, 0.2)');
    profitGrad.addColorStop(1, 'rgba(16, 185, 129, 0.0)');
    
    state.payoffChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: sweepSpots.map(s => Math.round(s)),
            datasets: [
                {
                    label: 'Expiry P&L (₹)',
                    data: pnlData,
                    borderColor: '#6366f1',
                    borderWidth: 3,
                    fill: false,
                    tension: 0.1,
                    pointRadius: 0
                },
                {
                    // Zero line — P&L crosses it exactly at the breakeven spots.
                    label: 'Breakeven (₹0)',
                    data: sweepSpots.map(() => 0),
                    borderColor: 'rgba(148, 163, 184, 0.6)',
                    borderWidth: 1,
                    borderDash: [4, 4],
                    fill: false,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            label += '₹' + Math.round(context.parsed.y).toLocaleString('en-IN');
                            return label;
                        },
                        title: function(context) {
                            return 'Spot Price: ₹' + context[0].label;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.03)' },
                    ticks: { color: '#94a3b8', font: { family: 'JetBrains Mono' } }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8', font: { family: 'JetBrains Mono' } }
                }
            }
        }
    });
}

/* =========================================================================
   7. Run Historical Backtest
   ========================================================================= */
function triggerHistoricalBacktest() {
    const runBtn = document.getElementById("run-backtest-btn");
    runBtn.disabled = true;
    runBtn.innerHTML = `<i data-lucide="loader" class="fetching" style="width: 18px; height: 18px; animation: pulse 1.2s infinite;"></i> Running Simulation...`;
    if (typeof lucide !== 'undefined') lucide.createIcons();

    // Fetch dynamic historical Spot Prices from server endpoint
    const host = window.location.origin === "null" || window.location.protocol === "file:" ? "http://localhost:8080" : "";
    const url = `${host}/api/historical-underlying?symbol=${encodeURIComponent(state.symbol)}`;
    
    fetch(url)
        .then(response => {
            if (!response.ok) throw new Error("HTTP error " + response.status);
            return response.json();
        })
        .then(historicalData => {
            // Retrieve parameters
            const startDate = document.getElementById("start-date").value;
            const endDate = document.getElementById("end-date").value;
            const initCapital = parseFloat(document.getElementById("init-capital").value);
            const dte = parseInt(document.getElementById("dte-select").value);
            const iv = parseFloat(document.getElementById("iv-slider").value);
            const slippage = parseFloat(document.getElementById("slippage-input").value);
            const brokerage = parseFloat(document.getElementById("brokerage-input").value);
            
            const stopLoss = parseFloat(document.getElementById("sl-slider").value);
            const takeProfit = parseFloat(document.getElementById("tp-slider").value);
            
            const strategyKey = state.activeLegs.length > 0 ? 'custom' : 'iron_condor';
            
            // Execute Simulation
            const results = OptionSimulator.runBacktest({
                symbol: state.symbol,
                historicalData: historicalData,
                startDate: startDate,
                endDate: endDate,
                initialCapital: initCapital,
                strategyKey: strategyKey,
                customLegs: state.activeLegs.length > 0 ? state.activeLegs : null,
                customLegsSpot: state.spotPrice,
                dte: dte,
                iv: iv,
                slippagePct: slippage,
                brokeragePerOrder: brokerage,
                stopLossPct: stopLoss,
                takeProfitPct: takeProfit,
                r: 0.07 // 7% standard interest rate
            });
            
            state.backtestResults = results;
            
            // UI Visual Feedback Updates
            document.getElementById("header-balance").innerText = `₹${results.finalCapital.toLocaleString('en-IN', {maximumFractionDigits: 0})}`;
            
            // Activate results tab
            document.querySelector(".tab-btn[data-tab='backtest-results']").click();
            
            // Populate ledger & statistics cards
            populateMetricsCards(results);
            populateTradeLedger(results);
            
            runBtn.disabled = false;
            runBtn.innerHTML = `<i data-lucide="play" style="width: 18px; height: 18px;"></i> Run Backtest`;
            if (typeof lucide !== 'undefined') lucide.createIcons();
        })
        .catch(err => {
            console.error("Backtest simulation failed:", err);
            alert("Error running simulator! Verify server is running.");
            runBtn.disabled = false;
            runBtn.innerHTML = `<i data-lucide="play" style="width: 18px; height: 18px;"></i> Run Backtest`;
            if (typeof lucide !== 'undefined') lucide.createIcons();
        });
}

/* =========================================================================
   CSV Export Helpers
   ========================================================================= */
function downloadCSV(filename, rows) {
    const csv = rows.map(r => r.map(cell => {
        const s = String(cell ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join('|')).join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

window.exportLedgerCSV = function() {
    if (!state.backtestResults || state.backtestResults.tradeLedger.length === 0) {
        alert("No backtest trades to export. Run a backtest first.");
        return;
    }
    const rows = [[
        'Entry Date', 'Exit Date', 'Strategy', 'Entry Spot', 'Exit Spot',
        'Net Entry Premium', 'Net Exit Premium', 'Brokerage', 'Margin Used', 'PnL', 'Exit Reason'
    ]];
    state.backtestResults.tradeLedger.forEach(t => {
        rows.push([
            t.entryDate, t.exitDate, t.strategy,
            t.entrySpot.toFixed(2), t.exitSpot.toFixed(2),
            t.netEntryPremium.toFixed(2), t.netExitPremium.toFixed(2),
            t.brokerage.toFixed(2), (t.marginUsed || 0).toFixed(2),
            t.pnl.toFixed(2), t.exitReason
        ]);
    });
    downloadCSV(`${state.symbol}_trade_ledger.csv`, rows);
};

window.exportEquityCSV = function() {
    if (!state.backtestResults || state.backtestResults.dailyEquity.length === 0) {
        alert("No backtest equity curve to export. Run a backtest first.");
        return;
    }
    const rows = [['Date', 'Spot', 'Cash', 'Options Value', 'Equity', 'PnL', 'Delta', 'Gamma', 'Theta', 'Vega']];
    state.backtestResults.dailyEquity.forEach(d => {
        rows.push([
            d.date, d.spot.toFixed(2), d.cash.toFixed(2), d.optionsValue.toFixed(2),
            d.equity.toFixed(2), d.pnl.toFixed(2),
            d.greeks.delta.toFixed(4), d.greeks.gamma.toFixed(6),
            d.greeks.theta.toFixed(4), d.greeks.vega.toFixed(4)
        ]);
    });
    downloadCSV(`${state.symbol}_equity_curve.csv`, rows);
};

function populateMetricsCards(res) {
    const formatPct = (val) => (val >= 0 ? '+' : '') + val.toFixed(2) + "%";
    
    const retVal = document.getElementById("val-total-return");
    retVal.innerText = formatPct(res.totalReturn);
    retVal.className = `metric-value ${res.totalReturn >= 0 ? 'profit' : 'loss'}`;
    document.getElementById("card-total-return").className = `glass-panel metric-card ${res.totalReturn >= 0 ? 'profit' : 'loss'}`;
    
    const benchVal = document.getElementById("val-benchmark");
    benchVal.innerText = formatPct(res.benchmarkReturn);
    benchVal.className = `metric-value ${res.benchmarkReturn >= 0 ? 'profit' : 'loss'}`;
    document.getElementById("card-benchmark").className = `glass-panel metric-card ${res.benchmarkReturn >= 0 ? 'profit' : 'loss'}`;

    document.getElementById("val-drawdown").innerText = res.maxDrawdown.toFixed(2) + "%";
    document.getElementById("val-sharpe").innerText = res.sharpeRatio.toFixed(2);
    document.getElementById("val-winrate").innerText = res.winRate.toFixed(1) + "%";
    document.getElementById("val-trades").innerText = res.totalTrades;

    const marginEl = document.getElementById("val-margin");
    if (marginEl && res.marginUtilization != null) {
        marginEl.innerText = res.marginUtilization.toFixed(1) + "%";
    }
}

function populateTradeLedger(res) {
    const tbody = document.getElementById("ledger-table-body");
    tbody.innerHTML = "";
    
    if (res.tradeLedger.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 45px; color: var(--text-secondary);">No trades were executed in this backtest range. Try adjusting entry triggers or extending the range.</td></tr>`;
        return;
    }
    
    res.tradeLedger.forEach(trade => {
        const tr = document.createElement("tr");
        const pnlClass = trade.pnl >= 0 ? "profit" : "loss";
        const prefix = trade.pnl >= 0 ? "+" : "";
        
        let exitClass = "expiry";
        if (trade.exitReason === "Stop Loss") exitClass = "sl";
        if (trade.exitReason === "Take Profit") exitClass = "tp";
        
        tr.innerHTML = `
            <td>${trade.entryDate}</td>
            <td>${trade.exitDate}</td>
            <td style="font-weight: 600; color: var(--text-primary);">${trade.strategy}</td>
            <td>₹${trade.entrySpot.toFixed(2)}</td>
            <td>₹${trade.exitSpot.toFixed(2)}</td>
            <td>
                Entry: ₹${trade.netEntryPremium.toLocaleString('en-IN', {maximumFractionDigits: 0})}<br>
                Exit: ₹${trade.netExitPremium.toLocaleString('en-IN', {maximumFractionDigits: 0})}
            </td>
            <td class="${pnlClass}" style="font-weight: 700;">${prefix}₹${trade.pnl.toLocaleString('en-IN', {maximumFractionDigits: 0})}</td>
            <td>
                <span class="badge-exit ${exitClass}">${trade.exitReason}</span>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

/* =========================================================================
   8. Render Equity & Greeks Overlays via Chart.js
   ========================================================================= */
function renderBacktestCharts() {
    if (state.activeTab !== 'backtest-results' || !state.backtestResults) return;
    
    const results = state.backtestResults;
    const daily = results.dailyEquity;
    
    const labels = daily.map(d => d.date);
    const equityData = daily.map(d => d.equity);
    
    // Standard normalized index benchmark comparison (starts at initialCapital value)
    const startSpot = daily[0].spot;
    const initialCap = results.initialCapital;
    const benchmarkEquity = daily.map(d => (d.spot / startSpot) * initialCap);
    
    // Render Equity Chart
    const ctxEquity = document.getElementById("equityChart").getContext("2d");
    if (state.equityChart) state.equityChart.destroy();
    
    state.equityChart = new Chart(ctxEquity, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Options Strategy Capital (₹)',
                    data: equityData,
                    borderColor: '#10b981',
                    borderWidth: 2.5,
                    fill: false,
                    tension: 0.1,
                    pointRadius: 0
                },
                {
                    label: 'Buy & Hold Underlying Benchmark (₹)',
                    data: benchmarkEquity,
                    borderColor: '#6366f1',
                    borderWidth: 1.5,
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0.1,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                tooltip: { mode: 'index', intersect: false }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.02)' }, ticks: { color: '#94a3b8' } },
                y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#94a3b8' } }
            }
        }
    });

    // Render Portfolio Greeks Chart
    const ctxGreeks = document.getElementById("greeksChart").getContext("2d");
    if (state.greeksChart) state.greeksChart.destroy();
    
    state.greeksChart = new Chart(ctxGreeks, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Delta',
                    data: daily.map(d => d.greeks.delta),
                    borderColor: 'rgba(6, 182, 212, 0.8)',
                    borderWidth: 1.5,
                    tension: 0.1,
                    pointRadius: 0
                },
                {
                    // Gamma is tiny relative to Delta; scaled up so it's visible
                    // on the shared axis (consistent with the Theta scaling).
                    label: 'Gamma (x10000)',
                    data: daily.map(d => d.greeks.gamma * 10000),
                    borderColor: 'rgba(16, 185, 129, 0.8)',
                    borderWidth: 1.5,
                    tension: 0.1,
                    pointRadius: 0
                },
                {
                    label: 'Theta (x100)',
                    // scaling theta so it is easily visualised on same axis
                    data: daily.map(d => d.greeks.theta * 100),
                    borderColor: 'rgba(245, 158, 11, 0.8)',
                    borderWidth: 1.5,
                    tension: 0.1,
                    pointRadius: 0
                },
                {
                    label: 'Vega',
                    data: daily.map(d => d.greeks.vega),
                    borderColor: 'rgba(139, 92, 246, 0.8)',
                    borderWidth: 1.5,
                    tension: 0.1,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                tooltip: { mode: 'index', intersect: false }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.02)' }, ticks: { color: '#94a3b8' } },
                y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#94a3b8' } }
            }
        }
    });
}

/* =========================================================================
   9. Simple / Pro View Switcher
   Toggles the two top-level views and persists the choice. Both views share
   the same `state` and engine, so legs/results carry across. Simple mode
   (simple.js) is the default first-run experience; Pro is one tap away.
   ========================================================================= */
function setViewMode(mode) {
    const simpleView = document.getElementById("simple-view");
    const proView = document.getElementById("pro-view");
    const explorerView = document.getElementById("explorer-view");
    if (!simpleView || !proView) return;

    const isSimple = mode === "simple";
    const isPro = mode === "pro";
    const isExplorer = mode === "explorer";

    simpleView.style.display = isSimple ? "" : "none";
    // #pro-view is `display: contents` in CSS so the existing layout is intact;
    // restore that (empty string) rather than forcing `block`.
    proView.style.display = isPro ? "" : "none";
    if (explorerView) {
        explorerView.style.display = isExplorer ? "" : "none";
    }

    document.querySelectorAll(".view-toggle-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.view === mode);
    });

    state.viewMode = mode;
    localStorage.setItem("algo-view-mode", mode);

    if (isSimple && window.onEnterSimpleMode) window.onEnterSimpleMode();
    if (isExplorer && window.onEnterExplorerMode) window.onEnterExplorerMode();
}

// Expose helpers used by simple.js (these are module-scope function declarations).
window.setViewMode = setViewMode;
window.populateMetricsCards = populateMetricsCards;
window.populateTradeLedger = populateTradeLedger;

document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".view-toggle-btn").forEach(btn => {
        btn.addEventListener("click", () => setViewMode(btn.dataset.view));
    });
    // Precedence: explicit ?view= deep link > saved preference > Simple default.
    const urlView = new URLSearchParams(window.location.search).get("view");
    const initialView = (urlView === "simple" || urlView === "pro" || urlView === "explorer")
        ? urlView
        : (localStorage.getItem("algo-view-mode") || "simple");
    setViewMode(initialView);

    // Collapsible Sidebar Config for Mobile/Tablet views (<= 1024px)
    const sidebarTitle = document.querySelector('.sidebar-title');
    const sidebarConfig = document.querySelector('.sidebar-config');
    if (sidebarTitle && sidebarConfig) {
        // Collapse by default on load if screen width is <= 1024px
        if (window.innerWidth <= 1024) {
            sidebarConfig.classList.add('collapsed');
        }

        // Toggle on click
        sidebarTitle.addEventListener('click', () => {
            if (window.innerWidth <= 1024) {
                sidebarConfig.classList.toggle('collapsed');
            }
        });
    }
});
