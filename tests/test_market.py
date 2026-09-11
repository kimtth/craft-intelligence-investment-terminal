"""Hand-authored mocked Yahoo-shaped responses, NOT actual-data integration tests."""

import json
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal, localcontext
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4
from zoneinfo import ZoneInfoNotFoundError

import pytest

from itt import market
from itt.signals import signals

_TECHNICAL_SERIES_KEYS = {
    *(f"{kind}{period}" for kind in ("sma", "ema") for period in (5, 10, 20, 50, 100, 200)),
    "stoch9_6", "stochrsi14", "macd12_26", "macd_signal9", "adx14",
    "plus_di14", "minus_di14", "williams_r14", "cci14", "atr14",
    "highs_lows14", "ultimate7_14_28", "roc12", "bull13", "bear13",
}


def assert_technical_schema(technicals, bar_count):
    assert set(technicals) == {
        "version", "basis", "sma20", "sma50", "rsi14", "series", "definitions",
    }
    assert isinstance(technicals["series"], dict)
    assert isinstance(technicals["definitions"], dict)
    assert set(technicals["series"]) == _TECHNICAL_SERIES_KEYS
    assert set(technicals["definitions"]) == _TECHNICAL_SERIES_KEYS
    for values in technicals["series"].values():
        assert isinstance(values, list) and len(values) == bar_count
        assert all(value is None or isinstance(value, str) for value in values)
    for definition in technicals["definitions"].values():
        assert isinstance(definition, str)
        formula, separator, disclaimer = definition.partition("; local formula, ")
        assert formula.strip() and separator
        assert disclaimer == "no Investing.com parity guaranteed"
    for name in ("sma20", "sma50"):
        assert technicals["series"][name] == technicals[name]


def response(symbol="SPY"):
    """Invented prices/dates for contract tests only; no market-data claim."""
    return {"chart": {"error": None, "result": [{
        "meta": {
            "symbol": symbol, "currency": "USD", "exchangeName": "PCX",
            "exchangeTimezoneName": "America/New_York",
        },
        "timestamp": [1704205800, 1704292200, 1704378600],
        "indicators": {"quote": [{
            "open": [100, 102, 110], "high": [102, 105, 112],
            "low": [99, 101, 109], "close": [100, 104, 110],
            "volume": [1000, 2000, 0],
        }], "adjclose": [{"adjclose": [50, 52, 55]}]},
        "events": {
            "dividends": {"1704292200": {"amount": 0.125, "date": 1704292200}},
            "splits": {"1704378600": {
                "date": 1704378600, "numerator": 2, "denominator": 1, "splitRatio": "2:1",
            }},
        },
    }]}}


def encode(value):
    return json.dumps(value, allow_nan=False).encode("utf-8")


def read(path):
    return json.loads(path.read_bytes())


def result(document):
    return document["chart"]["result"][0]


def quote(document):
    return result(document)["indicators"]["quote"][0]


class Reply(BytesIO):
    status = 200


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("test attempted unmocked network IO")

    monkeypatch.setattr(market.urllib.request, "urlopen", forbidden)
    # Deterministic unit tests even on Windows without the optional tzdata package.
    monkeypatch.setattr(market, "ZoneInfo", lambda name: UTC)


@pytest.fixture
def mock_http(monkeypatch):
    def install(payloads):
        calls = []

        def urlopen(request, timeout):
            calls.append((request, timeout))
            symbol = urlparse(request.full_url).path.rsplit("/", 1)[-1]
            payload = payloads[symbol]
            if isinstance(payload, Exception):
                raise payload
            return Reply(payload)

        monkeypatch.setattr(market.urllib.request, "urlopen", urlopen)
        return calls

    return install


@pytest.fixture
def saved(tmp_path, mock_http):
    root = tmp_path / "market"
    raw = encode(response())
    mock_http({"SPY": raw})
    snapshot = market.fetch_market(["SPY"], root)
    return root, snapshot, raw


def rewrite_manifest(root, mutate):
    """Also update unsigned pointer hash, to test semantic checks beyond hashes."""
    pointer = read(root / "latest.json")
    path = root / pointer["id"] / "manifest.json"
    manifest = read(path)
    mutate(manifest)
    raw = encode(manifest)
    path.write_bytes(raw)
    pointer["manifest_sha256"] = sha256(raw).hexdigest()
    (root / "latest.json").write_bytes(encode(pointer))


