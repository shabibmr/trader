import http.server
import socketserver
import urllib.parse
import json
import os
import re
import time
import random
import datetime
import math

import requests

# jugaad-data pulls real NSE daily OHLC for stocks (stock_df) and indices
# (index_df). Imported defensively so the server still boots — and the backtest
# silently falls back to the synthetic generator — if the package isn't installed.
try:
    from jugaad_data.nse import stock_df, index_df
    JUGAAD_AVAILABLE = True
except Exception:
    JUGAAD_AVAILABLE = False


def stable_seed(symbol):
    """
    Deterministic integer seed derived from the symbol string.
    Python's built-in hash() is randomized per process (PYTHONHASHSEED), which
    would make the synthetic history change on every server restart. This keeps
    a given symbol's generated price path identical across restarts.
    """
    seed = 0
    for ch in symbol.upper():
        seed = (seed * 31 + ord(ch)) & 0xFFFFFFFF
    return seed


PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


def load_symbol_universe():
    """
    Loads symbols.json — the single source of truth for the NSE F&O universe
    shared with the frontend. Returns a dict keyed by uppercase symbol with
    spot / step / vol metadata used to seed the synthetic fallbacks. Returns an
    empty dict if the file is missing, in which case the hardcoded defaults
    below take over.
    """
    path = os.path.join(DIRECTORY, 'symbols.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return {s['symbol'].upper(): s for s in json.load(f)}
    except (OSError, ValueError) as e:
        print(f"[SERVER] Could not load symbols.json ({e}); using built-in defaults.")
        return {}


SYMBOLS = load_symbol_universe()

# Historical-data bridge (jugaad-data). index_df needs niftyindices.com index
# names, which differ from our tickers (and from the display names in
# symbols.json, e.g. "BANK NIFTY" there vs "NIFTY BANK" at NSE). This map is the
# single place to fix any name mismatch found at runtime.
NSE_INDEX_NAMES = {
    'NIFTY': 'NIFTY 50',
    'BANKNIFTY': 'NIFTY BANK',
    'FINNIFTY': 'NIFTY FINANCIAL SERVICES',
    'MIDCPNIFTY': 'NIFTY MIDCAP SELECT',
    'NIFTYNXT50': 'NIFTY NEXT 50',
}
_HIST_CACHE = {}            # symbol -> (epoch_fetched, data_list)
HIST_CACHE_TTL = 6 * 3600  # re-fetch at most every 6h; avoids a network hit per backtest
HIST_YEARS = 2             # match the existing 2-year synthetic window

# NSE bridge configuration.
# NSE sits behind Akamai bot protection that resets bare urllib connections, and
# in mid-2024 it moved the option-chain API: the old single-shot
# /api/option-chain-indices now 404s. The working path is a requests.Session
# (which negotiates cookies + Brotli) that warms up two browser pages, reads the
# expiry list from /api/option-chain-contract-info, then pulls the chain one
# expiry at a time from /api/option-chain-v3 and merges the results.
NSE_BASE = "https://www.nseindia.com"
NSE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.nseindia.com/option-chain',
    'Connection': 'keep-alive',
}
# v3 returns one expiry per request; cap how many near-term expiries we pull so
# a chain refresh stays a few seconds, not dozens of round-trips.
MAX_LIVE_EXPIRIES = 3

