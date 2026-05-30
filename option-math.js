/**
 * algoOptions - Black-Scholes-Merton (BSM) Options Pricing & Greeks Math Library
 */

const OptionMath = {
    // Standard normal probability density function N'(x)
    ndf(x) {
        return Math.exp(-x * x / 2.0) / Math.sqrt(2.0 * Math.PI);
    },

    // High-accuracy numerical approximation of standard normal cumulative distribution N(x)
    // Using Hastings approximation (precision of ~1e-7)
    cdf(x) {
        if (x < 0.0) {
            return 1.0 - this.cdf(-x);
        }
        const p = 0.2316419;
        const a1 = 0.319381530;
        const a2 = -0.356563782;
        const a3 = 1.781477937;
        const a4 = -1.821255978;
        const a5 = 1.330274429;
        
        const k = 1.0 / (1.0 + p * x);
        const cdfVal = 1.0 - this.ndf(x) * (a1 * k + a2 * Math.pow(k, 2) + a3 * Math.pow(k, 3) + a4 * Math.pow(k, 4) + a5 * Math.pow(k, 5));
        return cdfVal;
    },

    /**
     * Calculates the Black-Scholes-Merton theoretical price and Greeks for an option leg.
     * 
     * @param {string} type - 'CE' (Call) or 'PE' (Put)
     * @param {number} S - Underlying Spot Price
     * @param {number} K - Strike Price
     * @param {number} dte - Days to Expiry (must be > 0)
     * @param {number} iv - Implied Volatility (as percentage, e.g. 15.5 for 15.5%)
     * @param {number} r - Risk-free interest rate (as decimal, e.g. 0.07 for 7%)
     * @returns {object} Object containing price, delta, gamma, theta, and vega
     */
    calculateOption(type, S, K, dte, iv, r = 0.07) {
        const t = Math.max(0.0001, dte) / 365.0; // t in years
        const v = Math.max(0.01, iv) / 100.0;    // Volatility as decimal
        
        // Handle immediate expiry / extremely low time
        if (dte <= 0) {
            const intrinsic = type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
            let delta = 0;
            if (type === 'CE') {
                delta = S > K ? 1.0 : (S === K ? 0.5 : 0.0);
            } else {
                delta = S < K ? -1.0 : (S === K ? -0.5 : 0.0);
            }
            return {
                price: intrinsic,
                delta: delta,
                gamma: 0,
                theta: 0,
                vega: 0
            };
        }

        const d1 = (Math.log(S / K) + (r + (v * v) / 2.0) * t) / (v * Math.sqrt(t));
        const d2 = d1 - v * Math.sqrt(t);
        
        const n_d1 = this.cdf(d1);
        const n_d2 = this.cdf(d2);
        const n_minus_d1 = this.cdf(-d1);
        const n_minus_d2 = this.cdf(-d2);
        const n_prime_d1 = this.ndf(d1);
        
        let price = 0;
        let delta = 0;
        let theta = 0;
        
        if (type === 'CE') {
            price = S * n_d1 - K * Math.exp(-r * t) * n_d2;
            delta = n_d1;
            // Theta formula for Call (annual decay, divided by 365 for daily decay)
            const theta_annual = -(S * n_prime_d1 * v) / (2 * Math.sqrt(t)) - r * K * Math.exp(-r * t) * n_d2;
            theta = theta_annual / 365.0;
        } else { // PE
            price = K * Math.exp(-r * t) * n_minus_d2 - S * n_minus_d1;
            delta = n_d1 - 1.0;
            // Theta formula for Put (annual decay, divided by 365 for daily decay)
            const theta_annual = -(S * n_prime_d1 * v) / (2 * Math.sqrt(t)) + r * K * Math.exp(-r * t) * n_minus_d2;
            theta = theta_annual / 365.0;
        }
        
        // Gamma (same for Call & Put)
        const gamma = n_prime_d1 / (S * v * Math.sqrt(t));
        
        // Vega (same for Call & Put, divided by 100 for 1% IV change pricing)
        const vega = (S * Math.sqrt(t) * n_prime_d1) / 100.0;
        
        return {
            price: Math.max(0.05, price), // Option prices don't drop below the minimum tick size of 0.05 on NSE
            delta: delta,
            gamma: gamma,
            theta: theta,
            vega: vega
        };
    },

    /**
     * Calculates the payoff profile for a specific trade leg at expiry.
     * @param {string} type - 'CE' or 'PE'
     * @param {string} action - 'BUY' or 'SELL'
     * @param {number} strikePrice - Strike price of the option
     * @param {number} entryPremium - Premium at which trade was entered
     * @param {number} spotPrice - The spot price to calculate the payoff at
     * @param {number} qty - Lots * LotSize
     */
    calculateExpiryPayoff(type, action, strikePrice, entryPremium, spotPrice, qty) {
        let grossPayoff = 0;
        if (type === 'CE') {
            grossPayoff = Math.max(0, spotPrice - strikePrice);
        } else {
            grossPayoff = Math.max(0, strikePrice - spotPrice);
        }
        
        let pnlPerShare = 0;
        if (action === 'BUY') {
            pnlPerShare = grossPayoff - entryPremium;
        } else { // SELL
            pnlPerShare = entryPremium - grossPayoff;
        }
        
        return pnlPerShare * qty;
    }
};

// Export if running in node, otherwise attach to window
if (typeof module !== 'undefined' && module.exports) {
    module.exports = OptionMath;
} else {
    window.OptionMath = OptionMath;
}
