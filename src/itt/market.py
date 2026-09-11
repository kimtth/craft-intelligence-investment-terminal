"""Yahoo chart snapshots for local research, never synthetic engine datasets.

Only fetch_market performs network IO. load_market revalidates archived bytes;
hashes detect damage, not origin authenticity or an external audit. A current
archive cannot establish historical availability or a survivorship-free universe.
The archive contains raw-SYMBOL.json and manifest.json; latest.json is published
atomically only after every symbol validates and every archive file is written.
Failed writes can leave an unpublished archive or pointer temporary, but never
replace the last good pointer. Files are exclusive through this API, not
OS-protected or signed; concurrent hostile path replacement is not sandboxed.
"""

import json
import os
import re
import stat
import urllib.request
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, localcontext
from hashlib import sha256
from http.client import HTTPException
from pathlib import Path
from urllib.parse import urlencode
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from itt.indicators import technicals
from itt.signals import signals

_SYMBOL = re.compile(r"[A-Z][A-Z0-9.-]{0,9}")
_HASH = re.compile(r"[0-9a-f]{64}")
_FIELDS = ("open", "high", "low", "close", "volume")
_ERRORS = (
    OSError, ValueError, TypeError, KeyError, IndexError, ArithmeticError,
    HTTPException, RecursionError,
)
_PRICE_BASIS = "provider chart close (not total return; split adjustment possible)"


def _symbols(value: list[str]) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= 10:
        raise ValueError("invalid symbols")
    if any(not isinstance(s, str) or not _SYMBOL.fullmatch(s) for s in value):
        raise ValueError("invalid symbols")
    if len(set(value)) != len(value):
        raise ValueError("duplicate symbols")
    return list(value)


def request_bounds(start: str | None = None, end: str | None = None) -> dict | None:
    """Strict inclusive calendar dates; omitted pair retains the legacy 1y request."""
    if start is None and end is None:
        return None
    for value in (start, end):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
            raise ValueError("start and end require YYYY-MM-DD")
        date.fromisoformat(value)
    if start > end or end == "9999-12-31":
        raise ValueError("invalid inclusive date range")
    return {"start": start, "end": end, "inclusive": True, "interval": "1d"}


def _url(symbol: str, bounds: dict | None = None) -> str:
    window = {"range": "1y"}
    if bounds is not None:
        # Yahoo period2 is exclusive. UTC arithmetic is independent of host DST.
        epoch = datetime(1970, 1, 1, tzinfo=UTC)
        first = datetime.fromisoformat(bounds["start"]).replace(tzinfo=UTC)
        stop = datetime.fromisoformat(bounds["end"]).replace(tzinfo=UTC) + timedelta(days=1)
        window = {"period1": int((first - epoch).total_seconds()),
                  "period2": int((stop - epoch).total_seconds())}
    query = urlencode({**window, "interval": "1d", "events": "div,splits"})
    return f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?{query}"


def _finite(value: str) -> Decimal:
    number = Decimal(value)
    if not number.is_finite():
        raise ValueError("non-finite number")
    return number


def _pairs(items: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _decode(raw: bytes) -> dict:
    value = json.loads(
        raw.decode("utf-8"), parse_float=_finite, parse_int=_finite,
        parse_constant=_finite, object_pairs_hook=_pairs,
    )
    if not isinstance(value, dict):
        raise ValueError("expected JSON object")
    return value


def _encode(value: dict) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False,
    ).encode("ascii")


def _number(value: object, *, integer: bool = False, positive: bool = False) -> Decimal:
    if not isinstance(value, Decimal) or not value.is_finite():
        raise ValueError("expected finite JSON number")
    if value < 0 or (positive and value == 0):
        raise ValueError("invalid number range")
    if integer and value != value.to_integral_value():
        raise ValueError("expected integer")
    return value


