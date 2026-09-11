"""Invented-price independent analytic oracles, never market-performance evidence."""

import json
from copy import deepcopy
from decimal import Context, Decimal, localcontext

import pytest
from pydantic import ValidationError
from test_criteria import ARCHIVE, bars_for, cli
from test_portfolio import ALWAYS, snapshot_for
from test_portfolio import saved as saved_archive  # noqa: F401

from itt import analytics, criteria
from itt.analytics import (
    CorrelationSpec,
    TriggerSpec,
    run_market_correlation,
    run_market_trigger,
)


def correlation_spec(assets, **changes):
    bars = next(iter(assets.values()))
    return {"archive_id": ARCHIVE, "symbols": list(assets),
            "start": bars[0]["date"], "end": bars[-1]["date"], **changes}


def trigger_spec(assets, **changes):
    raw = correlation_spec(assets)
    symbols = raw.pop("symbols")
    return {**raw, "symbol": symbols[0], "target_symbol": symbols[-1],
            "condition": ALWAYS, **changes}


def test_pearson_manual_plus_minus_one_and_constant_null(monkeypatch):
    assets = {"AAA": bars_for([100, 110, 99, 99]),
              "BBB": bars_for([100, 90, 99, 99]), "CCC": bars_for([100] * 4)}
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(assets))
    result = run_market_correlation("unused", correlation_spec(assets))
    assert result["matrix"] == [[1, -1, None], [-1, 1, None], [None, None, None]]
    assert result["observations"] == 3
    assert result["reasons"][0][2] == "zero_variance"
    assert result["returns"]["AAA"] == ["0.1", "-0.1", "0"]
    with localcontext(Context(prec=3)):
        assert run_market_correlation("unused", correlation_spec(assets)) == result
    assert json.loads(json.dumps(result, allow_nan=False)) == result


def test_pearson_matches_independent_statistics_oracle(monkeypatch):
    from statistics import correlation

    assets = {"AAA": bars_for([100, 105, 110, 99, 120]),
              "BBB": bars_for([200, 199, 211, 205, 220])}
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(assets))
    result = run_market_correlation("unused", correlation_spec(assets))
    returns = [[float(current["close"]) / float(previous["close"]) - 1
                for previous, current in zip(bars, bars[1:], strict=False)]
               for bars in assets.values()]
    assert result["matrix"][0][1] == pytest.approx(correlation(*returns), abs=1e-14)
    assert result["matrix"][0][1] == result["matrix"][1][0]


@pytest.mark.parametrize("frequency,indices", [
    ("weekly", [5, 12, 19, 26, 33, 39]), ("monthly", [29, 39]),
])
def test_period_end_sampling_strictly_within_window(monkeypatch, frequency, indices):
    assets = {"AAA": bars_for(range(100, 150)), "BBB": bars_for(range(200, 250))}
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(assets))
    spec = correlation_spec(assets, start=assets["AAA"][2]["date"],
                            end=assets["AAA"][39]["date"], frequency=frequency)
    result = run_market_correlation("unused", spec)
    assert result["sample_dates"] == [assets["AAA"][i]["date"] for i in indices]
    assert result["observations"] == len(indices) - 1
    with localcontext(Context(prec=28)):
        assert Decimal(result["returns"]["AAA"][0]) == (
            Decimal(indices[1] - indices[0]) / Decimal(100 + indices[0])
        )
    changed = deepcopy(assets)
    for bars in changed.values():
        for index in [0, 1, *range(40, 50)]:
            bars[index]["close"] = "99999"
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(changed))
    assert run_market_correlation("unused", spec) == result


@pytest.mark.parametrize("frequency", ["daily", "weekly", "monthly"])
def test_insufficient_returns_null_not_fake_diagonal_one(monkeypatch, frequency):
    assets = {"AAA": bars_for([100, 110]), "BBB": bars_for([100, 120])}
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(assets))
    result = run_market_correlation("unused", correlation_spec(assets, frequency=frequency))
    assert result["matrix"] == [[None, None], [None, None]]
    assert result["reasons"] == [["insufficient_returns"] * 2] * 2
    assert result["observations"] == (1 if frequency == "daily" else 0)


