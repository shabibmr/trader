import http.server
import socketserver
import urllib.request
import urllib.error
import http.cookiejar
import json
import gzip
import zlib
import os
import re
import random
import datetime


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


def decode_http_body(response):
    """
    Decompresses an HTTP response body honouring its Content-Encoding.
    Handles gzip and deflate (the encodings we actually advertise). Brotli is
    intentionally not advertised because the standard library cannot decode it.
    """
    raw = response.read()
    encoding = (response.info().get('Content-Encoding') or '').lower()
    if 'gzip' in encoding:
        return gzip.decompress(raw)
    if 'deflate' in encoding:
        try:
            return zlib.decompress(raw)
        except zlib.error:
            # Some servers send raw deflate without the zlib header
            return zlib.decompress(raw, -zlib.MAX_WBITS)
    return raw

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# Setup cookie jar and HTTP opener for browser spoofing
cj = http.cookiejar.CookieJar()
cookie_processor = urllib.request.HTTPCookieProcessor(cj)
opener = urllib.request.build_opener(cookie_processor)
opener.addheaders = [
    ('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
    ('Accept-Language', 'en-US,en;q=0.9'),
    ('Accept-Encoding', 'gzip, deflate'),
    ('Accept', 'application/json, text/plain, */*'),
    ('Referer', 'https://www.nseindia.com/option-chain'),
    ('Connection', 'keep-alive')
]

# Install the opener globally
urllib.request.install_opener(opener)

def fetch_live_nse_option_chain(symbol):
    """
    Fetches the live option chain from NSE using browser impersonation.
    Automatically falls back to a realistic mock dataset if blocked or offline.
    """
    symbol_upper = symbol.upper()
    is_index = symbol_upper in ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']
    
    base_api_url = "https://www.nseindia.com/api/option-chain-indices?symbol=" if is_index else "https://www.nseindia.com/api/option-chain-equities?symbol="
    url = f"{base_api_url}{symbol_upper}"
    
    try:
        # Step 1: Visit main NSE page to capture session cookies
        home_req = urllib.request.Request("https://www.nseindia.com/", headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        })
        with urllib.request.urlopen(home_req, timeout=5) as r:
            r.read() # just reading to register cookies
            
        # Step 2: Visit options page to establish cookie context
        opt_req = urllib.request.Request("https://www.nseindia.com/option-chain", headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        })
        with urllib.request.urlopen(opt_req, timeout=5) as r:
            r.read()
            
        # Step 3: Fetch Option Chain API
        api_req = urllib.request.Request(url)
        with urllib.request.urlopen(api_req, timeout=8) as response:
            data = decode_http_body(response)
            chain = json.loads(data.decode('utf-8'))
            chain['dataSource'] = 'live'
            return chain

    except Exception as e:
        print(f"[NSE BRIDGE] Failed to download from NSE ({e}). Using high-fidelity synthetic fallbacks.")
        return generate_mock_option_chain(symbol_upper)

def generate_mock_option_chain(symbol):
    """
    Generates a high-quality mock option chain that resembles NSE API structure
    exactly, allowing client-side JS to parse it identically.
    """
    spot = {
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
    step = 50 if symbol == 'NIFTY' else (100 if symbol == 'BANKNIFTY' else (20 if symbol == 'FINNIFTY' else 10))
    
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

    # Base params
    price = {
        'NIFTY': 17500.0,
        'BANKNIFTY': 39000.0,
        'FINNIFTY': 17000.0,
        'RELIANCE': 2200.0,
        'TCS': 3100.0,
        'INFY': 1200.0
    }.get(symbol, 1000.0)
    
    volatility = {
        'NIFTY': 0.010,
        'BANKNIFTY': 0.015,
        'FINNIFTY': 0.012,
        'RELIANCE': 0.015,
        'TCS': 0.013,
        'INFY': 0.018
    }.get(symbol, 0.015)
    
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

class CustomAPIHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Allow CORS
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
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
            data = generate_historical_underlying(symbol)
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