def _strings(value: object) -> object:
    """Preserve event structure while making its JSON numbers Decimal strings."""
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {key: _strings(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_strings(item) for item in value]
    return value


def _text(value: object) -> str:
    if not isinstance(value, str) or not value or any(ord(c) < 32 for c in value):
        raise ValueError("invalid metadata text")
    return value


def _normalize(symbol: str, raw: bytes, bounds: dict | None = None) -> dict:
    chart = _decode(raw)["chart"]
    if not isinstance(chart, dict) or chart.get("error") is not None:
        raise ValueError("provider error")
    results = chart["result"]
    if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict):
        raise ValueError("invalid chart result")
    result = results[0]
    meta = result["meta"]
    if not isinstance(meta, dict) or meta.get("symbol") != symbol or meta.get("currency") != "USD":
        raise ValueError("symbol or currency mismatch")
    exchange = _text(meta["exchangeName"])
    timezone = _text(meta["exchangeTimezoneName"])
    try:
        zone = ZoneInfo(timezone)
        date_basis = "exchange_timezone"
    except ZoneInfoNotFoundError:
        # Windows may lack tzdata. Never call this an exchange-local date.
        zone = UTC
        date_basis = "UTC_fallback_exchange_timezone_unavailable"

    timestamps = result["timestamp"]
    indicators = result["indicators"]
    if not isinstance(indicators, dict):
        raise ValueError("invalid indicators")
    quotes = indicators["quote"]
    if not isinstance(quotes, list) or len(quotes) != 1 or not isinstance(quotes[0], dict):
        raise ValueError("invalid quotes")
    quote = quotes[0]
    if not isinstance(timestamps, list) or not timestamps:
        raise ValueError("no timestamps")
    if any(not isinstance(quote[f], list) or len(quote[f]) != len(timestamps) for f in _FIELDS):
        raise ValueError("misaligned quotes")

    bars, skipped = [], []
    previous = -1
    for index, value in enumerate(timestamps):
        timestamp = int(_number(value, integer=True, positive=True))
        if timestamp <= previous:
            raise ValueError("timestamps must be unique and ascending")
        previous = timestamp
        date = datetime.fromtimestamp(timestamp, zone).date().isoformat()
        if bounds is not None and not bounds["start"] <= date <= bounds["end"]:
            continue  # Provider overhang is not part of the requested saved window.
        values = {field: quote[field][index] for field in _FIELDS}
        for field, number in values.items():
            if number is not None:
                _number(number, integer=field == "volume", positive=field != "volume")
        if any(number is None for number in values.values()):
            skipped.append(timestamp)
            continue
        if not (
            values["low"] <= min(values["open"], values["close"])
            <= max(values["open"], values["close"]) <= values["high"]
        ):
            raise ValueError("inconsistent OHLC")
        bars.append({
            "timestamp": timestamp, "date": date,
            **{field: str(number) for field, number in values.items()},
        })
    if not bars:
        raise ValueError("no usable bars")
    events = result.get("events", {})
    if not isinstance(events, dict):
        raise ValueError("invalid events")
    calculated = technicals(bars)
    return {
        "symbol": symbol, "currency": "USD", "exchange": exchange, "timezone": timezone,
        "date_basis": date_basis, "price_basis": _PRICE_BASIS,
        "latestbar_may_be_incomplete": True,
        "bars": bars, "events": _strings(events),
        "technicals": calculated, "signals": signals(calculated),
        "missing_bars": {
            "skipped_count": len(skipped), "skipped_timestamps": skipped,
            "reason": "null_ohlcv", "filled_count": 0, "calendar_gaps": "not_evaluated",
        },
    }


def _manifest(archive_id: str, collected_at: str, symbols: list[str], hashes: dict,
              bounds: dict | None = None) -> dict:
    return {
        "schema_version": "0.2" if bounds is not None else "0.1",
        **({"requested_bounds": bounds} if bounds is not None else {}),
        "id": archive_id, "kind": "real_market_snapshot",
        "provider": "Yahoo Finance", "collected_at": collected_at, "symbols": symbols,
        "request_urls": {symbol: _url(symbol, bounds) for symbol in symbols}, "raw_sha256": hashes,
        "current_archive_not_pit": True, "external_audit": False,
        "historical_universe_verified": False,
        "rights": {"use": "local_research", "public_redistribution": "not_verified"},
        "price_basis": _PRICE_BASIS, "latestbar_may_be_incomplete": True,
    }


def _snapshot(manifest: dict, symbols: list[dict]) -> dict:
    summary = []
    for item in symbols:
        first, last = item["bars"][0], item["bars"][-1]
        with localcontext() as context:
            context.prec = 28
            change = (Decimal(last["close"]) / Decimal(first["close"]) - 1) * 100
        summary.append({
            "symbol": item["symbol"], "first_date": first["date"], "last_date": last["date"],
            "first_price": first["close"], "last_price": last["close"],
            "pricechange_pct": str(change), "metric": "price_change_not_investment_return",
        })
    return {"manifest": manifest, "symbols": symbols, "summary": summary}


def _uuid(value: object) -> str:
    if not isinstance(value, str) or str(UUID(value)) != value or UUID(value).version != 4:
        raise ValueError("invalid archive identifier")
    return value


def _plain(path: Path, *, directory: bool = False) -> None:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("linked archive path")
    check = stat.S_ISDIR if directory else stat.S_ISREG
    if not check(info.st_mode):
        raise ValueError("invalid archive path")


def _root(root: Path, *, create: bool = False) -> Path:
    root = Path(root).absolute()
    for path in [*reversed(root.parents), root]:
        try:
            _plain(path, directory=True)
        except FileNotFoundError:
            if not create:
                raise
            path.mkdir()
    return root