@pytest.mark.parametrize("changes", [
    {"symbols": ["AAA"]}, {"symbols": ["AAA", "AAA"]}, {"symbols": ["aaa", "BBB"]},
    {"symbols": [f"A{i}" for i in range(11)]}, {"frequency": "annual"},
    {"start": "2024-02-30"}, {"end": "2024-01-02"}, {"archive_id": 1}, {"extra": 1},
])
def test_correlation_malformed(changes):
    assets = {"AAA": bars_for([100, 110]), "BBB": bars_for([100, 120])}
    with pytest.raises(ValidationError):
        CorrelationSpec.model_validate(correlation_spec(assets, **changes))


@pytest.mark.parametrize("changes", [
    {"horizons": []}, {"horizons": [0]}, {"horizons": [61]}, {"horizons": [True]},
    {"horizons": ["1"]}, {"horizons": [1, 1]}, {"condition": "news about rate cuts"},
    {"condition": {"left": "close", "op": "eval", "right": "0"}},
    {"target_symbol": "bad"}, {"extra": 1},
])
def test_trigger_malformed(changes):
    assets = {"AAA": bars_for([100, 110]), "BBB": bars_for([100, 120])}
    with pytest.raises(ValidationError):
        TriggerSpec.model_validate(trigger_spec(assets, **changes))


@pytest.mark.parametrize("operation", ["correlation", "trigger"])
@pytest.mark.parametrize("mutation,match", [
    ("archive", "archive_id"), ("symbol", "symbol"), ("start", "exact saved"),
    ("middle", "identical saved"), ("timezone", "timezone"), ("currency", "currency"),
    ("date_basis", "date basis"), ("duplicate", "unique ascending"),
    ("timestamps", "identical saved"), ("duplicate_timestamp", "timestamps must"),
    ("descending", "unique ascending"),
])
def test_analytics_alignment_rejected(monkeypatch, operation, mutation, match):
    assets = {"AAA": bars_for([100] * 5), "BBB": bars_for([100] * 5)}
    snapshot = snapshot_for(assets)
    item = snapshot["symbols"][1]
    if mutation == "archive":
        snapshot["manifest"]["id"] = "stale"
    elif mutation == "symbol":
        snapshot["symbols"].pop()
    elif mutation in ("timezone", "currency", "date_basis"):
        item[mutation] = "mismatch"
    elif mutation in ("start", "middle"):
        item["bars"].pop(0 if mutation == "start" else 2)
    elif mutation == "duplicate":
        item["bars"][1]["date"] = item["bars"][0]["date"]
    elif mutation == "timestamps":
        item["bars"][1]["timestamp"] += 1
    elif mutation == "duplicate_timestamp":
        item["bars"][1]["timestamp"] = item["bars"][0]["timestamp"]
    elif mutation == "descending":
        item["bars"].reverse()
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot)
    runner = run_market_correlation if operation == "correlation" else run_market_trigger
    spec = correlation_spec(assets) if operation == "correlation" else trigger_spec(assets)
    with pytest.raises(ValueError, match=match):
        runner("unused", spec)


def test_trigger_next_open_horizon_oracle_overrun_and_overlap(monkeypatch):
    assets = {"AAA": bars_for([100] * 4),
              "BBB": bars_for([100, 110, 90, 120], [100, 100, 100, 100])}
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(assets))
    result = run_market_trigger("unused", trigger_spec(assets, horizons=[1, 2, 5]))
    assert result["event_count"] == 4
    assert [e["outcomes"][0]["return"] for e in result["events"]] == ["0.1", "-0.1", "0.2", None]
    assert result["summary"][0]["n"] == 3
    assert Decimal(result["summary"][0]["mean"]) == Decimal(2) / 30
    assert result["summary"][0]["median"] == "0.1"
    assert Decimal(result["summary"][0]["win_rate"]) == Decimal(2) / 3
    assert result["summary"][0]["overlapping_samples"] is False
    assert result["summary"][1]["n"] == 2
    assert result["summary"][1]["mean"] == "0.05"
    assert result["summary"][1]["overlapping_samples"] is True
    assert result["summary"][2]["n"] == 0
    assert result["summary"][2]["mean"] is None
    assert result["warnings"] == ["overlapping_samples"]
    assert "not_tradable_backtest" in result["analysis_type"]
    assert result["events"][-1]["outcomes"][0]["entry_date"] is None
    assert json.loads(json.dumps(result, allow_nan=False)) == result


