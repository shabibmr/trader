/**
 * algoOptions - Pre-configured Multi-Leg Option Strategies
 */

const OptionStrategies = {
    presets: {
        'bull_call_spread': {
            name: 'Bull Call Spread',
            description: 'Directional moderate bullish strategy. Buy an ATM Call and sell an OTM Call to define risk and reduce premium cost.',
            getLegs(spot, step) {
                const atm = Math.round(spot / step) * step;
                return [
                    { action: 'BUY', type: 'CE', strike: atm, qty: 1 },
                    { action: 'SELL', type: 'CE', strike: atm + step, qty: 1 }
                ];
            }
        },
        'bear_put_spread': {
            name: 'Bear Put Spread',
            description: 'Directional moderate bearish strategy. Buy an ATM Put and sell an OTM Put to define risk and reduce premium cost.',
            getLegs(spot, step) {
                const atm = Math.round(spot / step) * step;
                return [
                    { action: 'BUY', type: 'PE', strike: atm, qty: 1 },
                    { action: 'SELL', type: 'PE', strike: atm - step, qty: 1 }
                ];
            }
        },
        'iron_condor': {
            name: 'Iron Condor',
            description: 'Neutral range-bound play. Sell an OTM Put and OTM Call, while buying a further OTM Put and Call as protection. Profits from time decay and low volatility.',
            getLegs(spot, step) {
                const atm = Math.round(spot / step) * step;
                return [
                    { action: 'BUY', type: 'PE', strike: atm - 2 * step, qty: 1 },
                    { action: 'SELL', type: 'PE', strike: atm - 1 * step, qty: 1 },
                    { action: 'SELL', type: 'CE', strike: atm + 1 * step, qty: 1 },
                    { action: 'BUY', type: 'CE', strike: atm + 2 * step, qty: 1 }
                ];
            }
        },
        'long_straddle': {
            name: 'Long Straddle',
            description: 'Neutral volatility blowout strategy. Buy both ATM Call and ATM Put. Profit from a major directional move in either direction.',
            getLegs(spot, step) {
                const atm = Math.round(spot / step) * step;
                return [
                    { action: 'BUY', type: 'CE', strike: atm, qty: 1 },
                    { action: 'BUY', type: 'PE', strike: atm, qty: 1 }
                ];
            }
        },
        'short_strangle': {
            name: 'Short Strangle',
            description: 'Neutral volatility collection strategy. Sell an OTM Call and OTM Put. Collects high premium, but carries high risk if market breaks outside the strikes.',
            getLegs(spot, step) {
                const atm = Math.round(spot / step) * step;
                return [
                    { action: 'SELL', type: 'PE', strike: atm - step, qty: 1 },
                    { action: 'SELL', type: 'CE', strike: atm + step, qty: 1 }
                ];
            }
        },
        'iron_butterfly': {
            name: 'Iron Butterfly',
            description: 'Neutral range play with defined risk. Sell ATM Call and ATM Put, buy OTM Call and OTM Put for protection. Max profit at the ATM strike.',
            getLegs(spot, step) {
                const atm = Math.round(spot / step) * step;
                return [
                    { action: 'BUY', type: 'PE', strike: atm - 2 * step, qty: 1 },
                    { action: 'SELL', type: 'PE', strike: atm, qty: 1 },
                    { action: 'SELL', type: 'CE', strike: atm, qty: 1 },
                    { action: 'BUY', type: 'CE', strike: atm + 2 * step, qty: 1 }
                ];
            }
        }
    }
};

// Export if running in node, otherwise attach to window
if (typeof module !== 'undefined' && module.exports) {
    module.exports = OptionStrategies;
} else {
    window.OptionStrategies = OptionStrategies;
}
