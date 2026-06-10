/**
 * algoOptions - Options Chain Explorer & Gemini AI Chat Co-pilot
 */

// Local Explorer State
const explorerState = {
    symbol: 'NIFTY',
    startDate: '2025-01-01',
    endDate: '2026-05-01',
    historicalData: [],
    selectedExpiry: '',
    selectedViewDate: '',
    calculatedStrikes: [],
    chatMessages: [
        {
            role: 'model',
            parts: [{ text: "Hello! I am your options co-pilot. I can help you analyze this options chain, understand Greeks (Delta, Theta), or design a custom strategy. Ask me anything!" }]
        }
    ]
};

document.addEventListener("DOMContentLoaded", () => {
    // Wait for symbol universe to load from app.js (give up after ~5s)
    let attempts = 0;
    const checkSymbols = setInterval(() => {
        if (window.NSE_SYMBOLS && window.NSE_SYMBOL_MAP) {
            clearInterval(checkSymbols);
            initExplorer();
        } else if (++attempts >= 100) {
            clearInterval(checkSymbols);
            console.error("Explorer init failed: NSE symbol universe never loaded (app.js missing or errored).");
        }
    }, 50);
});

function initExplorer() {
    const symbolSelect = document.getElementById("exp-ticker-select");
    const startDateInput = document.getElementById("exp-start-date");
    const endDateInput = document.getElementById("exp-end-date");
    const expirySelect = document.getElementById("exp-expiry-select");
    const viewDateSelect = document.getElementById("exp-view-date-select");

    // Populate Symbol Dropdown
    symbolSelect.innerHTML = "";
    const groups = {
        index: document.createElement("optgroup"),
        equity: document.createElement("optgroup")
    };
    groups.index.label = "Indices";
    groups.equity.label = "Equities (F&O)";

    window.NSE_SYMBOLS.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s.symbol;
        opt.text = s.type === "index" ? `${s.name} (Index)` : `${s.name} (${s.symbol})`;
        (groups[s.type] || groups.equity).appendChild(opt);
    });
    if (groups.index.children.length) symbolSelect.appendChild(groups.index);
    if (groups.equity.children.length) symbolSelect.appendChild(groups.equity);

    // Default values
    symbolSelect.value = explorerState.symbol;
    startDateInput.value = explorerState.startDate;
    endDateInput.value = explorerState.endDate;

    // Listeners
    symbolSelect.addEventListener("change", (e) => {
        explorerState.symbol = e.target.value;
        loadHistoricalData();
    });

    startDateInput.addEventListener("change", (e) => {
        explorerState.startDate = e.target.value;
        // Validate dates
        if (startDateInput.value >= endDateInput.value) {
            endDateInput.value = addDays(startDateInput.value, 30);
            explorerState.endDate = endDateInput.value;
        }
        loadHistoricalData();
    });

    endDateInput.addEventListener("change", (e) => {
        explorerState.endDate = e.target.value;
        if (endDateInput.value <= startDateInput.value) {
            startDateInput.value = addDays(endDateInput.value, -30);
            explorerState.startDate = startDateInput.value;
        }
        loadHistoricalData();
    });

    expirySelect.addEventListener("change", (e) => {
        explorerState.selectedExpiry = e.target.value;
        onExpiryChanged();
    });

    viewDateSelect.addEventListener("change", (e) => {
        explorerState.selectedViewDate = e.target.value;
        renderExplorerChain();
    });

    // Handle suggestion clicks
    document.querySelectorAll(".chat-suggest-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const query = btn.getAttribute("data-query");
            const input = document.getElementById("chat-input");
            input.value = query;
            sendChatMessage();
        });
    });

    // Initial load
    loadHistoricalData();
}

function addDays(dateStr, days) {
    const date = new Date(dateStr);
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
}