def test_trigger_causal_cross_warmup_future_outcomes_only(monkeypatch):
    assets = {"AAA": bars_for([90, 110, 90, 120, 90]),
              "BBB": bars_for([100, 100, 110, 120, 130])}
    spec = trigger_spec(assets, start=assets["AAA"][1]["date"],
                        end=assets["AAA"][3]["date"], horizons=[1, 2],
                        condition={"left": "close", "op": "crosses_above", "right": "100"})
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(assets))
    result = run_market_trigger("unused", spec)
    assert [e["date"] for e in result["events"]] == [assets["AAA"][i]["date"] for i in [1, 3]]
    changed = deepcopy(assets)
    changed["BBB"][2]["close"] = "99999"
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(changed))
    mutated = run_market_trigger("unused", spec)
    assert result["signals"] == mutated["signals"]
    assert result["events"][0]["condition"] == mutated["events"][0]["condition"]
    assert result["events"][0]["outcomes"] != mutated["events"][0]["outcomes"]
    changed = deepcopy(assets)
    for bars in changed.values():
        bars[4]["close"] = "99999"
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(changed))
    assert run_market_trigger("unused", spec) == result


def test_trigger_custom_indicator_cache_exact_results_and_prefix_invariance(monkeypatch):
    assets = {"AAA": bars_for([10, 8, 12, 9, 15, 8, 16]),
              "BBB": bars_for([100, 110, 90, 120, 80, 130, 100], [100] * 7)}
    condition = {"all": [
        {"left": {"indicator": "sma", "period": 1}, "op": "crosses_above",
         "right": {"indicator": "sma", "period": 1, "lag": 1}},
        {"left": {"operation": "subtract",
                  "left": {"indicator": "sma", "period": 1},
                  "right": {"indicator": "sma", "period": 1, "lag": 1}},
         "op": "gt", "right": 0},
        {"left": {"indicator": "ema", "period": 2}, "op": "gt", "right": 0},
    ]}
    spec = trigger_spec(assets, condition=condition, start=assets["AAA"][1]["date"],
                        end=assets["AAA"][5]["date"], horizons=[1])
    snapshot = snapshot_for(assets)
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot)
    custom_series = criteria._custom_series
    calls = []

    def counted(bars, kind, period):
        calls.append((kind, period, len(bars)))
        return custom_series(bars, kind, period)

    with monkeypatch.context() as cache_patch:
        cache_patch.setattr(criteria, "_custom_series", counted)
        result = run_market_trigger("unused", spec)
    assert calls == [("sma", 1, 6), ("ema", 2, 6)]
    assert [row["result"] for row in result["signals"]] == [None, True, False, True, False]
    assert [event["date"] for event in result["events"]] == [
        assets["AAA"][i]["date"] for i in (2, 4)
    ]
    assert [event["outcomes"][0]["return"] for event in result["events"]] == ["0.2", "0.3"]
    assert result["summary"] == [{
        "horizon": 1, "n": 2, "mean": "0.25", "median": "0.25", "win_rate": "1",
        "reason": None, "overlapping_samples": False,
    }]
    rule = criteria.Criterion.model_validate(condition)
    for index, row in enumerate(result["signals"], start=1):
        prefix = snapshot_for({"AAA": assets["AAA"][:index + 1]})["symbols"][0]
        assert row == {"date": assets["AAA"][index]["date"],
                       "timestamp": assets["AAA"][index]["timestamp"],
                       **criteria._evaluate(prefix, rule, index)}
    assert json.loads(json.dumps(result, allow_nan=False)) == result
    # Same requested window, truncated archive: byte-for-byte public result parity.
    truncated = {symbol: bars[:6] for symbol, bars in assets.items()}
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(truncated))
    assert run_market_trigger("unused", spec) == result
    changed = deepcopy(assets)
    for bars in changed.values():
        for bar in bars[4:]:
            bar["close"] = "99999"
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(changed))
    assert run_market_trigger("unused", spec)["signals"][:3] == result["signals"][:3]