def fetch_live_nse_option_chain(symbol):
    """
    Fetches the live option chain from NSE via a browser-like requests.Session.
    Warms up cookies, reads the expiry list, then pulls the first few expiries
    from the v3 endpoint and merges them into the legacy
    {records: {data, expiryDates, underlyingValue, timestamp}} shape the
    frontend expects. Falls back to a realistic synthetic dataset on any error.
    """
    symbol_upper = symbol.upper()
    meta = SYMBOLS.get(symbol_upper)
    if meta:
        is_index = meta.get('type') == 'index'
    else:
        is_index = symbol_upper in ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50']
    chain_type = 'Indices' if is_index else 'Equity'

    try:
        session = requests.Session()
        session.headers.update(NSE_HEADERS)

        # Warm-up: these set the Akamai session cookies. The homepage may answer
        # 403, but the option-chain page returns 200 and registers the cookies.
        session.get(NSE_BASE + "/", timeout=6)
        session.get(NSE_BASE + "/option-chain", timeout=6)

        # 1) Expiry list (and strikes) for this symbol.
        ci = session.get(f"{NSE_BASE}/api/option-chain-contract-info?symbol={symbol_upper}", timeout=8)
        ci.raise_for_status()
        expiries = ci.json().get('expiryDates', []) or []
        if not expiries:
            raise ValueError("contract-info returned no expiry dates")
        expiries = expiries[:MAX_LIVE_EXPIRIES]

        # 2) Pull each expiry's chain via v3 and merge the per-strike rows.
        merged = []
        underlying = None
        timestamp = None
        for exp in expiries:
            url = (f"{NSE_BASE}/api/option-chain-v3"
                   f"?type={chain_type}&symbol={symbol_upper}&expiry={urllib.parse.quote(exp)}")
            r = session.get(url, timeout=8)
            r.raise_for_status()
            rec = r.json().get('records', {}) or {}
            if underlying is None:
                underlying = rec.get('underlyingValue')
                timestamp = rec.get('timestamp')
            merged.extend(rec.get('data', []) or [])
            time.sleep(0.3)  # be gentle; avoid tripping rate limits

        if not merged or underlying is None:
            raise ValueError("v3 returned an empty chain")

        return {
            'dataSource': 'live',
            'records': {
                'data': merged,
                'expiryDates': expiries,
                'underlyingValue': underlying,
                'timestamp': timestamp or datetime.datetime.now().strftime("%d-%b-%Y %H:%M:%S"),
            }
        }

    except Exception as e:
        print(f"[NSE BRIDGE] Live fetch failed ({type(e).__name__}: {e}). Using synthetic fallback.")
        return generate_mock_option_chain(symbol_upper)