def test_fetch_request_archive_schema_and_offline_roundtrip(tmp_path, mock_http, monkeypatch):
    symbols = ["SPY", "QQQ", "BRK-B", "BRK.B"]
    payloads = {symbol: b" \n" + encode(response(symbol)) + b"\n" for symbol in symbols}
    calls = mock_http(payloads)
    root = tmp_path / "market"
    snapshot = market.fetch_market(symbols, root)
    assert set(snapshot) == {"manifest", "symbols", "summary"}
    manifest = snapshot["manifest"]
    assert str(UUID(manifest["id"])) == manifest["id"]
    assert manifest["schema_version"] == "0.1"
    assert manifest["kind"] == "real_market_snapshot"
    assert manifest["provider"] == "Yahoo Finance"
    assert manifest["symbols"] == symbols
    assert datetime.fromisoformat(manifest["collected_at"]).utcoffset() == timedelta(0)
    assert manifest["current_archive_not_pit"] is True
    assert manifest["external_audit"] is False
    assert manifest["historical_universe_verified"] is False
    assert manifest["rights"] == {
        "use": "local_research", "public_redistribution": "not_verified",
    }
    assert manifest["latestbar_may_be_incomplete"] is True
    assert manifest["price_basis"] == market._PRICE_BASIS
    directory = root / manifest["id"]
    assert {p.name for p in directory.iterdir()} == {
        "manifest.json", *(f"raw-{symbol}.json" for symbol in symbols),
    }
    for symbol, (request, timeout) in zip(symbols, calls, strict=True):
        parsed = urlparse(request.full_url)
        assert parsed.scheme == "https" and parsed.netloc == "query1.finance.yahoo.com"
        assert parsed.path == f"/v8/finance/chart/{symbol}"
        assert parse_qs(parsed.query) == {
            "range": ["1y"], "interval": ["1d"], "events": ["div,splits"],
        }
        assert set(k.lower() for k, _ in request.header_items()) == {"user-agent"}
        assert request.get_method() == "GET" and request.data is None and timeout == 30
        name = f"raw-{symbol}.json"
        assert (directory / name).read_bytes() == payloads[symbol]
        assert manifest["raw_sha256"][name] == sha256(payloads[symbol]).hexdigest()
        assert manifest["request_urls"][symbol] == request.full_url
    item = snapshot["symbols"][0]
    assert item["symbol"] == "SPY" and item["currency"] == "USD"
    assert item["exchange"] == "PCX" and item["timezone"] == "America/New_York"
    assert item["bars"][0] == {
        "timestamp": 1704205800, "date": "2024-01-02", "open": "100", "high": "102",
        "low": "99", "close": "100", "volume": "1000",
    }
    assert item["bars"][-1]["close"] == "110"  # Never substitute adjclose (55).
    assert item["latestbar_may_be_incomplete"] is True and len(item["bars"]) == 3
    assert_technical_schema(item["technicals"], len(item["bars"]))
    assert item["technicals"] == {
        "version": "1", "basis": "provider_close",
        "sma20": [None] * 3, "sma50": [None] * 3, "rsi14": [None] * 3,
        "series": {name: [None] * 3 for name in _TECHNICAL_SERIES_KEYS},
        "definitions": item["technicals"]["definitions"],
    }
    assert item["missing_bars"] == {
        "skipped_count": 0, "skipped_timestamps": [], "reason": "null_ohlcv",
        "filled_count": 0, "calendar_gaps": "not_evaluated",
    }
    assert item["events"]["dividends"]["1704292200"]["amount"] == "0.125"
    assert item["events"]["splits"]["1704378600"]["numerator"] == "2"
    assert snapshot["summary"][0] == {
        "symbol": "SPY", "first_date": "2024-01-02", "last_date": "2024-01-04",
        "first_price": "100", "last_price": "110", "pricechange_pct": "10.0",
        "metric": "price_change_not_investment_return",
    }
    monkeypatch.setattr(
        market.urllib.request, "urlopen", lambda *a, **kw: pytest.fail("load used network"),
    )
    assert market.load_market(root) == snapshot
    json.dumps(snapshot, allow_nan=False)


