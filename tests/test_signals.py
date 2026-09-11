"""Contract tests for deterministic display votes, not strategy profitability."""

from copy import deepcopy
from decimal import ROUND_UP, Decimal, Inexact, InvalidOperation, localcontext
from itertools import product

import pytest

from itt.indicators import technicals
from itt.signals import signals

STATUSES = ("Buy", "Sell", "Neutral", "Unavailable")
KEYS = ("sma20", "sma50", "macd12_26", "macd_signal9", "rsi14")


def inputs(trend="Neutral", macd="Neutral", rsi="Neutral"):
    pairs = {
        "Buy": ("2.00", "1.0"), "Sell": ("1.0", "2.00"),
        "Neutral": ("1.00", "1.0"), "Unavailable": (None, "1.0"),
    }
    fast, slow = pairs[trend]
    line, signal = pairs[macd]
    return {
        "version": "1", "basis": "provider_close",
        "sma20": [fast], "sma50": [slow],
        "rsi14": [{"Buy": "56", "Sell": "44", "Neutral": "50", "Unavailable": None}[rsi]],
        "series": {"macd12_26": [line], "macd_signal9": [signal]},
        "definitions": {},
    }


def column(data, key):
    return data["series"][key] if key.startswith("macd") else data[key]


@pytest.mark.parametrize("votes", list(product(STATUSES, repeat=3)))
def test_all_vote_combinations_counts_status_and_exact_reasons(votes):
    data = inputs(*votes)
    before = deepcopy(data)
    output = signals(data)
    assert data == before
    assert set(output) == {"version", "basis", "rule", "observations"}
    assert output["version"] == "technical-vote-v1"
    assert output["basis"] == "provider_close"
    assert isinstance(output["rule"], str) and output["rule"]
    assert len(output["observations"]) == 1
    row = output["observations"][0]
    assert set(row) == {"status", "counts", "reasons"}
    assert row["counts"] == {status: votes.count(status) for status in STATUSES}
    assert all(type(count) is int for count in row["counts"].values())
    assert sum(row["counts"].values()) == 3
    if "Unavailable" in votes:
        expected = "Unavailable"
    elif votes.count("Buy") >= 2:
        expected = "Buy"
    elif votes.count("Sell") >= 2:
        expected = "Sell"
    else:
        expected = "Neutral"
    assert row["status"] == expected
    assert [reason["status"] for reason in row["reasons"]] == list(votes)
    assert [reason["id"] for reason in row["reasons"]] == ["trend", "macd", "rsi"]
    for reason, keys in zip(row["reasons"], [KEYS[:2], KEYS[2:4], KEYS[4:]], strict=True):
        assert set(reason) == {"id", "label", "status", "values", "rule", "explanation"}
        assert reason["values"] == {key: column(data, key)[0] for key in keys}
        for field in ("label", "rule", "explanation"):
            assert isinstance(reason[field], str) and reason[field].strip()


@pytest.mark.parametrize("value,status", [
    ("45", "Neutral"), ("55", "Neutral"), ("45.000", "Neutral"),
    ("55.000", "Neutral"), ("50", "Neutral"),
    ("44.9999999999999999999999999999999999999", "Sell"),
    ("45.0000000000000000000000000000000000001", "Neutral"),
    ("54.9999999999999999999999999999999999999", "Neutral"),
    ("55.0000000000000000000000000000000000001", "Buy"),
])
def test_rsi_inclusive_boundaries_without_float_rounding(value, status):
    data = inputs()
    data["rsi14"] = [value]
    reason = signals(data)["observations"][0]["reasons"][2]
    assert reason["status"] == status
    assert reason["values"] == {"rsi14": value}


@pytest.mark.parametrize("keys,index", [(KEYS[:2], 0), (KEYS[2:4], 1)])
@pytest.mark.parametrize("left,right,status", [
    ("1.0000000000000000000000000000000000001", "1", "Buy"),
    ("1", "1.0000000000000000000000000000000000001", "Sell"),
    ("1.0000", "1E+0", "Neutral"), ("-0.000", "0", "Neutral"),
    ("-1.0000000000000000000000000000000000001", "-1", "Sell"),
    ("1E-1000", "0", "Buy"),
])
def test_comparison_uses_all_decimal_digits_and_preserves_strings(keys, index, left, right, status):
    data = inputs()
    column(data, keys[0])[0] = left
    column(data, keys[1])[0] = right
    reason = signals(data)["observations"][0]["reasons"][index]
    assert reason["status"] == status
    assert reason["values"] == dict(zip(keys, (left, right), strict=True))


@pytest.mark.parametrize("missing", [keys for size in range(1, 6)
                                    for keys in product((False, True), repeat=5)
                                    if sum(keys) == size])