def generate_mock_option_chain(symbol):
    """
    Generates a high-quality mock option chain that resembles NSE API structure
    exactly, allowing client-side JS to parse it identically.
    """
    meta = SYMBOLS.get(symbol.upper())
    spot = meta['spot'] if meta else {
        'NIFTY': 22500.0,
        'BANKNIFTY': 48500.0,
        'FINNIFTY': 21500.0,
        'RELIANCE': 2950.0,
        'TCS': 3850.0,
        'INFY': 1450.0
    }.get(symbol, 1000.0)

    # Expirations (weekly / monthly Thursdays)
    expirations = []
    current_date = datetime.date.today()
    
    # Find next 3 Thursdays
    days_ahead = 0
    while len(expirations) < 3:
        target = current_date + datetime.timedelta(days=days_ahead)
        if target.weekday() == 3: # Thursday
            expirations.append(target.strftime("%d-%b-%Y"))
        days_ahead += 1
        
    strikes = []
    step = meta['step'] if meta else (50 if symbol == 'NIFTY' else (100 if symbol == 'BANKNIFTY' else (20 if symbol == 'FINNIFTY' else 10)))
    
    # 20 strikes around the spot
    rounded_spot = round(spot / step) * step
    for i in range(-15, 16):
        strikes.append(rounded_spot + (i * step))
        
    records = []
    for exp in expirations:
        for strike in strikes:
            # Distance from spot
            dist = (strike - spot) / spot
            
            # Simple option pricing model mock (Black-Scholes-like approximations)
            # Days to expiry
            exp_d = datetime.datetime.strptime(exp, "%d-%b-%Y").date()
            dte = max(1, (exp_d - current_date).days)
            t = dte / 365.0
            
            # CE Premium
            ce_val = max(0.5, spot * 0.08 * (max(0, 1 - dist * 8) * (dte ** 0.5) / 5.0) + max(0, spot - strike))
            # PE Premium
            pe_val = max(0.5, spot * 0.08 * (max(0, 1 + dist * 8) * (dte ** 0.5) / 5.0) + max(0, strike - spot))
            
            ce_iv = 12.5 + random.uniform(-1, 1) + (abs(dist) * 15)
            pe_iv = 13.0 + random.uniform(-1, 1) + (abs(dist) * 15)
            
            ce_oi = int(max(10, 50000 * (1 - abs(dist) * 4)))
            pe_oi = int(max(10, 50000 * (1 - abs(dist) * 4)))
            
            record = {
                'strikePrice': strike,
                'expiryDate': exp,
                'CE': {
                    'strikePrice': strike,
                    'expiryDate': exp,
                    'underlyingValue': spot,
                    'lastPrice': round(ce_val, 2),
                    'change': round(random.uniform(-10, 10), 2),
                    'pchange': round(random.uniform(-5, 5), 2),
                    'impliedVolatility': round(ce_iv, 2),
                    'openInterest': ce_oi,
                    'changeinOpenInterest': int(ce_oi * random.uniform(-0.1, 0.1)),
                    'totalBuyQuantity': int(ce_oi * 1.5),
                    'totalSellQuantity': int(ce_oi * 1.4),
                    'bidQty': 50,
                    'bidprice': round(ce_val - 0.1, 2),
                    'askQty': 50,
                    'askprice': round(ce_val + 0.1, 2)
                },
                'PE': {
                    'strikePrice': strike,
                    'expiryDate': exp,
                    'underlyingValue': spot,
                    'lastPrice': round(pe_val, 2),
                    'change': round(random.uniform(-10, 10), 2),
                    'pchange': round(random.uniform(-5, 5), 2),
                    'impliedVolatility': round(pe_iv, 2),
                    'openInterest': pe_oi,
                    'changeinOpenInterest': int(pe_oi * random.uniform(-0.1, 0.1)),
                    'totalBuyQuantity': int(pe_oi * 1.5),
                    'totalSellQuantity': int(pe_oi * 1.4),
                    'bidQty': 50,
                    'bidprice': round(pe_val - 0.1, 2),
                    'askQty': 50,
                    'askprice': round(pe_val + 0.1, 2)
                }
            }
            records.append(record)
            
    return {
        'dataSource': 'simulated',
        'records': {
            'data': records,
            'expiryDates': expirations,
            'underlyingValue': spot,
            'timestamp': datetime.datetime.now().strftime("%d-%b-%Y %H:%M:%S")
        }
    }