// Loads historical daily stock/index data
async function loadHistoricalData() {
    const expirySelect = document.getElementById("exp-expiry-select");
    const viewDateSelect = document.getElementById("exp-view-date-select");
    const tbody = document.getElementById("exp-chain-table-body");

    expirySelect.innerHTML = "<option>Loading expiries...</option>";
    viewDateSelect.innerHTML = "<option>Waiting...</option>";
    tbody.innerHTML = `<tr><td colspan="13" style="text-align: center; padding: 40px; color: var(--text-secondary);">
        Loading historical data from server...
    </td></tr>`;

    const host = window.location.origin === "null" || window.location.protocol === "file:" ? "http://localhost:8080" : "";
    const url = `${host}/api/historical-underlying?symbol=${encodeURIComponent(explorerState.symbol)}`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("HTTP error " + response.status);
        const data = await response.json();

        // Filter by date range
        explorerState.historicalData = data.filter(d => d.date >= explorerState.startDate && d.date <= explorerState.endDate);
        
        if (explorerState.historicalData.length === 0) {
            tbody.innerHTML = `<tr><td colspan="13" style="text-align: center; padding: 40px; color: var(--color-loss);">
                No historical data found in this date range. Try expanding the range or changing dates.
            </td></tr>`;
            return;
        }

        // Determine all Thursday expiries in the date range
        const expiries = getThursdays(explorerState.startDate, explorerState.endDate);
        
        if (expiries.length === 0) {
            expirySelect.innerHTML = "<option>No expiries found</option>";
            return;
        }

        expirySelect.innerHTML = "";
        expiries.forEach(exp => {
            const opt = document.createElement("option");
            opt.value = exp;
            opt.text = formatDateDisplay(exp);
            expirySelect.appendChild(opt);
        });

        // Set default expiry
        explorerState.selectedExpiry = expiries[0];
        expirySelect.value = explorerState.selectedExpiry;
        onExpiryChanged();

    } catch (err) {
        console.error("Explorer historical load failed:", err);
        tbody.innerHTML = `<tr><td colspan="13" style="text-align: center; padding: 40px; color: var(--color-loss);">
            Failed to connect to local server. Make sure server.py is running.
        </td></tr>`;
    }
}

// Generate all Thursdays between start and end date strings
function getThursdays(startStr, endStr) {
    const thursdays = [];
    const start = new Date(startStr);
    const end = new Date(endStr);
    let curr = new Date(start);
    
    // Align to next Thursday (getDay === 4)
    while (curr.getDay() !== 4) {
        curr.setDate(curr.getDate() + 1);
    }
    
    while (curr <= end) {
        thursdays.push(curr.toISOString().split('T')[0]);
        curr.setDate(curr.getDate() + 7);
    }
    return thursdays;
}