def test_every_required_null_pattern_is_unavailable_not_neutral(missing):
    data = inputs("Buy", "Buy", "Buy")
    for key, is_null in zip(KEYS, missing, strict=True):
        if is_null:
            column(data, key)[0] = None
    row = signals(data)["observations"][0]
    unavailable = sum((any(missing[:2]), any(missing[2:4]), missing[4]))
    assert row["status"] == "Unavailable"
    assert row["counts"] == {
        "Buy": 3 - unavailable, "Sell": 0, "Neutral": 0, "Unavailable": unavailable,
    }


@pytest.mark.parametrize("key", KEYS)
@pytest.mark.parametrize("bad", [
    "NaN", "sNaN", "Infinity", "-Infinity", "", "not-a-number",
    1, 1.5, True, Decimal("1"), [], {},
])
def test_malformed_required_values_fail_even_beside_null(key, bad):
    data = inputs("Unavailable", "Unavailable", "Unavailable")
    column(data, key)[0] = bad
    with pytest.raises(ValueError, match="finite technical string"):
        signals(data)


@pytest.mark.parametrize("key", KEYS)
@pytest.mark.parametrize("change", ["missing", "short", "long", "not-list"])
def test_required_arrays_must_exist_and_align(key, change):
    data = inputs()
    owner = data["series"] if key.startswith("macd") else data
    if change == "missing":
        del owner[key]
    else:
        owner[key] = {"short": [], "long": ["1", "2"], "not-list": "1"}[change]
    with pytest.raises((KeyError, ValueError)):
        signals(data)


@pytest.mark.parametrize("data", [None, [], {}, {"version": "2", "basis": "provider_close"}])
def test_invalid_technical_metadata_fails(data):
    with pytest.raises(ValueError):
        signals(data)


def test_unsupported_basis_and_malformed_series_fail():
    data = inputs()
    data["basis"] = "adjusted_close"
    with pytest.raises(ValueError):
        signals(data)
    data = inputs()
    data["series"] = None
    with pytest.raises(ValueError):
        signals(data)


def test_empty_and_close_only_actual_technicals_preserve_alignment_and_input():
    assert signals(technicals([]))["observations"] == []
    bars = [{"close": "100"} for _ in range(70)]
    computed = technicals(bars)
    before = deepcopy(computed)
    rows = signals(computed)["observations"]
    assert computed == before
    assert len(rows) == len(bars)
    assert all(row["status"] == "Unavailable" for row in rows[:49])
    assert rows[0]["counts"]["Unavailable"] == 3
    assert rows[14]["counts"]["Unavailable"] == 2
    assert rows[33]["counts"]["Unavailable"] == 1
    assert all(row["status"] == "Neutral" for row in rows[49:])
    assert all(row["counts"]["Neutral"] == 3 for row in rows[49:])


def test_actual_technicals_prefix_future_and_display_window_invariance():
    bars = [{"close": str(100 + (i * 7) % 19 + i)} for i in range(75)]
    before = deepcopy(bars)
    full = signals(technicals(bars))
    for end in (0, 1, 14, 15, 26, 33, 34, 49, 50, 60, 75):
        assert signals(technicals(bars[:end]))["observations"] == full["observations"][:end]
    changed = bars[:50] + [{"close": str(10000 - i * 37)} for i in range(40)]
    assert signals(technicals(changed))["observations"][:50] == full["observations"][:50]
    selected = 60
    for window in (21, 63, 75):
        start = max(0, len(bars) - window)
        visible = full["observations"][start:]
        expected = signals(technicals(bars[:selected + 1]))["observations"][-1]
        assert visible[selected - start] == expected
    assert bars == before


def test_caller_decimal_context_invariant_for_values_flags_and_failures():
    bars = [{"close": str(100 + (i * 7) % 19 + i)} for i in range(65)]
    data = inputs()
    data["sma20"] = ["1.0000000000000000000000000000000000001"]
    data["rsi14"] = ["55.0000000000000000000000000000000000001"]
    data["series"]["macd12_26"] = ["1E-1000"]
    data["series"]["macd_signal9"] = ["0"]
    expected = signals(data)
    expected_actual = signals(technicals(bars))
    with localcontext() as context:
        context.prec = 2
        context.rounding = ROUND_UP
        context.Emin, context.Emax = -9, 9
        context.capitals, context.clamp = 0, 1
        for signal in context.traps:
            context.traps[signal] = True
        context.traps[InvalidOperation] = False
        context.flags[Inexact] = True
        before = repr(context), dict(context.flags), dict(context.traps)
        assert signals(data) == expected
        assert signals(technicals(bars)) == expected_actual
        data["rsi14"] = ["invalid"]
        with pytest.raises(ValueError):
            signals(data)
        assert (repr(context), dict(context.flags), dict(context.traps)) == before