@pytest.mark.parametrize("entrypoint", ["service", "cli", "rpc"])
def test_explicit_bounds_end_inclusive_provenance_and_refresh(
    tmp_path, mock_http, monkeypatch, capsys, entrypoint,
):
    """Real entrypoint -> collector -> mocked Yahoo -> immutable files -> offline read."""
    from itt.cli import main
    from itt.rpc import RPCServer

    old_raw = encode(response())
    mock_http({"SPY": old_raw})
    old = market.fetch_market(["SPY"], tmp_path)
    old_files = {p: p.read_bytes() for p in (tmp_path / old["manifest"]["id"]).iterdir()}
    shorter = response("MSFT")
    quote(shorter)["volume"][1] = None
    calls = mock_http({"SPY": old_raw, "MSFT": encode(shorter)})
    params = {"start": "2024-01-03", "end": "2024-01-04"}
    if entrypoint == "service":
        snapshot = market.fetch_market(["SPY", "MSFT"], tmp_path, **params)
    elif entrypoint == "cli":
        assert main(["market", "fetch", "SPY", "MSFT", "--store", str(tmp_path),
                     "--start", params["start"], "--end", params["end"]]) == 0
        envelope = json.loads(capsys.readouterr().out)
        assert envelope["ok"] is True
        snapshot = envelope["result"]
    else:
        envelope = RPCServer().handle(json.dumps({"id": "dates-1", "method": "market.fetch",
            "params": {"symbols": ["SPY", "MSFT"], "store": str(tmp_path), **params}}).encode())
        assert envelope["id"] == "dates-1" and envelope["ok"] is True
        snapshot = envelope["result"]
    assert len(calls) == 2
    for request, _ in calls:
        assert parse_qs(urlparse(request.full_url).query) == {
            "period1": ["1704240000"], "period2": ["1704412800"],
            "interval": ["1d"], "events": ["div,splits"],
        }
    manifest = snapshot["manifest"]
    assert manifest["schema_version"] == "0.2"
    assert manifest["requested_bounds"] == {**params, "inclusive": True, "interval": "1d"}
    assert manifest["request_urls"] == {
        symbol: request.full_url
        for symbol, (request, _) in zip(["SPY", "MSFT"], calls, strict=True)
    }
    assert [b["date"] for b in snapshot["symbols"][0]["bars"]] == ["2024-01-03", "2024-01-04"]
    assert [b["date"] for b in snapshot["symbols"][1]["bars"]] == ["2024-01-04"]
    assert [row["first_date"] for row in snapshot["summary"]] == ["2024-01-03", "2024-01-04"]
    assert all(row["last_date"] == params["end"] for row in snapshot["summary"])
    assert all(len(item["technicals"]["sma20"]) == len(item["bars"])
               for item in snapshot["symbols"])
    assert (tmp_path / manifest["id"] / "raw-SPY.json").read_bytes() == old_raw
    assert old_files == {p: p.read_bytes() for p in old_files}
    monkeypatch.setattr(
        market.urllib.request, "urlopen", lambda *a, **kw: pytest.fail("refresh used network"),
    )
    before = {p: p.read_bytes() for p in tmp_path.rglob("*.json")}
    assert market.load_market(tmp_path) == snapshot
    assert before == {p: p.read_bytes() for p in tmp_path.rglob("*.json")}


@pytest.mark.parametrize("start,end", [
    ("2024-01-04", None), (None, "2024-01-04"), ("", "2024-01-04"),
    ("2024-01-05", "2024-01-04"), ("2023-02-29", "2024-01-04"),
    ("2024-1-01", "2024-01-04"), ("20240101", "2024-01-04"),
    ("0000-01-01", "2024-01-04"), ("2024-01-01", "9999-12-31"),
    ("max", "2024-01-04"), ("all", "2024-01-04"), (True, "2024-01-04"),
])
@pytest.mark.parametrize("entrypoint", ["service", "cli", "rpc"])
def test_invalid_download_ranges_before_network_or_storage(
    tmp_path, capsys, start, end, entrypoint,
):
    from itt.cli import main
    from itt.rpc import RPCServer

    if entrypoint == "service":
        with pytest.raises(ValueError, match="unable to fetch market data"):
            market.fetch_market(["SPY"], tmp_path, start=start, end=end)
    elif entrypoint == "cli":
        args = ["market", "fetch", "SPY", "--store", str(tmp_path)]
        if start is not None:
            args += ["--start", str(start)]
        if end is not None:
            args += ["--end", str(end)]
        assert main(args) == 2
        assert json.loads(capsys.readouterr().out)["ok"] is False
    else:
        reply = RPCServer().handle(json.dumps({"id": 1, "method": "market.fetch", "params": {
            "symbols": ["SPY"], "store": str(tmp_path), "start": start, "end": end}}).encode())
        assert reply["ok"] is False
    assert list(tmp_path.iterdir()) == []


def test_same_day_download_and_empty_window_preserve_latest(saved, mock_http):
    root, old, raw = saved
    mock_http({"SPY": raw})
    single = market.fetch_market(["SPY"], root, start="2024-01-04", end="2024-01-04")
    assert len(single["symbols"][0]["bars"]) == 1
    assert market.load_market(root) == single
    before = {p: p.read_bytes() for p in root.rglob("*.json")}
    with pytest.raises(ValueError):
        market.fetch_market(["SPY"], root, start="2024-01-06", end="2024-01-07")
    assert before == {p: p.read_bytes() for p in root.rglob("*.json")}
    assert (root / old["manifest"]["id"]).is_dir()