function formatDateDisplay(dateStr) {
    const d = new Date(dateStr);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

// Update View Dates when Expiry changes
function onExpiryChanged() {
    const viewDateSelect = document.getElementById("exp-view-date-select");
    
    // View dates are historical trading days before or equal to the expiry
    const tradingDatesBeforeExpiry = explorerState.historicalData
        .filter(row => row.date <= explorerState.selectedExpiry)
        .map(row => row.date)
        .sort()
        .reverse(); // Newest first

    if (tradingDatesBeforeExpiry.length === 0) {
        viewDateSelect.innerHTML = "<option>No trading dates before expiry</option>";
        return;
    }

    viewDateSelect.innerHTML = "";
    tradingDatesBeforeExpiry.forEach(date => {
        const opt = document.createElement("option");
        opt.value = date;
        opt.text = `${formatDateDisplay(date)}${date === explorerState.selectedExpiry ? ' (Expiry Day)' : ''}`;
        viewDateSelect.appendChild(opt);
    });

    // Set default view date (e.g. 15 days before expiry, or closest if not available)
    const targetDateStr = addDays(explorerState.selectedExpiry, -15);
    let defaultIndex = tradingDatesBeforeExpiry.findIndex(d => d <= targetDateStr);
    // All available dates are within 15 days of expiry — fall back to the oldest one
    if (defaultIndex === -1) defaultIndex = tradingDatesBeforeExpiry.length - 1;

    explorerState.selectedViewDate = tradingDatesBeforeExpiry[defaultIndex];
    viewDateSelect.value = explorerState.selectedViewDate;

    renderExplorerChain();
}

// Deterministic seeded random number generator for Volume & OI consistency
function seededRandom(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
}

// Calculate and render the Option Chain
function renderExplorerChain() {
    const tbody = document.getElementById("exp-chain-table-body");
    const spotDisplay = document.getElementById("exp-spot-display");
    const dteDisplay = document.getElementById("exp-dte-display");
    
    if (!explorerState.selectedExpiry || !explorerState.selectedViewDate) {
        tbody.innerHTML = `<tr><td colspan="13" style="text-align: center; padding: 30px; color: var(--text-secondary);">Select parameters above...</td></tr>`;
        return;
    }

    // Get historical record on view date
    const record = explorerState.historicalData.find(r => r.date === explorerState.selectedViewDate);
    if (!record) {
        tbody.innerHTML = `<tr><td colspan="13" style="text-align: center; padding: 30px; color: var(--text-secondary);">Trading date not found in history.</td></tr>`;
        return;
    }

    const spot = record.close;
    const baseIv = record.iv || 15.0;

    // Calculate DTE
    const d1 = new Date(explorerState.selectedViewDate);
    const d2 = new Date(explorerState.selectedExpiry);
    const dte = Math.max(0, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));

    spotDisplay.innerText = `Spot Price: ₹${spot.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    dteDisplay.innerText = `DTE: ${dte} Days`;

    // Generate strikes
    const step = window.OptionSimulator.getStrikeStep(explorerState.symbol);
    const roundedSpot = Math.round(spot / step) * step;
    
    const strikes = [];
    for (let i = -10; i <= 10; i++) {
        strikes.push(roundedSpot + i * step);
    }

    tbody.innerHTML = "";
    
    // Sort strikes ascending
    strikes.sort((a, b) => a - b);

    // Save calculations for chat context
    explorerState.calculatedStrikes = [];

    strikes.forEach(strike => {
        const dist = (strike - spot) / spot;
        
        // Volatility skew (smile)
        const strikeIv = baseIv + (Math.abs(dist) * 20.0) + (dist < 0 ? -dist * 5.0 : 0);

        // Option Greeks & Price calculations
        const ceResult = window.OptionMath.calculateOption('CE', spot, strike, dte, strikeIv, 0.07);
        const peResult = window.OptionMath.calculateOption('PE', spot, strike, dte, strikeIv, 0.07);

        // Seeded random for volume/OI stability
        const seedVal = strike * 13 + dte * 43 + Math.floor(spot);
        const randCE = seededRandom(seedVal);
        const randPE = seededRandom(seedVal + 7);

        const ceOi = dte === 0 ? 0 : Math.round(Math.max(100, 80000 * Math.exp(-Math.pow(dist * 12, 2)) * (0.85 + randCE * 0.3)));
        const peOi = dte === 0 ? 0 : Math.round(Math.max(100, 80000 * Math.exp(-Math.pow(dist * 12, 2)) * (0.85 + randPE * 0.3)));
        
        const ceVol = dte === 0 ? 0 : Math.round(ceOi * (0.6 + randCE * 0.8));
        const peVol = dte === 0 ? 0 : Math.round(peOi * (0.6 + randPE * 0.8));

        explorerState.calculatedStrikes.push({
            strike,
            ce: { ltp: ceResult.price, iv: strikeIv, delta: ceResult.delta, theta: ceResult.theta, oi: ceOi, vol: ceVol },
            pe: { ltp: peResult.price, iv: strikeIv, delta: peResult.delta, theta: peResult.theta, oi: peOi, vol: peVol }
        });

        const isATM = Math.abs(strike - spot) <= (step / 2);
        
        const tr = document.createElement("tr");
        if (isATM) {
            tr.className = "atm-row";
        }

        tr.innerHTML = `
            <!-- CALLS -->
            <td style="color: var(--color-call);">${ceResult.delta.toFixed(2)}</td>
            <td style="color: var(--text-secondary);">${ceResult.theta.toFixed(2)}</td>
            <td style="color: var(--text-muted);">${strikeIv.toFixed(1)}%</td>
            <td>${ceOi ? ceOi.toLocaleString('en-IN') : '--'}</td>
            <td>${ceVol ? ceVol.toLocaleString('en-IN') : '--'}</td>
            <td style="font-weight: 700; color: var(--text-primary); border-right: 1px solid var(--border-color);">₹${ceResult.price.toFixed(2)}</td>
            
            <!-- STRIKE -->
            <td class="strike-cell" style="font-weight: 700; background: rgba(255,255,255,0.01);">${strike}</td>
            
            <!-- PUTS -->
            <td style="font-weight: 700; color: var(--text-primary); border-left: 1px solid var(--border-color);">₹${peResult.price.toFixed(2)}</td>
            <td>${peVol ? peVol.toLocaleString('en-IN') : '--'}</td>
            <td>${peOi ? peOi.toLocaleString('en-IN') : '--'}</td>
            <td style="color: var(--text-muted);">${strikeIv.toFixed(1)}%</td>
            <td style="color: var(--text-secondary);">${peResult.theta.toFixed(2)}</td>
            <td style="color: var(--color-put);">${peResult.delta.toFixed(2)}</td>
        `;

        tbody.appendChild(tr);
    });

    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
}

// Renders the AI Chat history
function renderChatHistory() {
    const historyDiv = document.getElementById("chat-history");
    historyDiv.innerHTML = "";

    explorerState.chatMessages.forEach(msg => {
        const item = document.createElement("div");
        item.className = `chat-message ${msg.role}`;
        
        const text = msg.parts[0].text;
        
        const contentDiv = document.createElement("div");
        contentDiv.className = "message-content";
        contentDiv.innerHTML = parseMarkdown(text);
        
        item.appendChild(contentDiv);
        historyDiv.appendChild(item);
    });

    historyDiv.scrollTop = historyDiv.scrollHeight;
}

// Simple Markdown parser for the chat messages
function parseMarkdown(text) {
    let html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
        
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
    
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    html = html.replace(/`(.*?)`/g, '<code>$1</code>');
    
    html = html.replace(/^\s*-\s+(.*$)/gim, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/g, '<ul>$1</ul>');
    html = html.replace(/<\/ul>\s*<ul>/g, '');

    html = html.replace(/\n/g, '<br>');
    
    return html;
}

// Send user message to the Gemini API via server
async function sendChatMessage() {
    const input = document.getElementById("chat-input");
    const query = input.value.trim();
    if (!query) return;

    input.value = "";
    
    // Add User message to state
    explorerState.chatMessages.push({
        role: 'user',
        parts: [{ text: query }]
    });

    renderChatHistory();

    // Show Typing Indicator
    const historyDiv = document.getElementById("chat-history");
    const indicator = document.createElement("div");
    indicator.className = "chat-message model typing-msg";
    indicator.id = "chat-typing-indicator";
    indicator.innerHTML = `
        <div class="message-content">
            <div class="typing-indicator">
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
            </div>
        </div>
    `;
    historyDiv.appendChild(indicator);
    historyDiv.scrollTop = historyDiv.scrollHeight;

    // Build context summary for Gemini — sort a copy against a fixed ATM pivot
    const strikesCopy = [...explorerState.calculatedStrikes];
    const atmStrike = strikesCopy[Math.floor(strikesCopy.length / 2)]?.strike ?? 0;
    const nearATM = strikesCopy
        .sort((a, b) => Math.abs(a.strike - atmStrike) - Math.abs(b.strike - atmStrike))
        .slice(0, 5)
        .sort((a, b) => a.strike - b.strike);

    let summaryText = "";
    nearATM.forEach(s => {
        summaryText += `Strike ${s.strike}: CE Premium=Rs.${s.ce.ltp.toFixed(2)}, CE Delta=${s.ce.delta.toFixed(2)}, CE Theta=${s.ce.theta.toFixed(2)}, CE OI=${s.ce.oi} | PE Premium=Rs.${s.pe.ltp.toFixed(2)}, PE Delta=${s.pe.delta.toFixed(2)}, PE Theta=${s.pe.theta.toFixed(2)}, PE OI=${s.pe.oi}\n`;
    });

    const host = window.location.origin === "null" || window.location.protocol === "file:" ? "http://localhost:8080" : "";
    const url = `${host}/api/chat`;

    const chatContext = {
        symbol: explorerState.symbol,
        spotPrice: explorerState.historicalData.find(r => r.date === explorerState.selectedViewDate)?.close || 22500,
        expiryDate: explorerState.selectedExpiry,
        viewDate: explorerState.selectedViewDate,
        dte: Math.max(0, Math.round((new Date(explorerState.selectedExpiry) - new Date(explorerState.selectedViewDate)) / (1000 * 60 * 60 * 24))),
        iv: explorerState.historicalData.find(r => r.date === explorerState.selectedViewDate)?.iv || 15.0,
        chainSummary: summaryText
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: explorerState.chatMessages,
                context: chatContext
            })
        });

        // Remove typing indicator
        const typingEl = document.getElementById("chat-typing-indicator");
        if (typingEl) typingEl.remove();

        if (!response.ok) throw new Error("HTTP error " + response.status);
        const data = await response.json();

        // Add model reply
        explorerState.chatMessages.push({
            role: 'model',
            parts: [{ text: data.reply }]
        });

        renderChatHistory();

    } catch (err) {
        console.error("Chat error:", err);
        const typingEl = document.getElementById("chat-typing-indicator");
        if (typingEl) typingEl.remove();

        explorerState.chatMessages.push({
            role: 'model',
            parts: [{ text: "I'm sorry, I encountered an error communicating with the chat server. Please ensure the server is running." }]
        });

        renderChatHistory();
    }
}

// Hook called when setViewMode is triggered
window.onEnterExplorerMode = function() {
    renderExplorerChain();
};
window.sendChatMessage = sendChatMessage;