def test_trigger_revalidates_existing_condition_before_archive_io(monkeypatch):
    assets = {"AAA": bars_for([100, 110])}
    existing = TriggerSpec.model_validate(trigger_spec(assets))
    deep = existing.condition
    for _ in range(20):
        deep = criteria.Criterion.model_construct(criteria.NotRule.model_construct(not_=deep))
    existing.condition = deep

    def forbidden(*args, **kwargs):
        pytest.fail("invalid condition must be rejected before archive I/O")

    monkeypatch.setattr(analytics, "load_market", forbidden)
    for value in (existing, trigger_spec(assets, condition=deep)):
        with pytest.raises(ValidationError, match="depth/node limit"):
            run_market_trigger("unused", value)


def test_trigger_same_symbol_and_unavailable_conditions(monkeypatch):
    assets = {"AAA": bars_for([100, 110, 120])}
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(assets))
    result = run_market_trigger("unused", trigger_spec(assets))
    assert result["summary"][0]["n"] == 2
    result = run_market_trigger("unused", trigger_spec(
        assets, condition={"left": "sma200", "op": "gt", "right": "0"},
    ))
    assert result["events"] == []
    assert all(row["result"] is None for row in result["signals"])
    assert all(row["reason"] == "no_complete_outcomes" for row in result["summary"])


def test_trigger_recursive_criteria_and_public_spec_roundtrip(monkeypatch):
    assets = {"AAA": bars_for([90, 110, 120, 100])}
    monkeypatch.setattr(analytics, "load_market", lambda root: snapshot_for(assets))
    condition = {"all": [
        {"left": "close", "op": "gt", "right": "100"},
        {"not": {"left": "close", "op": "gt", "right": "115"}},
    ]}
    result = run_market_trigger("unused", trigger_spec(assets, condition=condition, horizons=[1]))
    assert [event["date"] for event in result["events"]] == [assets["AAA"][1]["date"]]
    assert TriggerSpec.model_validate(result["spec"]).condition.model_dump() == condition


@pytest.mark.parametrize("operation", ["correlation", "trigger"])
def test_verified_archive_cli_parity_no_writes_and_hash_rejection(
    request, operation, tmp_path,
):
    root, portfolio_spec, _ = request.getfixturevalue("saved_archive")
    spec = {key: portfolio_spec[key] for key in ("archive_id", "start", "end")}
    if operation == "correlation":
        spec.update(symbols=["AAA", "BBB"])
        runner = run_market_correlation
    else:
        spec.update(symbol="AAA", target_symbol="BBB", condition=ALWAYS)
        runner = run_market_trigger
    path = tmp_path / "analytics.json"
    path.write_text(json.dumps(spec), encoding="utf-8")
    before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    expected = runner(root, spec)
    process = cli("market", operation, "--spec", str(path), "--store", str(root))
    assert process.returncode == 0, process.stderr
    assert json.loads(process.stdout) == {"ok": True, "result": expected}
    assert {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()} == before
    with pytest.raises(ValueError, match="archive_id"):
        runner(root, {**spec, "archive_id": "stale"})
    raw = root / spec["archive_id"] / "raw-BBB.json"
    raw.write_bytes(raw.read_bytes() + b" ")
    with pytest.raises(ValueError, match="invalid market snapshot"):
        runner(root, spec)
    process = cli("market", operation, "--spec", str(path), "--store", str(root))
    assert process.returncode == 2