def test_leap_day_request_uses_next_day_exclusive_utc():
    bounds = market.request_bounds("2024-02-29", "2024-02-29")
    assert parse_qs(urlparse(market._url("SPY", bounds)).query) == {
        "period1": ["1709164800"], "period2": ["1709251200"],
        "interval": ["1d"], "events": ["div,splits"],
    }


@pytest.mark.parametrize("mutate", [
    lambda m: m["requested_bounds"].update(inclusive=False),
    lambda m: m["requested_bounds"].update(interval="1h"),
    lambda m: m["requested_bounds"].update(start="2024-01-05"),
    lambda m: m["requested_bounds"].update(end=None),
    lambda m: m["requested_bounds"].update(extra="ignored?"),
    lambda m: m.pop("requested_bounds"),
    lambda m: m.update(schema_version="0.1"),
    lambda m: m["request_urls"].update(SPY=market._url("SPY")),
])
def test_explicit_manifest_contract_and_urls_revalidated(tmp_path, mock_http, mutate):
    mock_http({"SPY": encode(response())})
    market.fetch_market(["SPY"], tmp_path, start="2024-01-03", end="2024-01-04")
    rewrite_manifest(tmp_path, mutate)
    with pytest.raises(ValueError, match="invalid market snapshot"):
        market.load_market(tmp_path)