def generate_historical_underlying(symbol):
    """
    Generates a 2-year daily high-fidelity historical dataset (OHLCV)
    for NIFTY, BANKNIFTY, etc. with realistic trending and cyclical properties.
    """
    symbol = symbol.upper()
    # Deterministic seed so a symbol's path is identical across server restarts.
    random.seed(stable_seed(symbol))

    # Base params. The 2-year history walks back from today, so seed the start
    # price a notch below the symbol's current spot to leave room for the
    # positive long-term drift below.
    meta = SYMBOLS.get(symbol)
    price = (meta['spot'] * 0.78) if meta else {
        'NIFTY': 17500.0,
        'BANKNIFTY': 39000.0,
        'FINNIFTY': 17000.0,
        'RELIANCE': 2200.0,
        'TCS': 3100.0,
        'INFY': 1200.0
    }.get(symbol, 1000.0)

    volatility = (meta['vol'] if meta else {
        'NIFTY': 0.010,
        'BANKNIFTY': 0.015,
        'FINNIFTY': 0.012,
        'RELIANCE': 0.015,
        'TCS': 0.013,
        'INFY': 0.018
    }.get(symbol, 0.015))
    
    # Drift
    drift = 0.0003 # positive long-term drift

    # Synthetic implied-volatility path (annualized %). It mean-reverts to a
    # baseline derived from the daily vol and rises on down moves (leverage
    # effect / vol-of-vol), so the backtester sees IV actually change over time
    # instead of a frozen constant. This is what makes vega P&L meaningful.
    base_iv = max(8.0, volatility * (252 ** 0.5) * 100.0)
    iv = base_iv
    iv_mean_reversion = 0.05   # daily pull back toward baseline
    iv_leverage = 350.0        # IV bump per unit of negative daily return

    data = []
    current_date = datetime.date.today() - datetime.timedelta(days=730)

    for i in range(730):
        # Exclude weekends
        if current_date.weekday() >= 5:
            current_date += datetime.timedelta(days=1)
            continue

        # Random walk with cyclical trends
        cycle = 0.0005 * random.choice([-1, 1]) * (1 + 0.5 * random.uniform(-1, 1))
        shock = 0
        if random.random() < 0.02: # 2% chance of volatility shock / earnings jump
            shock = random.uniform(-0.04, 0.04)

        pct_change = random.normalvariate(drift + cycle, volatility) + shock

        open_price = price * (1 + random.uniform(-0.003, 0.003))
        close_price = price * (1 + pct_change)

        high_price = max(open_price, close_price) * (1 + abs(random.normalvariate(0, 0.005)))
        low_price = min(open_price, close_price) * (1 - abs(random.normalvariate(0, 0.005)))

        volume = int(random.uniform(500000, 2500000) if symbol in ['NIFTY', 'BANKNIFTY'] else random.uniform(50000, 500000))

        # Evolve IV: revert to baseline, spike when the market falls, add noise.
        iv += iv_mean_reversion * (base_iv - iv) - iv_leverage * pct_change + random.normalvariate(0, 0.6)
        iv = max(5.0, min(80.0, iv))

        data.append({
            'date': current_date.strftime("%Y-%m-%d"),
            'open': round(open_price, 2),
            'high': round(high_price, 2),
            'low': round(low_price, 2),
            'close': round(close_price, 2),
            'volume': volume,
            'iv': round(iv, 2)
        })

        price = close_price
        current_date += datetime.timedelta(days=1)

    return data


