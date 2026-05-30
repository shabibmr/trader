/**
 * algoOptions - Options Backtesting & Simulation Engine
 */

const OptionSimulator = {
    // Default lot sizes for NSE option contracts.
    // NOTE: NSE revises these periodically — verify against the latest NSE
    // circular before relying on absolute rupee figures.
    getLotSize(symbol) {
        const lotSizes = {
            'NIFTY': 75,
            'BANKNIFTY': 35,
            'FINNIFTY': 65,
            'MIDCPNIFTY': 120,
            'RELIANCE': 500,
            'TCS': 175,
            'INFY': 400
        };
        return lotSizes[symbol.toUpperCase()] || 100;
    },

    /**
     * Approximate the capital a position blocks (NSE-style).
     * Long-only/debit positions block their net debit. Defined-risk positions
     * (spreads) block their worst-case loss. Positions with unbounded risk
     * (naked short calls/puts) block a SPAN-style percentage of notional.
     *
     * @returns {number} estimated margin in rupees
     */
    estimatePositionMargin(legs, spot, lotSize) {
        // Net debit paid (positive = money out the door at entry)
        const netDebit = legs.reduce((acc, leg) => {
            const val = leg.entryPremium * leg.qty * lotSize;
            return acc + (leg.action === 'BUY' ? val : -val);
        }, 0);

        // Detect unbounded tails: more short calls than long calls (upside),
        // or more short puts than long puts (downside).
        const net = { CE: 0, PE: 0 };
        legs.forEach(leg => {
            net[leg.type] += (leg.action === 'SELL' ? 1 : -1) * leg.qty;
        });
        const nakedShortCall = net.CE > 0;
        const nakedShortPut = net.PE > 0;

        // Worst-case loss across a bounded sweep (captures defined-risk spreads).
        let worstLoss = 0;
        const lo = spot * 0.6, hi = spot * 1.4;
        for (let i = 0; i <= 40; i++) {
            const s = lo + (hi - lo) * (i / 40);
            let pnl = 0;
            legs.forEach(leg => {
                pnl += OptionMath.calculateExpiryPayoff(
                    leg.type, leg.action, leg.strike, leg.entryPremium, s, leg.qty * lotSize
                );
            });
            worstLoss = Math.max(worstLoss, -pnl);
        }

        // SPAN-style notional floor for the unbounded leg(s).
        const SPAN_PCT = 0.12;
        let notionalFloor = 0;
        if (nakedShortCall) notionalFloor = Math.max(notionalFloor, SPAN_PCT * spot * lotSize * net.CE);
        if (nakedShortPut) notionalFloor = Math.max(notionalFloor, SPAN_PCT * spot * lotSize * net.PE);

        return Math.max(worstLoss, notionalFloor, Math.max(0, netDebit));
    },

    // Default strike step size for NSE options
    getStrikeStep(symbol) {
        const steps = {
            'NIFTY': 50,
            'BANKNIFTY': 100,
            'FINNIFTY': 100,
            'RELIANCE': 20,
            'TCS': 50,
            'INFY': 10
        };
        return steps[symbol.toUpperCase()] || 50;
    },

    /**
     * Runs a daily backtest simulating a systematic option trading strategy.
     * 
     * @param {object} params - Backtest parameters
     * @returns {object} Backtest results report
     */
    runBacktest(params) {
        const {
            symbol,
            historicalData,
            startDate,
            endDate,
            initialCapital = 1000000,
            strategyKey,
            customLegs = null, // for manually built strategies
            customLegsSpot = null, // spot at which custom legs were built (for re-striking)
            dte = 30,
            iv = 15, // fallback baseline IV when a day has no IV in the data
            useDynamicIV = true, // use the per-day IV from historical data when available
            slippagePct = 0.05,
            brokeragePerOrder = 20,
            stopLossPct = 0, // 0 means disabled, e.g. 2 means 2% of initial capital
            takeProfitPct = 0, // 0 means disabled
            r = 0.07 // 7% risk free rate
        } = params;

        const lotSize = this.getLotSize(symbol);
        const strikeStep = this.getStrikeStep(symbol);
        
        // Filter historical data for selected date range
        const data = historicalData.filter(d => d.date >= startDate && d.date <= endDate);
        if (data.length < 5) {
            throw new Error("Insufficient historical data in selected range (need at least 5 trading days).");
        }

        let cash = initialCapital;
        let activePosition = null;
        const tradeLedger = [];
        const dailyEquity = [];
        
        let maxEquity = initialCapital;
        let maxDrawdown = 0;
        let maxMarginUsed = 0;
        
        // Step through each day
        for (let i = 0; i < data.length; i++) {
            const currentDay = data[i];
            const spot = currentDay.close;
            const currentDateStr = currentDay.date;
            // Per-day implied volatility drives vega P&L. Falls back to the
            // baseline slider value when the data has no IV for this day.
            const dayIv = (useDynamicIV && currentDay.iv != null) ? currentDay.iv : iv;

            // 1. Process Active Position if any
            if (activePosition) {
                // Find elapsed calendar days since previous trading day
                const prevDay = data[i - 1];
                const calDays = Math.max(1, (new Date(currentDateStr) - new Date(prevDay.date)) / (1000 * 60 * 60 * 24));
                activePosition.remainingDte -= calDays;

                // Re-evaluate leg values at current spot price
                let totalCurrentValue = 0;
                let legDetails = [];

                for (let leg of activePosition.legs) {
                    const result = OptionMath.calculateOption(
                        leg.type,
                        spot,
                        leg.strike,
                        activePosition.remainingDte,
                        dayIv,
                        r
                    );
                    
                    const legVal = result.price * leg.qty * lotSize;
                    const valueImpact = leg.action === 'BUY' ? legVal : -legVal;
                    totalCurrentValue += valueImpact;
                    
                    legDetails.push({
                        ...leg,
                        currentPrice: result.price,
                        currentValue: legVal,
                        delta: result.delta * leg.qty * (leg.action === 'BUY' ? 1 : -1),
                        gamma: result.gamma * leg.qty * (leg.action === 'BUY' ? 1 : -1),
                        theta: result.theta * leg.qty * (leg.action === 'BUY' ? 1 : -1),
                        vega: result.vega * leg.qty * (leg.action === 'BUY' ? 1 : -1)
                    });
                }

                const entryNetDebitCredit = activePosition.legs.reduce((acc, leg) => {
                    const legVal = leg.entryPremium * leg.qty * lotSize;
                    return acc + (leg.action === 'BUY' ? -legVal : legVal);
                }, 0);

                const currentNetVal = legDetails.reduce((acc, leg) => {
                    return acc + (leg.action === 'BUY' ? leg.currentValue : -leg.currentValue);
                }, 0);

                // Strategy P&L = Current Portfolio Value of options minus initial entry debit/credit
                const cyclePnL = currentNetVal - entryNetDebitCredit;
                
                // Aggregated Portfolio Greeks
                const portfolioGreeks = {
                    delta: legDetails.reduce((sum, leg) => sum + leg.delta, 0) * lotSize,
                    gamma: legDetails.reduce((sum, leg) => sum + leg.gamma, 0) * lotSize,
                    theta: legDetails.reduce((sum, leg) => sum + leg.theta, 0) * lotSize,
                    vega: legDetails.reduce((sum, leg) => sum + leg.vega, 0) * lotSize
                };

                // Check Exit Conditions
                let shouldClose = false;
                let exitReason = "Expiry";

                if (activePosition.remainingDte <= 0) {
                    shouldClose = true;
                    exitReason = "Expiry";
                } else if (stopLossPct > 0 && cyclePnL <= -(stopLossPct / 100) * initialCapital) {
                    shouldClose = true;
                    exitReason = "Stop Loss";
                } else if (takeProfitPct > 0 && cyclePnL >= (takeProfitPct / 100) * initialCapital) {
                    shouldClose = true;
                    exitReason = "Take Profit";
                }

                if (shouldClose) {
                    // Close position
                    let finalClosingValue = 0;
                    let transactionCosts = 0;

                    for (let leg of legDetails) {
                        let finalPrice = 0;
                        if (exitReason === "Expiry") {
                            // At expiry, options settle at their intrinsic value
                            finalPrice = leg.type === 'CE' ? 
                                Math.max(0, spot - leg.strike) : 
                                Math.max(0, leg.strike - spot);
                        } else {
                            // Closed early, close at market pricing
                            finalPrice = leg.currentPrice;
                        }

                        const legClosingVal = finalPrice * leg.qty * lotSize;
                        finalClosingValue += (leg.action === 'BUY' ? legClosingVal : -legClosingVal);

                        // Closing fees & slippage
                        transactionCosts += brokeragePerOrder;
                        transactionCosts += (slippagePct / 100) * finalPrice * leg.qty * lotSize;
                    }

                    const tradePnL = finalClosingValue - entryNetDebitCredit - transactionCosts - activePosition.entryFees;
                    cash += (finalClosingValue - transactionCosts);

                    tradeLedger.push({
                        entryDate: activePosition.entryDate,
                        exitDate: currentDateStr,
                        strategy: activePosition.strategyName,
                        entrySpot: activePosition.entrySpot,
                        exitSpot: spot,
                        legs: legDetails.map(l => ({
                            action: l.action,
                            type: l.type,
                            strike: l.strike,
                            qty: l.qty,
                            entryPremium: l.entryPremium,
                            exitPremium: exitReason === "Expiry" ? (l.type === 'CE' ? Math.max(0, spot - l.strike) : Math.max(0, l.strike - spot)) : l.currentPrice
                        })),
                        netEntryPremium: entryNetDebitCredit,
                        netExitPremium: finalClosingValue,
                        brokerage: activePosition.entryFees + transactionCosts,
                        marginUsed: activePosition.margin,
                        pnl: tradePnL,
                        exitReason: exitReason
                    });

                    activePosition = null;
                } else {
                    // Position remains active. Update daily portfolio value
                    const portfolioValue = cash + currentNetVal;
                    maxEquity = Math.max(maxEquity, portfolioValue);
                    const dd = ((maxEquity - portfolioValue) / maxEquity) * 100;
                    maxDrawdown = Math.max(maxDrawdown, dd);

                    dailyEquity.push({
                        date: currentDateStr,
                        spot: spot,
                        cash: cash,
                        optionsValue: currentNetVal,
                        equity: portfolioValue,
                        pnl: portfolioValue - initialCapital,
                        greeks: portfolioGreeks
                    });
                }
            }

            // 2. Open Position if activePosition is null and we are not on the last day
            if (!activePosition && i < data.length - 2) {
                let strategyLegs = [];
                let strategyName = "Custom Options Strategy";

                if (strategyKey === 'custom' && customLegs) {
                    // Re-strike custom legs relative to the entry-day spot so the
                    // strategy keeps its original moneyness on each roll instead of
                    // clinging to stale absolute strikes as the underlying drifts.
                    strategyLegs = customLegs.map(leg => {
                        let strike = leg.strike;
                        if (customLegsSpot) {
                            const offset = leg.strike - customLegsSpot;
                            strike = Math.round((spot + offset) / strikeStep) * strikeStep;
                        }
                        return { action: leg.action, type: leg.type, strike: strike, qty: leg.qty };
                    });
                } else if (OptionStrategies.presets[strategyKey]) {
                    const preset = OptionStrategies.presets[strategyKey];
                    strategyLegs = preset.getLegs(spot, strikeStep);
                    strategyName = preset.name;
                }

                if (strategyLegs.length > 0) {
                    let entryDebitCredit = 0;
                    let entryFees = 0;
                    const populatedLegs = [];

                    for (let leg of strategyLegs) {
                        // Historical entry must be priced theoretically (BSM at the
                        // historical spot/IV) — the live chain LTP only exists for
                        // "today", so it cannot be used to enter on a past date.
                        // This is why the payoff diagram (live LTP) and the backtest
                        // (theoretical) can differ for the same custom strategy.
                        const pricing = OptionMath.calculateOption(
                            leg.type,
                            spot,
                            leg.strike,
                            dte,
                            dayIv,
                            r
                        );

                        const entryPrem = pricing.price;
                        populatedLegs.push({
                            ...leg,
                            entryPremium: entryPrem
                        });

                        const legVal = entryPrem * leg.qty * lotSize;
                        entryDebitCredit += (leg.action === 'BUY' ? -legVal : legVal);

                        // Entry costs
                        entryFees += brokeragePerOrder;
                        entryFees += (slippagePct / 100) * legVal;
                    }

                    // Capital gate: only take the trade if we can post the margin
                    // it requires. Without this, short-premium strategies look
                    // free, making return-on-capital meaningless.
                    const marginRequired = this.estimatePositionMargin(populatedLegs, spot, lotSize);

                    if (cash >= marginRequired) {
                        // Deduct initial capital to enter the position
                        cash += (entryDebitCredit - entryFees);

                        activePosition = {
                            strategyName: strategyName,
                            entryDate: currentDateStr,
                            entrySpot: spot,
                            legs: populatedLegs,
                            entryFees: entryFees,
                            remainingDte: dte,
                            margin: marginRequired
                        };

                        maxMarginUsed = Math.max(maxMarginUsed, marginRequired);
                    }
                }
            }

            // 3. If there is no active position (because we closed it today or didn't open), equity is pure cash
            if (!activePosition) {
                maxEquity = Math.max(maxEquity, cash);
                const dd = ((maxEquity - cash) / maxEquity) * 100;
                maxDrawdown = Math.max(maxDrawdown, dd);

                dailyEquity.push({
                    date: currentDateStr,
                    spot: spot,
                    cash: cash,
                    optionsValue: 0,
                    equity: cash,
                    pnl: cash - initialCapital,
                    greeks: { delta: 0, gamma: 0, theta: 0, vega: 0 }
                });
            }
        }

        // Calculate metrics
        const finalEquity = dailyEquity[dailyEquity.length - 1].equity;
        const totalReturn = ((finalEquity - initialCapital) / initialCapital) * 100;
        
        // Calculate Sharpe Ratio (using standard deviation of daily percentage changes)
        let dailyPctChanges = [];
        for (let j = 1; j < dailyEquity.length; j++) {
            const prev = dailyEquity[j - 1].equity;
            const curr = dailyEquity[j].equity;
            dailyPctChanges.push((curr - prev) / prev);
        }
        
        let avgDailyReturn = dailyPctChanges.reduce((sum, val) => sum + val, 0) / (dailyPctChanges.length || 1);
        let variance = dailyPctChanges.reduce((sum, val) => sum + Math.pow(val - avgDailyReturn, 2), 0) / (dailyPctChanges.length || 1);
        let stdDevDaily = Math.sqrt(variance);
        
        // Annualized Sharpe Ratio = (avgDailyReturn / stdDevDaily) * Math.sqrt(252)
        // Assuming 252 trading days per year. Risk-free rate is ignored for simplicity or assume 0 in this daily volatility view
        let sharpeRatio = 0;
        if (stdDevDaily > 0) {
            sharpeRatio = (avgDailyReturn / stdDevDaily) * Math.sqrt(252);
        }

        const winTrades = tradeLedger.filter(t => t.pnl > 0).length;
        const totalTrades = tradeLedger.length;
        const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;
        
        const totalProfit = tradeLedger.filter(t => t.pnl > 0).reduce((acc, t) => acc + t.pnl, 0);
        const totalLoss = Math.abs(tradeLedger.filter(t => t.pnl < 0).reduce((acc, t) => acc + t.pnl, 0));
        const profitFactor = totalLoss > 0 ? (totalProfit / totalLoss) : totalProfit;

        const totalBrokerage = tradeLedger.reduce((acc, t) => acc + t.brokerage, 0);

        // Benchmark comparison (Buy and Hold underlying index/stock)
        const startSpot = dailyEquity[0].spot;
        const endSpot = dailyEquity[dailyEquity.length - 1].spot;
        const benchmarkReturn = ((endSpot - startSpot) / startSpot) * 100;

        return {
            symbol: symbol,
            initialCapital: initialCapital,
            finalCapital: finalEquity,
            totalReturn: totalReturn,
            benchmarkReturn: benchmarkReturn,
            maxDrawdown: maxDrawdown,
            sharpeRatio: sharpeRatio,
            winRate: winRate,
            profitFactor: profitFactor,
            totalTrades: totalTrades,
            totalBrokerage: totalBrokerage,
            maxMarginUsed: maxMarginUsed,
            marginUtilization: (maxMarginUsed / initialCapital) * 100,
            tradeLedger: tradeLedger,
            dailyEquity: dailyEquity
        };
    }
};

// Export if running in node, otherwise attach to window
if (typeof module !== 'undefined' && module.exports) {
    module.exports = OptionSimulator;
} else {
    window.OptionSimulator = OptionSimulator;
}