@pytest.mark.parametrize("entrypoint", ["service", "cli"])
def test_full_archive_technicals_and_signals_fetch_show_parity_without_rewriting(
    tmp_path, mock_http, monkeypatch, capsys, entrypoint,
):
    from itt.cli import main

    payloads = {}
    for symbol in ["SPY", "QQQ"]:
        document = response(symbol)
        prices = list(range(1, 62)) if symbol == "SPY" else list(range(61, 0, -1))
        result(document)["timestamp"] = [1704205800 + i * 86400 for i in range(61)]
        result(document)["indicators"] = {
            "quote": [{**{field: prices[:] for field in ["open", "high", "low", "close"]},
                       "volume": [1000] * 61}],
            "adjclose": [{"adjclose": [1] * 61}],
        }
        # Drop an otherwise valid close because its volume is missing. Indicators
        # must use the normalized sequence, not raw positions or adjusted closes.
        quote(document)["volume"][10] = None
        payloads[symbol] = encode(document)
    calls = mock_http(payloads)
    if entrypoint == "cli":
        assert main(["market", "fetch", "SPY", "QQQ", "--store", str(tmp_path)]) == 0
        envelope = json.loads(capsys.readouterr().out)
        assert set(envelope) == {"ok", "result"}
        assert envelope["ok"] is True
        fetched = envelope["result"]
    else:
        fetched = market.fetch_market(["SPY", "QQQ"], tmp_path)
    assert len(calls) == 2
    before = {p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*.json")}
    directory = tmp_path / fetched["manifest"]["id"]
    assert {p.name for p in directory.iterdir()} == {
        "manifest.json", "raw-SPY.json", "raw-QQQ.json",
    }
    assert read(directory / "manifest.json") == fetched["manifest"]
    assert fetched["manifest"]["schema_version"] == "0.1"
    assert "technicals" not in fetched["manifest"]
    assert "signals" not in fetched["manifest"]
    for symbol in payloads:
        assert (directory / f"raw-{symbol}.json").read_bytes() == payloads[symbol]

    monkeypatch.setattr(
        market.urllib.request, "urlopen", lambda *a, **kw: pytest.fail("show used network"),
    )
    if entrypoint == "cli":
        assert main(["market", "show", "--store", str(tmp_path)]) == 0
        envelope = json.loads(capsys.readouterr().out)
        assert set(envelope) == {"ok", "result"}
        assert envelope["ok"] is True
        shown = envelope["result"]
    else:
        shown = market.load_market(tmp_path)
    assert shown == fetched
    assert before == {p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*.json")}
    for item, expected_rsi in zip(shown["symbols"], ["100", "0"], strict=True):
        assert len(item["bars"]) == 60
        assert item["missing_bars"]["skipped_count"] == 1
        technicals = item["technicals"]
        assert_technical_schema(technicals, len(item["bars"]))
        assert item["signals"] == signals(technicals)
        observations = item["signals"]["observations"]
        assert len(observations) == len(item["bars"])
        assert all(row["status"] == "Unavailable" for row in observations[:49])
        expected_status = "Buy" if expected_rsi == "100" else "Sell"
        assert all(row["status"] == expected_status for row in observations[49:])
        assert technicals["version"] == "1" and technicals["basis"] == "provider_close"
        for name, first in [("sma20", 19), ("sma50", 49), ("rsi14", 14)]:
            assert len(technicals[name]) == len(item["bars"])
            assert technicals[name][:first] == [None] * first
            assert all(isinstance(v, str) for v in technicals[name][first:])
        assert technicals["rsi14"][14:] == [expected_rsi] * 46
    spy = shown["symbols"][0]["technicals"]
    assert spy["sma20"][19] == "11"  # (21 * 22 / 2 - 11) / 20 = 220 / 20.
    assert spy["sma50"][49] == "26.3"  # (1..51 minus skipped 11) / 50.
    assert spy["sma20"][-1] == "51.5"
    assert spy["sma50"][-1] == "36.5"
    # A 21-bar view retains the earlier full-archive SMA50 history.
    assert all(v is not None for v in spy["sma50"][-11:])


def test_normalization_calculates_technicals_once_and_shares_them_with_signals(monkeypatch):
    original_technicals = market.technicals
    calculated = []
    consumed = []

    def calculate(bars):
        value = original_technicals(bars)
        calculated.append(value)
        return value

    def evaluate(value):
        consumed.append(value)
        return signals(value)

    monkeypatch.setattr(market, "technicals", calculate)
    monkeypatch.setattr(market, "signals", evaluate)
    item = market._normalize("SPY", encode(response()))
    assert len(calculated) == len(consumed) == 1
    assert calculated[0] is consumed[0] is item["technicals"]
    assert item["signals"] == signals(item["technicals"])
    assert "signals" not in item["technicals"]


@pytest.mark.parametrize("symbols", [
    [], ["SPY"] * 2, ["spy"], [" SPY"], ["SPY "], ["SPY\n"], ["1SPY"], ["^GSPC"],
    ["../SPY"], ["A/B"], ["A\\B"], ["A?x=1"], ["Ä"], ["ABCDEFGHIJK"], [None], [1],
    "SPY", ("SPY",), None, [f"A{i}" for i in range(11)],
])
def test_invalid_symbols_rejected_before_io(tmp_path, symbols):
    root = tmp_path / "absent"
    with pytest.raises(ValueError, match="^unable to fetch market data$"):
        market.fetch_market(symbols, root)
    assert not root.exists()


def test_ten_symbols_and_ten_character_symbol_allowed(tmp_path, mock_http):
    symbols = ["ABCDEFGHIJ", *(f"A{i}" for i in range(9))]
    mock_http({s: encode(response(s)) for s in symbols})
    assert len(market.fetch_market(symbols, tmp_path)["symbols"]) == 10


@pytest.mark.parametrize("field", ["open", "high", "low", "close", "volume"])
def test_null_bars_dropped_with_explicit_count_and_no_fill(tmp_path, mock_http, field):
    document = response()
    quote(document)[field][1] = None
    mock_http({"SPY": encode(document)})
    item = market.fetch_market(["SPY"], tmp_path)["symbols"][0]
    assert [b["timestamp"] for b in item["bars"]] == [1704205800, 1704378600]
    assert item["missing_bars"]["skipped_count"] == 1
    assert item["missing_bars"]["skipped_timestamps"] == [1704292200]
    assert item["missing_bars"]["filled_count"] == 0


def test_decimal_precision_is_not_routed_through_binary_float(tmp_path, mock_http):
    raw = encode(response()).replace(
        b'"close": [100, 104, 110]', b'"close": [100.000000000000000001, 104, 110]',
    )
    mock_http({"SPY": raw})
    snapshot = market.fetch_market(["SPY"], tmp_path)
    assert snapshot["symbols"][0]["bars"][0]["close"] == "100.000000000000000001"
    with localcontext() as context:
        context.prec = 28
        expected = (Decimal("110") / Decimal("100.000000000000000001") - 1) * 100
    assert snapshot["summary"][0]["pricechange_pct"] == str(expected)


def test_timezone_fallback_explicit_and_exchange_zone_used(tmp_path, mock_http, monkeypatch):
    document = response()
    # Just after UTC midnight, still the preceding date in New York.
    result(document)["timestamp"] = [1704155400, 1704241800, 1704328200]
    mock_http({"SPY": encode(document)})
    monkeypatch.setattr(market, "ZoneInfo", lambda name: timezone(timedelta(hours=-5)))
    local = market.fetch_market(["SPY"], tmp_path)["symbols"][0]
    assert local["date_basis"] == "exchange_timezone"
    assert local["bars"][0]["date"] == "2024-01-01"

    def unavailable(name):
        raise ZoneInfoNotFoundError(name)

    monkeypatch.setattr(market, "ZoneInfo", unavailable)
    fallback = market.fetch_market(["SPY"], tmp_path)["symbols"][0]
    assert fallback["date_basis"] == "UTC_fallback_exchange_timezone_unavailable"
    assert fallback["timezone"] == "America/New_York"
    assert fallback["bars"][0]["date"] == "2024-01-02"


@pytest.mark.parametrize("mutation", [
    lambda d: d["chart"].update(error={"description": "secret-sentinel"}),
    lambda d: d["chart"].update(result=[]),
    lambda d: d["chart"].update(result=None),
    lambda d: result(d)["meta"].update(symbol="QQQ"),
    lambda d: result(d)["meta"].update(currency="EUR"),
    lambda d: result(d)["meta"].pop("currency"),
    lambda d: result(d)["meta"].pop("exchangeTimezoneName"),
    lambda d: result(d)["meta"].update(exchangeName=""),
    lambda d: result(d).update(timestamp=[]),
    lambda d: result(d).update(timestamp=[1704205800] * 3),
    lambda d: result(d).update(timestamp=[1704378600, 1704292200, 1704205800]),
    lambda d: result(d)["timestamp"].__setitem__(0, None),
    lambda d: result(d)["timestamp"].__setitem__(0, 1.5),
    lambda d: result(d)["timestamp"].__setitem__(0, True),
    lambda d: result(d)["timestamp"].__setitem__(2, 10**100),
    lambda d: quote(d).update(close=[100]),
    lambda d: quote(d).pop("open"),
    lambda d: quote(d).update(close=[None, None, None]),
    lambda d: quote(d)["close"].__setitem__(0, -1),
    lambda d: quote(d)["close"].__setitem__(0, 0),
    lambda d: quote(d)["close"].__setitem__(0, "100"),
    lambda d: quote(d)["close"].__setitem__(0, True),
    lambda d: quote(d)["high"].__setitem__(0, 99),
    lambda d: quote(d)["low"].__setitem__(0, 101),
    lambda d: quote(d)["volume"].__setitem__(0, -1),
    lambda d: quote(d)["volume"].__setitem__(0, 1.5),
    lambda d: result(d).update(events=None),
])
def test_invalid_provider_data_fails_without_fake_fallback(tmp_path, mock_http, mutation):
    document = response()
    mutation(document)
    mock_http({"SPY": encode(document)})
    root = tmp_path / "absent"
    with pytest.raises(ValueError, match="^unable to fetch market data$") as caught:
        market.fetch_market(["SPY"], root)
    assert caught.value.__suppress_context__
    assert not root.exists()


@pytest.mark.parametrize("raw", [
    b"not JSON", b"\xff", b"null", b"[]", b"{}", b'{"chart":{},"chart":{}}',
    b'{"value":NaN}', b'{"value":Infinity}', b'{"value":-Infinity}',
])
def test_bad_raw_json_rejected(tmp_path, mock_http, raw):
    mock_http({"SPY": raw})
    with pytest.raises(ValueError, match="^unable to fetch market data$"):
        market.fetch_market(["SPY"], tmp_path)
    assert not (tmp_path / "latest.json").exists()


@pytest.mark.parametrize("number", [b"NaN", b"Infinity", b"-Infinity"])
def test_nonfinite_number_in_otherwise_valid_chart_rejected(tmp_path, mock_http, number):
    raw = encode(response()).replace(
        b'"close": [100, 104, 110]', b'"close": [' + number + b', 104, 110]',
    )
    mock_http({"SPY": raw})
    with pytest.raises(ValueError, match="^unable to fetch market data$"):
        market.fetch_market(["SPY"], tmp_path)


def test_absent_events_and_single_remaining_bar_are_explicit(tmp_path, mock_http):
    document = response()
    result(document).pop("events")
    quote(document)["close"] = [None, 104, None]
    mock_http({"SPY": encode(document)})
    snapshot = market.fetch_market(["SPY"], tmp_path)
    item = snapshot["symbols"][0]
    assert item["events"] == {}
    assert len(item["bars"]) == 1
    assert item["missing_bars"]["skipped_count"] == 2
    assert item["latestbar_may_be_incomplete"] is True
    assert Decimal(snapshot["summary"][0]["pricechange_pct"]) == 0


def test_duplicate_timestamp_in_null_bar_still_rejected(tmp_path, mock_http):
    document = response()
    result(document)["timestamp"][1] = result(document)["timestamp"][0]
    quote(document)["close"][1] = None
    mock_http({"SPY": encode(document)})
    with pytest.raises(ValueError, match="^unable to fetch market data$"):
        market.fetch_market(["SPY"], tmp_path)


@pytest.mark.parametrize("failure", [
    URLError("secret-sentinel"), TimeoutError("secret-sentinel"),
    HTTPError("https://example.invalid", 429, "secret-sentinel", {}, None),
])
def test_retrieval_failure_keeps_previous_pointer(saved, mock_http, failure):
    root, snapshot, raw = saved
    pointer = (root / "latest.json").read_bytes()
    mock_http({"SPY": raw, "QQQ": failure})
    with pytest.raises(ValueError, match="^unable to fetch market data$"):
        market.fetch_market(["SPY", "QQQ"], root)
    assert (root / "latest.json").read_bytes() == pointer
    assert market.load_market(root) == snapshot


def test_non_200_response_rejected(tmp_path, mock_http, monkeypatch):
    mock_http({"SPY": encode(response())})
    monkeypatch.setattr(Reply, "status", 503)
    with pytest.raises(ValueError, match="^unable to fetch market data$"):
        market.fetch_market(["SPY"], tmp_path)


def test_new_archive_exclusive_and_old_raw_untouched(saved, mock_http, monkeypatch):
    root, old, raw = saved
    mock_http({"SPY": raw})
    new = market.fetch_market(["SPY"], root)
    assert old["manifest"]["id"] != new["manifest"]["id"]
    assert market.load_market(root) == new
    old_path = root / old["manifest"]["id"]
    before = {p.name: p.read_bytes() for p in old_path.iterdir()}
    monkeypatch.setattr(market, "uuid4", lambda: UUID(old["manifest"]["id"]))
    with pytest.raises(ValueError, match="^unable to fetch market data$"):
        market.fetch_market(["SPY"], root)
    assert before == {p.name: p.read_bytes() for p in old_path.iterdir()}
    assert market.load_market(root) == new


@pytest.mark.parametrize("fail_at", ["raw-SPY.json", "manifest.json", "pointer", "replace"])
def test_storage_failure_does_not_publish_partial_snapshot(saved, monkeypatch, fail_at):
    root, old, _ = saved
    before = (root / "latest.json").read_bytes()
    write = market._write

    def fail_write(path, raw):
        if path.name == fail_at or (fail_at == "pointer" and path.suffix == ".tmp"):
            raise OSError("secret-sentinel")
        write(path, raw)

    def fail_replace(*args):
        raise OSError("secret-sentinel")

    monkeypatch.setattr(market, "_write", fail_write)
    if fail_at == "replace":
        monkeypatch.setattr(market.os, "replace", fail_replace)
    with pytest.raises(ValueError, match="^unable to fetch market data$"):
        market.fetch_market(["SPY"], root)
    assert (root / "latest.json").read_bytes() == before
    assert market.load_market(root) == old


def test_pointer_replaced_only_after_complete_archive(saved, monkeypatch):
    root, _, _ = saved
    previous = (root / "latest.json").read_bytes()
    replace = market.os.replace
    checked = []

    def inspect(source, destination):
        assert (root / "latest.json").read_bytes() == previous
        pointer = read(source)
        directory = root / pointer["id"]
        manifest_raw = (directory / "manifest.json").read_bytes()
        assert sha256(manifest_raw).hexdigest() == pointer["manifest_sha256"]
        for name, digest in read(directory / "manifest.json")["raw_sha256"].items():
            assert sha256((directory / name).read_bytes()).hexdigest() == digest
        checked.append(True)
        replace(source, destination)

    monkeypatch.setattr(market.os, "replace", inspect)
    new = market.fetch_market(["SPY"], root)
    assert checked == [True]
    assert market.load_market(root) == new


@pytest.mark.parametrize("name", ["latest.json", "manifest.json", "raw-SPY.json"])
@pytest.mark.parametrize("damage", ["tamper", "missing", "directory"])
def test_missing_tampered_or_nonfile_entries_rejected(saved, name, damage):
    root, snapshot, _ = saved
    path = root / name if name == "latest.json" else root / snapshot["manifest"]["id"] / name
    if damage == "tamper":
        path.write_bytes(b"secret-sentinel")
    else:
        path.unlink()
        if damage == "directory":
            path.mkdir()
    with pytest.raises(ValueError, match="^invalid market snapshot$"):
        market.load_market(root)


@pytest.mark.parametrize("key", [
    "kind", "provider", "current_archive_not_pit", "external_audit",
    "historical_universe_verified", "rights", "price_basis", "latestbar_may_be_incomplete",
    "request_urls", "collected_at", "raw_sha256", "schema_version", "id", "symbols",
])
def test_missing_labels_rejected_even_with_rehashed_manifest(saved, key):
    root, _, _ = saved
    rewrite_manifest(root, lambda m: m.pop(key))
    with pytest.raises(ValueError, match="^invalid market snapshot$"):
        market.load_market(root)


@pytest.mark.parametrize("change", [
    {"kind": "synthetic"}, {"external_audit": True}, {"external_audit": 0},
    {"current_archive_not_pit": False}, {"historical_universe_verified": True},
    {"rights": {"use": "public"}}, {"price_basis": "unadjusted"},
    {"latestbar_may_be_incomplete": False}, {"provider": "other"},
    {"request_urls": {"SPY": "https://example.invalid"}},
    {"collected_at": "2024-01-01T00:00:00"},
    {"collected_at": "2024-01-01T00:00:00+01:00"},
    {"raw_sha256": {"../outside.json": "a" * 64}},
    {"raw_sha256": {"raw-SPY.json": "bad"}},
    {"schema_version": "future"}, {"id": str(uuid4())}, {"unexpected": True},
])
def test_changed_manifest_semantics_rejected_after_rehash(saved, change):
    root, _, _ = saved
    rewrite_manifest(root, lambda m: m.update(change))
    with pytest.raises(ValueError, match="^invalid market snapshot$"):
        market.load_market(root)


def test_load_normalizes_raw_again_and_rejects_rehashed_invalid_prices(saved):
    root, snapshot, _ = saved
    document = response()
    quote(document)["close"][0] = 1000  # Outside the high/low range.
    raw = encode(document)
    (root / snapshot["manifest"]["id"] / "raw-SPY.json").write_bytes(raw)
    rewrite_manifest(root, lambda m: m["raw_sha256"].update({
        "raw-SPY.json": sha256(raw).hexdigest(),
    }))
    with pytest.raises(ValueError, match="^invalid market snapshot$"):
        market.load_market(root)


def test_unsigned_hashes_do_not_authenticate_source(saved):
    root, snapshot, _ = saved
    document = response()
    quote(document)["close"][-1] = 111  # Valid edit plus both unsigned hashes.
    raw = encode(document)
    (root / snapshot["manifest"]["id"] / "raw-SPY.json").write_bytes(raw)
    rewrite_manifest(root, lambda m: m["raw_sha256"].update({
        "raw-SPY.json": sha256(raw).hexdigest(),
    }))
    loaded = market.load_market(root)
    assert loaded["symbols"][0]["bars"][-1]["close"] == "111"
    assert loaded["manifest"]["external_audit"] is False


@pytest.mark.parametrize("archive_id", [
    "../outside", "..\\outside", "/outside", "C:\\outside", "", "x" * 36, None, 1,
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "a" * 32,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/..",
])
def test_latest_id_validated_before_directory_access(tmp_path, monkeypatch, archive_id):
    (tmp_path / "latest.json").write_bytes(encode({
        "id": archive_id, "manifest_sha256": "0" * 64,
    }))
    original = market._read
    reads = []

    def inspect(path):
        reads.append(path)
        return original(path)

    monkeypatch.setattr(market, "_read", inspect)
    with pytest.raises(ValueError, match="^invalid market snapshot$"):
        market.load_market(tmp_path)
    assert reads == [tmp_path / "latest.json"]


def test_load_does_not_create_or_scan_for_alternate_archives(tmp_path, saved):
    absent = tmp_path / "absent"
    with pytest.raises(ValueError, match="^invalid market snapshot$"):
        market.load_market(absent)
    assert not absent.exists()
    root, _, _ = saved
    (root / "latest.json").unlink()
    with pytest.raises(ValueError, match="^invalid market snapshot$"):
        market.load_market(root)


def test_extra_normalized_file_not_trusted(saved):
    root, snapshot, _ = saved
    (root / snapshot["manifest"]["id"] / "snapshot.json").write_bytes(b"{}")
    with pytest.raises(ValueError, match="^invalid market snapshot$"):
        market.load_market(root)


def test_writer_uses_exclusive_creation(tmp_path):
    path = tmp_path / "raw-SPY.json"
    path.write_bytes(b"original")
    with pytest.raises(FileExistsError):
        market._write(path, b"replacement")
    assert path.read_bytes() == b"original"


def test_default_root_is_local_market_path():
    assert market.fetch_market.__defaults__ == (Path(".itt/market"),)
    assert market.load_market.__defaults__ == (Path(".itt/market"),)