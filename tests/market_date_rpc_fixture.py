"""TEST ONLY: real RPC/collector with Yahoo IO replaced by deterministic bytes.

Launched only by tests/ui/asset-dates-e2e.test.js; never a product backend or live evidence.
All HTTP calls are intercepted here. Prices are invented, not market data.
"""

import json
import sys
from io import BytesIO
from urllib.parse import parse_qs, urlparse

from itt import market, rpc


class Reply(BytesIO):
    status = 200


def fixture_http(request, timeout):
    url = urlparse(request.full_url)
    symbol = url.path.rsplit("/", 1)[-1]
    if url.netloc != "query1.finance.yahoo.com" or symbol not in {"SPY", "MSFT"}:
        raise ValueError("TEST ONLY: unexpected request")
    query = parse_qs(url.query)
    if set(query) != {"period1", "period2", "interval", "events"} or timeout != 30:
        raise ValueError("TEST ONLY: explicit dated request required")
    # Include overhang before/after the requested window to exercise filtering.
    timestamps = [1704205800, 1704292200, 1704378600, 1704465000]
    payload = {"chart": {"error": None, "result": [{
        "meta": {"symbol": symbol, "currency": "USD", "exchangeName": "TEST",
                 "exchangeTimezoneName": "UTC"},
        "timestamp": timestamps,
        "indicators": {"quote": [{
            "open": [100, 101, 102, 103], "high": [100, 101, 102, 103],
            "low": [100, 101, 102, 103], "close": [100, 101, 102, 103],
            "volume": [1000, None if symbol == "MSFT" else 1000, 1000, 1000],
        }]},
    }]}}
    return Reply(json.dumps(payload).encode())


if __name__ == "__main__":
    market.urllib.request.urlopen = fixture_http
    raise SystemExit(rpc.serve(sys.stdin.buffer, sys.stdout))