def realized_iv_path(closes, baseline_iv, window=20):
    """Trailing-window annualized realized volatility (%) used as a per-day IV
    proxy, since real OHLC carries no implied vol. Days before the window has
    filled fall back to the symbol's baseline IV so early backtest days still
    price. This keeps the simulator's dynamic-IV vega P&L meaningful on real data.
    """
    ivs, rets = [], []
    for i, c in enumerate(closes):
        if i > 0 and closes[i - 1] > 0:
            rets.append(math.log(c / closes[i - 1]))
        w = rets[-window:]
        if len(w) >= max(5, window // 2):
            mean = sum(w) / len(w)
            var = sum((x - mean) ** 2 for x in w) / (len(w) - 1)
            ivs.append(round(max(5.0, min(80.0, (var ** 0.5) * (252 ** 0.5) * 100.0)), 2))
        else:
            ivs.append(round(baseline_iv, 2))
    return ivs


def _records_from_rows(rows, meta):
    """Shared finalizer: takes rows pre-normalized to dicts with keys
    {date(str 'YYYY-MM-DD'), open, high, low, close, volume}, ascending by date,
    attaches a realized-vol IV proxy, and returns the standard array (or None if
    too short to backtest).
    """
    rows = [r for r in rows if r and r.get('close')]
    if len(rows) < 5:
        return None
    baseline_iv = max(8.0, (meta['vol'] if meta else 0.012) * (252 ** 0.5) * 100.0)
    closes = [float(r['close']) for r in rows]
    ivs = realized_iv_path(closes, baseline_iv)
    for i, r in enumerate(rows):
        r['iv'] = ivs[i]
    return rows


def _equity_history_jugaad(sym, from_d, to_d):
    """Real equity daily OHLCV via jugaad-data's stock_df (NSE historical API)."""
    df = stock_df(symbol=sym, from_date=from_d, to_date=to_d, series="EQ")
    if df is None or len(df) == 0:
        return []
    df = df.sort_values('DATE')
    rows = []
    for _, row in df.iterrows():
        d = row['DATE']
        rows.append({
            'date': d.strftime('%Y-%m-%d') if hasattr(d, 'strftime') else str(d)[:10],
            'open': round(float(row['OPEN']), 2),
            'high': round(float(row['HIGH']), 2),
            'low': round(float(row['LOW']), 2),
            'close': round(float(row['CLOSE']), 2),
            'volume': int(row['VOLUME']) if row.get('VOLUME') else 0,
        })
    return rows


def _index_history_jugaad(name, from_d, to_d):
    """Real index daily OHLC via jugaad-data's index_df (niftyindices.com).
    Works where niftyindices is reachable; raises otherwise."""
    df = index_df(symbol=name, from_date=from_d, to_date=to_d)
    if df is None or len(df) == 0:
        return []
    df = df.sort_values('HistoricalDate')
    rows = []
    for _, row in df.iterrows():
        d = row['HistoricalDate']
        rows.append({
            'date': d.strftime('%Y-%m-%d') if hasattr(d, 'strftime') else str(d)[:10],
            'open': round(float(row['OPEN']), 2),
            'high': round(float(row['HIGH']), 2),
            'low': round(float(row['LOW']), 2),
            'close': round(float(row['CLOSE']), 2),
            'volume': 0,
        })
    return rows


def _index_history_nse(name, from_d, to_d):
    """Real index daily OHLC straight from NSE's own indicesHistory API via a
    browser-like warmed session — the same bot-evasion pattern the live option
    chain uses. Chunked into <=180-day windows (NSE caps the per-request range)
    and merged. Used as a fallback when index_df / niftyindices is unreachable.
    """
    session = requests.Session()
    session.headers.update(NSE_HEADERS)
    session.get(NSE_BASE + "/", timeout=8)
    session.get(NSE_BASE + "/reports-indices-historical-index-data", timeout=8)
    session.headers['Referer'] = NSE_BASE + "/reports-indices-historical-index-data"

    merged = {}
    chunk_start = from_d
    while chunk_start <= to_d:
        chunk_end = min(chunk_start + datetime.timedelta(days=180), to_d)
        url = (f"{NSE_BASE}/api/historical/indicesHistory"
               f"?indexType={urllib.parse.quote(name)}"
               f"&from={chunk_start.strftime('%d-%m-%Y')}"
               f"&to={chunk_end.strftime('%d-%m-%Y')}")
        resp = session.get(url, timeout=12)
        recs = resp.json().get('data', {}).get('indexCloseOnlineRecords', [])
        for rec in recs:
            ts = rec.get('EOD_TIMESTAMP')          # e.g. "06-Jun-2026"
            if not ts:
                continue
            iso = datetime.datetime.strptime(ts, '%d-%b-%Y').strftime('%Y-%m-%d')
            merged[iso] = {
                'date': iso,
                'open': round(float(rec['EOD_OPEN_INDEX_VAL']), 2),
                'high': round(float(rec['EOD_HIGH_INDEX_VAL']), 2),
                'low': round(float(rec['EOD_LOW_INDEX_VAL']), 2),
                'close': round(float(rec['EOD_CLOSE_INDEX_VAL']), 2),
                'volume': 0,
            }
        chunk_start = chunk_end + datetime.timedelta(days=1)
        time.sleep(0.3)
    return [merged[k] for k in sorted(merged)]


def fetch_real_historical(symbol):
    """Downloads real NSE daily OHLC and normalizes it to the standard
    [{date, open, high, low, close, volume, iv}] array (ascending by date).
    Equities use jugaad-data's stock_df; indices try jugaad's index_df first,
    then fall back to NSE's own indicesHistory API. Returns None on any failure
    so the caller can fall back to synthetic data.
    """
    sym = symbol.upper()
    meta = SYMBOLS.get(sym)
    is_index = bool(meta and meta.get('type') == 'index')
    to_d = datetime.date.today()
    from_d = to_d - datetime.timedelta(days=HIST_YEARS * 365)

    if is_index:
        name = NSE_INDEX_NAMES.get(sym)
        if not name:
            return None
        if JUGAAD_AVAILABLE:
            try:
                rows = _index_history_jugaad(name, from_d, to_d)
                rec = _records_from_rows(rows, meta)
                if rec:
                    return rec
            except Exception as e:
                print(f"[SERVER] index_df failed for {sym} ({e}); trying NSE indicesHistory")
        try:
            rows = _index_history_nse(name, from_d, to_d)
            return _records_from_rows(rows, meta)
        except Exception as e:
            print(f"[SERVER] NSE indicesHistory failed for {sym}: {e}")
            return None

    if not JUGAAD_AVAILABLE:
        return None
    try:
        rows = _equity_history_jugaad(sym, from_d, to_d)
        return _records_from_rows(rows, meta)
    except Exception as e:
        print(f"[SERVER] stock_df failed for {sym}: {e}")
        return None


def get_historical_underlying(symbol):
    """Returns real NSE history when available (cached up to HIST_CACHE_TTL),
    otherwise the deterministic synthetic series. Same array shape either way, so
    the frontend is agnostic to the source.
    """
    sym = symbol.upper()
    cached = _HIST_CACHE.get(sym)
    if cached and (time.time() - cached[0]) < HIST_CACHE_TTL:
        return cached[1]
    real = fetch_real_historical(sym)
    if real:
        print(f"[SERVER] Historical: REAL NSE data for {sym} ({len(real)} rows)")
        _HIST_CACHE[sym] = (time.time(), real)
        return real
    print(f"[SERVER] Historical: falling back to SIMULATED data for {sym}")
    return generate_historical_underlying(sym)


class CustomAPIHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Allow CORS
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        # Never cache the static assets: during local dev a stale styles.css /
        # app.js silently masks edits (the browser keeps the old copy because
        # SimpleHTTPRequestHandler only sends Last-Modified).
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        # Route API queries
        if self.path.startswith('/api/fetch-options'):
            self.handle_fetch_options()
        elif self.path.startswith('/api/historical-underlying'):
            self.handle_historical_underlying()
        else:
            # Fall back to serving files
            super().do_GET()

    def handle_fetch_options(self):
        # Extract query parameters
        symbol = 'NIFTY'
        match = re.search(r'symbol=([^&]+)', self.path)
        if match:
            symbol = urllib.parse.unquote(match.group(1))
            
        print(f"[SERVER API] Fetching live option chain for: {symbol}")
        try:
            data = fetch_live_nse_option_chain(symbol)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode('utf-8'))
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))

    def handle_historical_underlying(self):
        symbol = 'NIFTY'
        match = re.search(r'symbol=([^&]+)', self.path)
        if match:
            symbol = urllib.parse.unquote(match.group(1))
            
        print(f"[SERVER API] Delivering historical daily data for underlying: {symbol}")
        try:
            data = get_historical_underlying(symbol)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode('utf-8'))
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))

def run_server():
    os.chdir(DIRECTORY)
    # Ensure port is not locked
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), CustomAPIHTTPRequestHandler) as httpd:
        print(f"\n[algoOptions Server] Server is running successfully at http://localhost:{PORT}")
        print("[algoOptions Server] Press Ctrl+C in terminal to stop server.\n")
        httpd.serve_forever()

if __name__ == '__main__':
    run_server()