def _read(path: Path) -> bytes:
    _plain(path)
    return path.read_bytes()


def _write(path: Path, raw: bytes) -> None:
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def fetch_market(symbols: list[str], root: Path = Path(".itt/market"), *,
                 start: str | None = None, end: str | None = None) -> dict:
    """Fetch inclusive dated / legacy 1y USD daily charts and archive raw bytes.

    Symbols are already-uppercase, unique, 1..10. No auth/cookies or synthetic
    fallback. Decimal OHLCV/event values are strings; timestamps/counts are ints.
    Network, input, provider, and storage failures have one fixed ValueError.
    """
    try:
        symbols = _symbols(symbols)
        bounds = request_bounds(start, end)
        payloads, normalized = {}, []
        for symbol in symbols:
            request = urllib.request.Request(
                _url(symbol, bounds), headers={"User-Agent": "IntelligentTradingTerminal/0.1"},
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status != 200:
                    raise ValueError("provider HTTP failure")
                raw = response.read()
            normalized.append(_normalize(symbol, raw, bounds))
            payloads[f"raw-{symbol}.json"] = raw
        archive_id = _uuid(str(uuid4()))
        manifest = _manifest(
            archive_id, datetime.now(UTC).isoformat().replace("+00:00", "Z"), symbols,
            {name: sha256(raw).hexdigest() for name, raw in payloads.items()},
            bounds,
        )
        snapshot = _snapshot(manifest, normalized)
        manifest_raw = _encode(manifest)
        root = _root(root, create=True)
        directory = root / archive_id
        directory.mkdir()  # Exclusive: a UUID collision must not overwrite anything.
        for name, raw in payloads.items():
            _write(directory / name, raw)
        _write(directory / "manifest.json", manifest_raw)
        pointer = root / f".latest-{archive_id}.tmp"
        _write(pointer, _encode({
            "id": archive_id, "manifest_sha256": sha256(manifest_raw).hexdigest(),
        }))
        os.replace(pointer, root / "latest.json")
        return snapshot
    except _ERRORS:
        raise ValueError("unable to fetch market data") from None


def load_market(root: Path = Path(".itt/market")) -> dict:
    """Read only latest.json; verify manifest/raw hashes and normalize raw again.

    No network, cached normalized data, folder scanning, or fallback to older
    archives. Required limitations/rights labels must exactly match this schema.
    UTC fallback dates are explicitly labeled and may differ from exchange dates.
    """
    try:
        root = _root(root)
        pointer = _decode(_read(root / "latest.json"))
        if set(pointer) != {"id", "manifest_sha256"}:
            raise ValueError("invalid pointer")
        archive_id = _uuid(pointer["id"])
        directory = root / archive_id
        _plain(directory, directory=True)
        manifest_raw = _read(directory / "manifest.json")
        if sha256(manifest_raw).hexdigest() != pointer["manifest_sha256"]:
            raise ValueError("manifest hash mismatch")
        manifest = _decode(manifest_raw)
        symbols = _symbols(manifest["symbols"])
        collected_at = _text(manifest["collected_at"])
        if (
            "T" not in collected_at
            or datetime.fromisoformat(collected_at).utcoffset() != timedelta(0)
        ):
            raise ValueError("invalid collection time")
        hashes = manifest["raw_sha256"]
        filenames = {f"raw-{symbol}.json" for symbol in symbols}
        if not isinstance(hashes, dict) or set(hashes) != filenames:
            raise ValueError("invalid raw inventory")
        if any(not isinstance(h, str) or not _HASH.fullmatch(h) for h in hashes.values()):
            raise ValueError("invalid raw hash")
        bounds = None
        if manifest.get("schema_version") == "0.2":
            requested = manifest["requested_bounds"]
            bounds = request_bounds(requested["start"], requested["end"])
            if bounds is None:
                raise ValueError("missing request bounds")
        expected = _manifest(archive_id, collected_at, symbols, hashes, bounds)
        if _encode(manifest) != _encode(expected):
            raise ValueError("missing or changed snapshot labels")
        if {p.name for p in directory.iterdir()} != filenames | {"manifest.json"}:
            raise ValueError("unexpected archive entries")
        payloads = {}
        for symbol in symbols:
            name = f"raw-{symbol}.json"
            raw = _read(directory / name)
            if sha256(raw).hexdigest() != hashes[name]:
                raise ValueError("raw hash mismatch")
            payloads[symbol] = raw
        return _snapshot(manifest, [_normalize(s, payloads[s], bounds) for s in symbols])
    except _ERRORS:
        raise ValueError("invalid market snapshot") from None