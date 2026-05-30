/**
 * Zero-dependency test suite for the Black-Scholes-Merton engine.
 * Run:  node test/option-math.test.js
 *
 * Strategy: re-derive the reference prices/Greeks with an INDEPENDENT
 * high-precision normal CDF (Abramowitz & Stegun 7.1.26 erf) and compare the
 * library output against it — this catches regressions without hard-coding
 * brittle magic numbers, while still asserting the plan's benchmark case.
 */

const OptionMath = require('../option-math.js');

let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.error(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
function approx(name, actual, expected, tol) {
    const ok = Math.abs(actual - expected) <= tol;
    check(name, ok, `got ${actual.toFixed(4)}, expected ${expected.toFixed(4)} ±${tol}`);
}

// --- Independent reference implementation ---------------------------------
function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
          a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
}
function normCdf(x) { return 0.5 * (1 + erf(x / Math.sqrt(2))); }

function bsRef(type, S, K, dte, ivPct, r) {
    const t = dte / 365, v = ivPct / 100;
    const d1 = (Math.log(S / K) + (r + v * v / 2) * t) / (v * Math.sqrt(t));
    const d2 = d1 - v * Math.sqrt(t);
    const disc = Math.exp(-r * t);
    const price = type === 'CE'
        ? S * normCdf(d1) - K * disc * normCdf(d2)
        : K * disc * normCdf(-d2) - S * normCdf(-d1);
    const delta = type === 'CE' ? normCdf(d1) : normCdf(d1) - 1;
    return { price, delta, d1, d2 };
}

// --- Benchmark case from the implementation plan --------------------------
// S=18000, K=18000, t=30/365, r=0.07, IV=15%
console.log('Benchmark: S=18000 K=18000 dte=30 IV=15% r=7%');
{
    const S = 18000, K = 18000, dte = 30, iv = 15, r = 0.07;
    const ce = OptionMath.calculateOption('CE', S, K, dte, iv, r);
    const pe = OptionMath.calculateOption('PE', S, K, dte, iv, r);
    const refCE = bsRef('CE', S, K, dte, iv, r);
    const refPE = bsRef('PE', S, K, dte, iv, r);

    approx('ATM call price matches reference', ce.price, refCE.price, 0.75);
    approx('ATM put price matches reference', pe.price, refPE.price, 0.75);
    approx('call delta matches reference', ce.delta, refCE.delta, 0.005);
    approx('put delta matches reference', pe.delta, refPE.delta, 0.005);

    // Put-call parity: C - P = S - K*e^{-rt}
    const parity = S - K * Math.exp(-r * (dte / 365));
    approx('put-call parity holds', ce.price - pe.price, parity, 0.75);

    // Gamma & Vega: equal for call and put, strictly positive
    approx('gamma equal for call and put', ce.gamma, pe.gamma, 1e-9);
    approx('vega equal for call and put', ce.vega, pe.vega, 1e-6);
    check('gamma positive', ce.gamma > 0);
    check('vega positive', ce.vega > 0);
    check('theta negative (long option decays)', ce.theta < 0 && pe.theta < 0);
}

// --- ITM / OTM sanity -----------------------------------------------------
console.log('ITM / OTM moneyness');
{
    const itm = OptionMath.calculateOption('CE', 18500, 18000, 30, 15, 0.07);
    const otm = OptionMath.calculateOption('CE', 17500, 18000, 30, 15, 0.07);
    check('ITM call worth more than OTM call', itm.price > otm.price);
    check('ITM call delta > 0.5', itm.delta > 0.5);
    check('OTM call delta < 0.5', otm.delta < 0.5);
    approx('ITM call ref', itm.price, bsRef('CE', 18500, 18000, 30, 15, 0.07).price, 1.0);
}

// --- Expiry (dte <= 0) settles to intrinsic -------------------------------
console.log('Expiry settlement');
{
    const ceIn = OptionMath.calculateOption('CE', 18500, 18000, 0, 15, 0.07);
    const peIn = OptionMath.calculateOption('PE', 17500, 18000, 0, 15, 0.07);
    approx('call intrinsic at expiry', ceIn.price, 500, 1e-9);
    approx('put intrinsic at expiry', peIn.price, 500, 1e-9);
    check('zero gamma/theta/vega at expiry', ceIn.gamma === 0 && ceIn.theta === 0 && ceIn.vega === 0);
}

// --- Higher IV raises premium ---------------------------------------------
console.log('Vega monotonicity');
{
    const lo = OptionMath.calculateOption('CE', 18000, 18000, 30, 12, 0.07);
    const hi = OptionMath.calculateOption('CE', 18000, 18000, 30, 25, 0.07);
    check('higher IV => higher premium', hi.price > lo.price);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
