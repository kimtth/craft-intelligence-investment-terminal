"""Portfolio oracles use invented Yahoo-shaped test data, not performance evidence.

Archive/CLI/RPC tests pass those bytes through the real hash-verification path.
No production fallback to these fixtures or the synthetic engine is permitted.
"""

import json
import random
from copy import deepcopy
from decimal import Context, Decimal, localcontext
from io import BytesIO
from pathlib import Path

import pytest
from pydantic import ValidationError
from test_criteria import ARCHIVE, bars_for, cli

from itt import market, portfolio
from itt.criteria import CriteriaSpec, generate_signals
from itt.indicators import technicals
from itt.portfolio import PortfolioSpec, run_market_portfolio
from itt.research import capabilities
from itt.rpc import RPCServer

ALWAYS = {"left": "close", "op": "gt", "right": "0"}
NEVER = {"left": "close", "op": "lt", "right": "0"}


def snapshot_for(assets):
    return {
        "manifest": {"id": ARCHIVE},
        "symbols": [{
            "symbol": symbol, "currency": "USD", "timezone": "UTC",
            "price_basis": market._PRICE_BASIS, "date_basis": "exchange_timezone",
            "bars": bars, "technicals": technicals(bars),
        } for symbol, bars in assets.items()],
    }


def spec_for(assets, **changes):
    bars = next(iter(assets.values()))
    return {
        "archive_id": ARCHIVE, "weights": {symbol: "0.5" for symbol in assets},
        "rebalance_every": 1, "start": bars[0]["date"], "end": bars[-1]["date"],
        "initial_cash": "1000", "fee_bps": "0", "slippage_bps": "0",
        "entry": ALWAYS, "exit": NEVER, **changes,
    }


def run_fixture(monkeypatch, assets, **changes):
    monkeypatch.setattr(portfolio, "load_market", lambda root: snapshot_for(assets))
    return run_market_portfolio(Path("unused"), spec_for(assets, **changes))


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("unexpected network access")

    monkeypatch.setattr(market.urllib.request, "urlopen", forbidden)


def reconcile_account(account, assets, initial, fee_bps, slippage_bps):
    """Independent Decimal ledger replay; does not use portfolio accounting helpers."""
    with localcontext(Context(prec=100)):
        cash = Decimal(initial)
        positions = dict.fromkeys(assets, 0)
        fees = slips = notionals = Decimal(0)
        peak, drawdown = cash, Decimal(0)
        for index, daily in enumerate(account["daily"]):
            for fill in (f for f in account["fills"] if f["date"] == daily["date"]):
                symbol, quantity = fill["symbol"], fill["quantity"]
                assert type(quantity) is int and quantity > 0
                assert fill["signal_date"] < fill["date"]
                raw = Decimal(assets[symbol][index]["open"])
                rate = Decimal(slippage_bps) / 10000
                price = raw * (1 + rate if fill["side"] == "buy" else 1 - rate)
                notional = price * quantity
                fee = notional * Decimal(fee_bps) / 10000
                slip = abs(price - raw) * quantity
                if fill["side"] == "buy":
                    cash -= notional + fee
                    positions[symbol] += quantity
                else:
                    assert quantity <= positions[symbol]
                    cash += notional - fee
                    positions[symbol] -= quantity
                assert cash >= 0
                assert Decimal(fill["cash_after"]) == cash
                assert fill["quantity_after"] == positions[symbol]
                assert Decimal(fill["price"]) == price
                assert Decimal(fill["fee"]) == fee
                assert Decimal(fill["notional"]) == notional
                assert Decimal(fill["slippage_cost"]) == slip
                fees += fee
                slips += slip
                notionals += notional
            values = {s: Decimal(assets[s][index]["close"]) * q for s, q in positions.items()}
            nav = cash + sum(values.values())
            peak = max(peak, nav)
            drawdown = max(drawdown, (peak - nav) / peak)
            assert Decimal(daily["nav"]) == nav
            assert Decimal(daily["cash"]) == cash
            assert daily["positions"] == positions
            assert {s: Decimal(v) for s, v in daily["market_values"].items()} == values
        metrics = account["metrics"]
        assert Decimal(metrics["fees"]) == fees
        assert Decimal(metrics["slippage_cost"]) == slips
        assert Decimal(metrics["traded_notional"]) == notionals
        assert Decimal(metrics["final_nav"]) == nav
        assert Decimal(metrics["final_cash"]) == cash
        assert metrics["final_positions"] == positions
        # Round the complete ratio once, not nav/initial before subtracting 1.
        total_return = (nav - Decimal(initial)) / Decimal(initial)
        with localcontext(Context(prec=28)):
            assert Decimal(metrics["total_return"]) == +total_return
            assert Decimal(metrics["max_drawdown"]) == +drawdown
            assert Decimal(metrics["turnover"]) == notionals / Decimal(initial)


def test_independent_manual_rebalance_oracle_and_same_cost_benchmark(monkeypatch):
    assets = {
        "AAA": bars_for([100, 200, 100, 100], [100, 100, 200, 100]),
        "BBB": bars_for([100, 100, 200, 200], [100, 100, 100, 200]),
    }
    result = run_fixture(monkeypatch, assets, fee_bps="100", slippage_bps="100")
    strategy, benchmark = result["strategy"], result["benchmark"]
    assert [(f["symbol"], f["side"], f["quantity"]) for f in strategy["fills"]] == [
        ("AAA", "buy", 5), ("BBB", "buy", 4),
        ("AAA", "sell", 2), ("BBB", "buy", 3),
        ("BBB", "sell", 3), ("AAA", "buy", 6),
    ]
    assert [Decimal(d["nav"]) for d in strategy["daily"]] == [
        Decimal("1000"), Decimal("1481.91"), Decimal("1867.92"), Decimal("1843.92"),
    ]
    assert [Decimal(d["cash"]) for d in strategy["daily"]] == [
        Decimal("1000"), Decimal("81.91"), Decimal("167.92"), Decimal("143.92"),
    ]
    assert Decimal(strategy["metrics"]["fees"]) == Decimal("28.08")
    assert Decimal(strategy["metrics"]["slippage_cost"]) == 28
    assert Decimal(strategy["metrics"]["total_return"]) == Decimal("0.84392")
    assert strategy["orders"][1]["remaining_quantity"] == 1
    assert strategy["orders"][1]["status"] == "expired"
    assert benchmark["fills"] == strategy["fills"][:2]
    assert Decimal(benchmark["metrics"]["final_nav"]) == Decimal("1381.91")
    assert benchmark["metrics"]["final_positions"] == {"AAA": 5, "BBB": 4}
    assert strategy["metrics"]["rebalance_count"] == 3
    assert benchmark["metrics"]["rebalance_count"] == 1
    assert [d["date"] for d in strategy["daily"]] == [d["date"] for d in benchmark["daily"]]
    for account in (strategy, benchmark):
        reconcile_account(account, assets, "1000", "100", "100")
    assert json.loads(json.dumps(result, allow_nan=False)) == result


def test_targets_are_frozen_at_close_and_gaps_do_not_borrow(monkeypatch):
    assets = {"AAA": bars_for([100, 100, 100], [100, 1000, 100]),
              "BBB": bars_for([100, 100, 100])}
    result = run_fixture(monkeypatch, assets, rebalance_every=10)
    for account in (result["strategy"], result["benchmark"]):
        assert account["decisions"][0]["targets"] == {"AAA": 5, "BBB": 5}
        assert [(o["filled_quantity"], o["remaining_quantity"]) for o in account["orders"]] == [
            (1, 4), (0, 5),
        ]
        assert account["daily"][0]["positions"] == {"AAA": 0, "BBB": 0}
        assert account["metrics"]["final_positions"] == {"AAA": 1, "BBB": 0}
        assert account["metrics"]["fill_count"] == 1  # No next-day hidden retry.
        assert Decimal(account["metrics"]["max_drawdown"]) == Decimal("0.9")
        reconcile_account(account, assets, "1000", "0", "0")


def test_down_gap_never_increases_frozen_quantity(monkeypatch):
    assets = {"AAA": bars_for([100, 10], [100, 10]), "BBB": bars_for([100, 10], [100, 10])}
    result = run_fixture(monkeypatch, assets)
    assert result["strategy"]["metrics"]["final_positions"] == {"AAA": 5, "BBB": 5}
    assert Decimal(result["strategy"]["metrics"]["final_cash"]) == 900


def test_non_rebalance_signals_latch_eligibility_and_exit_waits_for_cadence(monkeypatch):
    assets = {"AAA": bars_for([100, 200, 200, 200, 50, 50, 50, 50]),
              "BBB": bars_for([100] * 8)}
    result = run_fixture(
        monkeypatch, assets, rebalance_every=3,
        entry={"left": "close", "op": "crosses_above", "right": "150"},
        exit={"left": "close", "op": "lt", "right": "75"},
    )
    decisions = result["strategy"]["decisions"]
    assert [d["date"] for d in decisions] == [assets["AAA"][i]["date"] for i in (0, 3, 6)]
    assert decisions[1]["eligible"] == {"AAA": True, "BBB": False}
    assert decisions[2]["eligible"] == {"AAA": False, "BBB": False}
    fills = result["strategy"]["fills"]
    assert [(f["side"], f["date"], f["quantity"]) for f in fills] == [
        ("buy", assets["AAA"][4]["date"], 2), ("sell", assets["AAA"][7]["date"], 2),
    ]
    assert all(f["symbol"] == "AAA" for f in fills)


def test_ineligible_allocation_is_cash_not_redistributed(monkeypatch):
    assets = {"AAA": bars_for([200] * 3), "BBB": bars_for([100] * 3)}
    result = run_fixture(monkeypatch, assets, weights={"AAA": "0.4", "BBB": "0.4"},
                         entry={"left": "close", "op": "gt", "right": "150"})
    assert result["strategy"]["metrics"]["final_positions"] == {"AAA": 2, "BBB": 0}
    assert Decimal(result["strategy"]["metrics"]["final_cash"]) == 600
    assert result["benchmark"]["metrics"]["final_positions"] == {"AAA": 2, "BBB": 4}
    assert Decimal(result["benchmark"]["metrics"]["final_cash"]) == 200


def test_exit_precedence_and_unavailable_freeze_held_quantity(monkeypatch):
    assets = {"AAA": bars_for([100, 200, 300], [100, 100, 200]),
              "BBB": bars_for([100] * 3)}
    result = run_fixture(monkeypatch, assets, exit=ALWAYS)
    assert result["strategy"]["fills"] == []
    assert all(row["status"] == "exit" for rows in result["signals"].values() for row in rows)
    snapshot = snapshot_for(assets)
    snapshot["symbols"][0]["technicals"]["series"]["sma5"] = ["1", None, "1"]
    snapshot["symbols"][1]["technicals"]["series"]["sma5"] = ["1", "1", "1"]
    monkeypatch.setattr(portfolio, "load_market", lambda root: snapshot)
    result = run_market_portfolio("unused", spec_for(
        assets, exit={"left": "sma5", "op": "lt", "right": "0"},
    ))
    decision = result["strategy"]["decisions"][1]
    assert decision["eligible"]["AAA"] is True
    assert decision["targets"]["AAA"] == 5  # Without freezing, target would fall to 3.
    assert decision["reasons"]["AAA"] == "criterion_unavailable_freeze_quantity"
    assert result["strategy"]["metrics"]["final_positions"]["AAA"] == 5
    assert len(result["strategy"]["fills"]) == 2


def test_all_unavailable_stays_cash_but_benchmark_ignores_criteria(monkeypatch):
    assets = {"AAA": bars_for([100] * 3), "BBB": bars_for([100] * 3)}
    result = run_fixture(monkeypatch, assets, entry={"left": "sma200", "op": "gt", "right": "0"})
    assert result["strategy"]["fills"] == []
    assert result["benchmark"]["metrics"]["fill_count"] == 2


def test_full_prefix_warmup_shared_criteria_and_future_mutation(monkeypatch):
    assets = {"AAA": bars_for(list(range(100, 180))),
              "BBB": bars_for(list(range(200, 280)))}
    changes = {
        "start": assets["AAA"][25]["date"], "end": assets["AAA"][60]["date"],
        "entry": {"left": "close", "op": "gt", "right": "sma20"},
        "exit": {"left": "close", "op": "lt", "right": "sma20"},
    }
    original = run_fixture(monkeypatch, assets, **changes)
    single = CriteriaSpec.model_validate({
        **{k: v for k, v in spec_for(assets, **changes).items()
           if k not in ("weights", "rebalance_every")}, "symbol": "AAA",
    })
    assert original["signals"]["AAA"] == generate_signals(
        snapshot_for(assets)["symbols"][0], single.entry, single.exit, 25, 60,
    )
    assert Decimal(original["signals"]["AAA"][0]["entry_reason"]["right_value"]) == Decimal("115.5")
    changed = deepcopy(assets)
    for bar in changed["BBB"][45:]:
        for field in ("open", "high", "low", "close"):
            bar[field] = "9999"
    mutated = run_fixture(monkeypatch, changed, **changes)
    assert original["signals"]["AAA"] == mutated["signals"]["AAA"]
    assert original["signals"]["BBB"][:20] == mutated["signals"]["BBB"][:20]
    for name in ("strategy", "benchmark"):
        assert original[name]["daily"][:20] == mutated[name]["daily"][:20]
        cutoff = assets["AAA"][45]["date"]
        for field in ("fills", "orders", "decisions"):
            assert [r for r in original[name][field] if r["date"] < cutoff] == [
                r for r in mutated[name][field] if r["date"] < cutoff
            ]
    changed = deepcopy(assets)
    for bars in changed.values():
        for bar in bars[61:]:
            for field in ("open", "high", "low", "close"):
                bar[field] = "9999"
    assert run_fixture(monkeypatch, changed, **changes) == original


def test_last_signal_never_fills_after_end_or_liquidates(monkeypatch):
    assets = {"AAA": bars_for([100, 200, 1000], [100, 100, 200]),
              "BBB": bars_for([100, 200, 1000], [100, 100, 200])}
    result = run_fixture(monkeypatch, assets, end=assets["AAA"][1]["date"],
                         entry={"left": "close", "op": "gt", "right": "150"})
    assert result["strategy"]["fills"] == []
    assert len(result["strategy"]["daily"]) == 2
    assert all(rows[-1]["next_execution_date"] is None for rows in result["signals"].values())
    assert result["benchmark"]["metrics"]["final_positions"] == {"AAA": 5, "BBB": 5}


def test_decimal_context_exact_fractional_prices_and_input_order_invariance(monkeypatch):
    assets = {"AAA": bars_for(["0.1"] * 4), "BBB": bars_for(["0.2"] * 4)}
    changes = {"weights": {"AAA": "0.5", "BBB": "0.5"}, "initial_cash": "0.6"}
    expected = run_fixture(monkeypatch, assets, **changes)
    assert expected["strategy"]["metrics"]["final_positions"] == {"AAA": 3, "BBB": 1}
    assert Decimal(expected["strategy"]["metrics"]["final_cash"]) == Decimal("0.1")
    with localcontext(Context(prec=3)):
        assert run_fixture(monkeypatch, assets, **changes) == expected
    reverse = dict(reversed(list(assets.items())))
    assert run_fixture(monkeypatch, reverse, **changes) == expected


@pytest.mark.parametrize("changes", [
    {"weights": {}}, {"weights": {"AAA": "0", "BBB": "0"}},
    {"weights": {"AAA": "-0.1"}}, {"weights": {"AAA": "1.01"}},
    {"weights": {"AAA": "0.6", "BBB": "0.5"}},
    {"weights": {"AAA": "0.5", "BBB": "0.50000000000000000000000000001"}},
    {"weights": {"AAA": 0.5}}, {"weights": {"AAA": True}},
    {"weights": {"aaa": "1"}}, {"weights": {"AAA": "NaN"}},
    {"weights": {f"A{i}": "0.01" for i in range(11)}},
    {"rebalance_every": 0}, {"rebalance_every": -1}, {"rebalance_every": True},
    {"rebalance_every": "1"}, {"rebalance_every": 1.5},
    {"initial_cash": "0"}, {"initial_cash": "-1"}, {"initial_cash": 100},
    {"fee_bps": "10000"}, {"slippage_bps": "-1"}, {"fee_bps": "Infinity"},
    {"start": "2024-02-30"}, {"end": "2024-01-02"}, {"archive_id": 1},
    {"entry": {"left": "volume", "op": "gt", "right": "0"}},
    {"exit": {"left": "close", "op": "eval", "right": "0"}}, {"extra": 1},
])
def test_strict_spec_rejections(changes):
    assets = {"AAA": bars_for([100, 100]), "BBB": bars_for([100, 100])}
    with pytest.raises(ValidationError):
        PortfolioSpec.model_validate(spec_for(assets, **changes))


@pytest.mark.parametrize("field", list(spec_for({"AAA": bars_for([100, 100])})))
def test_no_implicit_spec_defaults(field):
    spec = spec_for({"AAA": bars_for([100, 100])})
    del spec[field]
    with pytest.raises(ValidationError):
        PortfolioSpec.model_validate(spec)


@pytest.mark.parametrize("mutation, message", [
    ("stale", "archive_id"), ("missing_symbol", "symbol"),
    ("missing_middle", "identical saved"), ("missing_start", "exact saved"),
    ("missing_end", "exact saved"), ("duplicate_date", "unique ascending"),
    ("out_of_order", "unique ascending"), ("timestamp_offset", "identical saved"),
    ("timestamp_duplicate", "timestamps must"), ("timezone", "same exchange timezone"),
    ("fallback", "same date basis"), ("currency", "USD"),
])
def test_cross_asset_validation_before_any_simulation(monkeypatch, mutation, message):
    assets = {"AAA": bars_for([100] * 4), "BBB": bars_for([100] * 4)}
    snapshot = snapshot_for(assets)
    item = snapshot["symbols"][1]
    if mutation == "stale":
        snapshot["manifest"]["id"] = "stale"
    elif mutation == "missing_symbol":
        snapshot["symbols"].pop()
    elif mutation.startswith("missing_"):
        item["bars"].pop({"missing_middle": 1, "missing_start": 0, "missing_end": -1}[mutation])
    elif mutation == "duplicate_date":
        item["bars"][1]["date"] = item["bars"][0]["date"]
    elif mutation == "out_of_order":
        item["bars"].reverse()
    elif mutation == "timestamp_offset":
        for bar in item["bars"]:
            bar["timestamp"] += 3600
    elif mutation == "timestamp_duplicate":
        item["bars"][1]["timestamp"] = item["bars"][0]["timestamp"]
    elif mutation == "timezone":
        item["timezone"] = "America/New_York"
    elif mutation == "fallback":
        item["date_basis"] = "UTC_fallback_exchange_timezone_unavailable"
    elif mutation == "currency":
        item["currency"] = "EUR"
    monkeypatch.setattr(portfolio, "load_market", lambda root: snapshot)
    monkeypatch.setattr(portfolio, "_simulate",
                        lambda *a, **kw: pytest.fail("ran before validation"))
    with pytest.raises(ValueError, match=message):
        run_market_portfolio("unused", spec_for({
            "AAA": bars_for([100] * 4), "BBB": bars_for([100] * 4),
        }))


def test_one_asset_and_zero_weight_are_explicitly_supported(monkeypatch):
    assets = {"AAA": bars_for([100] * 3), "BBB": bars_for([100] * 3)}
    result = run_fixture(monkeypatch, assets, weights={"AAA": "1", "BBB": "0"})
    assert result["strategy"]["metrics"]["final_positions"] == {"AAA": 10, "BBB": 0}
    result = run_fixture(monkeypatch, assets, weights={"AAA": "1"})
    assert result["symbols"] == ["AAA"]
    assert result["strategy"]["metrics"]["final_positions"] == {"AAA": 10}


@pytest.mark.parametrize("seed", range(8))
def test_independent_ledger_reconciliation_across_prices_costs_and_cadences(monkeypatch, seed):
    rng = random.Random(seed)
    assets = {}
    for symbol in ("AAA", "BBB", "CCC"):
        closes = [str(Decimal(rng.randrange(1, 30000)) / 100) for _ in range(30)]
        opens = [str(Decimal(rng.randrange(1, 30000)) / 100) for _ in range(30)]
        assets[symbol] = bars_for(closes, opens)
    fee, slip = str(seed * 37), str(seed * 23)
    result = run_fixture(
        monkeypatch, assets, initial_cash="1234.56789", fee_bps=fee, slippage_bps=slip,
        weights={"AAA": "0.3", "BBB": "0.2", "CCC": "0.4"},
        rebalance_every=seed + 1,
        entry={"left": "close", "op": "gt", "right": "150"},
        exit={"left": "close", "op": "lt", "right": "100"},
    )
    for name in ("strategy", "benchmark"):
        reconcile_account(result[name], assets, "1234.56789", fee, slip)


def test_matching_utc_fallback_is_labeled_not_claimed_as_exchange_dates(monkeypatch):
    assets = {"AAA": bars_for([100] * 3), "BBB": bars_for([100] * 3)}
    snapshot = snapshot_for(assets)
    for item in snapshot["symbols"]:
        item["date_basis"] = "UTC_fallback_exchange_timezone_unavailable"
    monkeypatch.setattr(portfolio, "load_market", lambda root: snapshot)
    result = run_market_portfolio("unused", spec_for(assets))
    for metadata in result["contract"]["asset_metadata"].values():
        assert metadata["date_basis"] == "UTC_fallback_exchange_timezone_unavailable"
    assert result["strategy"]["metrics"]["fill_count"] == 2


@pytest.fixture
def saved(tmp_path, monkeypatch):
    assets = {"AAA": bars_for([100, 200, 100, 100], [100, 100, 200, 100]),
              "BBB": bars_for([100, 100, 200, 200], [100, 100, 100, 200])}
    payloads = {}
    for symbol, bars in assets.items():
        payloads[symbol] = json.dumps({"chart": {"error": None, "result": [{
            "meta": {"symbol": symbol, "currency": "USD", "exchangeName": "TEST",
                     "exchangeTimezoneName": "UTC"},
            "timestamp": [bar["timestamp"] for bar in bars],
            "indicators": {"quote": [{key: [int(bar[key]) for bar in bars]
                                      for key in ("open", "high", "low", "close", "volume")}]},
            "events": {"splits": {"test": {"numerator": 2, "denominator": 1}},
                       "dividends": {"test": {"amount": 100}}},
        }]}}).encode()

    class Reply(BytesIO):
        status = 200

    def reply(request, **kwargs):
        symbol = request.full_url.split("/chart/")[1].split("?")[0]
        return Reply(payloads[symbol])

    monkeypatch.setattr(market.urllib.request, "urlopen", reply)
    root = tmp_path / "market"
    snapshot = market.fetch_market(list(assets), root)
    monkeypatch.setattr(market.urllib.request, "urlopen",
                        lambda *a, **kw: pytest.fail("network after archive save"))
    spec = spec_for(assets, archive_id=snapshot["manifest"]["id"],
                    fee_bps="100", slippage_bps="100")
    path = tmp_path / "portfolio.json"
    path.write_text(json.dumps(spec), encoding="utf-8")
    return root, spec, path


def test_real_archive_path_cli_rpc_parity_and_no_writes(saved):
    root, spec, path = saved
    before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    expected = run_market_portfolio(root, spec)
    assert Decimal(expected["strategy"]["metrics"]["final_nav"]) == Decimal("1843.92")
    assert expected["contract"]["corporate_actions"] == "no_split_or_dividend_event_reapplication"
    process = cli("market", "portfolio", "--spec", str(path), "--store", str(root))
    assert process.returncode == 0, process.stderr
    assert json.loads(process.stdout) == {"ok": True, "result": expected}
    server = RPCServer()
    try:
        response = server.handle(json.dumps({
            "id": 1, "method": "market.portfolio",
            "params": {"store_path": str(root), "spec": spec},
        }).encode())
        assert response == {"id": 1, "ok": True, "result": expected}
        response = server.handle(json.dumps({
            "id": 2, "method": "market.portfolio",
            "params": {"store": str(root), "spec": spec},
        }).encode())
        assert response["error"]["code"] == "invalid_params"
        response = server.handle(json.dumps({
            "id": 3, "method": "market.portfolio",
            "params": {"store_path": str(root), "spec": {**spec, "archive_id": "stale"}},
        }).encode())
        assert response["error"]["code"] == "input_rejected"
    finally:
        server.job.close()
    assert {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()} == before


def test_corruption_stale_archive_missing_archive_and_no_fallback(saved):
    root, spec, path = saved
    with pytest.raises(ValueError, match="archive_id"):
        run_market_portfolio(root, {**spec, "archive_id": "stale"})
    with pytest.raises(ValueError, match="invalid market snapshot"):
        run_market_portfolio(root / "missing", spec)
    raw = root / spec["archive_id"] / "raw-BBB.json"
    raw.write_bytes(raw.read_bytes() + b" ")
    with pytest.raises(ValueError, match="invalid market snapshot"):
        run_market_portfolio(root, spec)
    process = cli("market", "portfolio", "--spec", str(path), "--store", str(root))
    assert process.returncode == 2
    assert json.loads(process.stdout)["error"] == "input_rejected"


def test_public_schema_and_capabilities_are_truthful():
    process = cli("schema", "portfolio")
    assert process.returncode == 0, process.stderr
    schema = json.loads(process.stdout)["result"]
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(spec_for({"AAA": bars_for([100, 100])}))
    actual = capabilities()
    assert actual["market_data"]["backtest_supported"] is True
    assert "market portfolio" in actual["commands"]
    assert "market backtest" in actual["commands"]
    assert actual["market_data"]["pit_verified"] is False
    assert actual["market_data"]["historical_universe_verified"] is False
    assert set(actual["providers"]) == {"github_copilot"}
    assert "not_probed_by_python" in actual["providers"]["github_copilot"]


@pytest.mark.parametrize("changes", [
    {"allocation": {"mode": "unknown"}}, {"allocation": {"lookback": 0}},
    {"allocation": {"lookback": 253}}, {"allocation": {"lookback": True}},
    {"allocation": {"top_n": 0}}, {"allocation": {"top_n": 11}},
    {"allocation": {"minimum_return": 0.1}}, {"allocation": {"minimum_return": "NaN"}},
    {"allocation": {"extra": 1}}, {"rebalance_calendar": "annual"},
])
def test_allocation_schema_rejections(changes):
    with pytest.raises(ValidationError):
        PortfolioSpec.model_validate(spec_for({"AAA": bars_for([100, 100])}, **changes))


def test_allocation_defaults_preserve_fixed_results(monkeypatch):
    assets = {"AAA": bars_for([100, 110, 120]), "BBB": bars_for([100, 90, 80])}
    implicit = run_fixture(monkeypatch, assets)
    explicit = run_fixture(monkeypatch, assets, allocation={
        "mode": "fixed", "lookback": 20, "top_n": 1, "minimum_return": "0",
    }, rebalance_calendar="sessions")
    assert implicit == explicit


def test_momentum_full_archive_warmup_ties_budget_and_fixed_benchmark(monkeypatch):
    assets = {"AAA": bars_for([100, 110, 121, 121], [100, 100, 110, 121]),
              "BBB": bars_for([100, 110, 121, 121], [100, 100, 110, 121])}
    result = run_fixture(monkeypatch, assets, start=assets["AAA"][1]["date"],
                         weights={"BBB": "0.4", "AAA": "0.4"},
                         allocation={"mode": "momentum", "lookback": 1, "top_n": 1})
    first = result["strategy"]["decisions"][0]
    assert first["selected"] == ["AAA"]
    assert first["momentum_returns"] == {"AAA": "0.1", "BBB": "0.1"}
    assert first["targets"] == {"AAA": 7, "BBB": 0}
    assert result["strategy"]["fills"][0]["quantity"] == 7
    assert result["benchmark"]["decisions"][0]["targets"] == {"AAA": 3, "BBB": 3}
    fixed = run_fixture(monkeypatch, assets, start=assets["AAA"][1]["date"],
                        weights={"BBB": "0.4", "AAA": "0.4"})
    assert result["benchmark"] == fixed["benchmark"]


def test_momentum_rotates_sells_first_and_reconciles(monkeypatch):
    assets = {"AAA": bars_for([100, 200, 100, 50, 50], [100, 100, 200, 100, 50]),
              "BBB": bars_for([100, 100, 200, 100, 100], [100, 100, 100, 200, 100])}
    result = run_fixture(monkeypatch, assets,
                         allocation={"mode": "momentum", "lookback": 1})
    strategy = result["strategy"]
    assert [row["selected"] for row in strategy["decisions"]] == [[], ["AAA"], ["BBB"], []]
    assert [row["targets"] for row in strategy["decisions"]] == [
        {"AAA": 0, "BBB": 0}, {"AAA": 5, "BBB": 0},
        {"AAA": 0, "BBB": 2}, {"AAA": 0, "BBB": 0},
    ]
    assert [(f["symbol"], f["side"]) for f in strategy["fills"]] == [
        ("AAA", "buy"), ("AAA", "sell"), ("BBB", "buy"), ("BBB", "sell"),
    ]
    assert strategy["metrics"]["final_nav"] == "300"
    reconcile_account(strategy, assets, "1000", "0", "0")


@pytest.mark.parametrize("minimum", ["0.1", "0.2"])
def test_momentum_requires_strictly_positive_above_threshold(monkeypatch, minimum):
    assets = {"AAA": bars_for([100, 110, 110]), "BBB": bars_for([100, 90, 90])}
    result = run_fixture(monkeypatch, assets, allocation={
        "mode": "momentum", "lookback": 1, "minimum_return": minimum,
    })
    assert result["strategy"]["fills"] == []
    result = run_fixture(monkeypatch, {"AAA": bars_for([100, 90, 90])}, allocation={
        "mode": "momentum", "lookback": 1, "minimum_return": "-1",
    })
    assert result["strategy"]["fills"] == []


def test_momentum_top_n_equal_split_and_criterion_exclusion(monkeypatch):
    assets = {"AAA": bars_for([100, 110, 110]), "BBB": bars_for([100, 120, 120]),
              "CCC": bars_for([100, 130, 130])}
    result = run_fixture(monkeypatch, assets, weights=dict.fromkeys(assets, "0.3"),
                         entry={"left": "close", "op": "lt", "right": "125"},
                         allocation={"mode": "momentum", "lookback": 1, "top_n": 2},
                         exit={"left": "close", "op": "gt", "right": "125"})
    decision = result["strategy"]["decisions"][1]
    assert decision["selected"] == ["BBB", "AAA"]
    assert decision["targets"] == {"AAA": 4, "BBB": 3, "CCC": 0}


def test_momentum_future_mutation_cannot_change_close_decision(monkeypatch):
    assets = {"AAA": bars_for([100, 110, 120, 130, 140, 150]),
              "BBB": bars_for([100, 120, 110, 120, 110, 100])}
    changes = {"start": assets["AAA"][2]["date"], "end": assets["AAA"][4]["date"],
               "allocation": {"mode": "momentum", "lookback": 2}}
    original = run_fixture(monkeypatch, assets, **changes)
    mutated = deepcopy(assets)
    for bar in mutated["AAA"][3:]:
        for key in ("open", "close", "high", "low"):
            bar[key] = "99999"
    changed = run_fixture(monkeypatch, mutated, **changes)
    assert changed["strategy"]["decisions"][0] == original["strategy"]["decisions"][0]
    assert changed["strategy"]["daily"][0] == original["strategy"]["daily"][0]
    mutated = deepcopy(assets)
    mutated["AAA"][5]["close"] = "9999"
    assert run_fixture(monkeypatch, mutated, **changes) == original


@pytest.mark.parametrize("calendar,every,indices", [
    ("monthly", 1, [0, 30, 59, 90]), ("monthly", 2, [0, 59]),
    ("quarterly", 1, [0, 90]), ("quarterly", 2, [0]),
])
def test_calendar_first_observed_period_cadence(monkeypatch, calendar, every, indices):
    assets = {"AAA": bars_for([100] * 100)}
    result = run_fixture(monkeypatch, assets, rebalance_calendar=calendar, rebalance_every=every)
    assert [d["date"] for d in result["strategy"]["decisions"]] == [
        assets["AAA"][index]["date"] for index in indices
    ]
    assert len(result["benchmark"]["decisions"]) == 1


def test_portfolio_daily_final_progress_matches_shared_metrics(monkeypatch):
    from fractions import Fraction

    from itt.progress import metrics_snapshot

    assets = {"AAA": bars_for([100, 110, 90])}
    monkeypatch.setattr(portfolio, "load_market", lambda root: snapshot_for(assets))
    callbacks = []
    result = run_market_portfolio("unused", spec_for(assets), on_progress=callbacks.append)
    assert len(callbacks) == 6
    for phase in ("strategy", "benchmark"):
        rows = [row for row in callbacks if row["phase"] == phase]
        assert [row["completed"] for row in rows] == [1, 2, 3]
        assert all(row["total"] == 3 for row in rows)
        for row, daily in zip(rows, result[phase]["daily"], strict=True):
            assert {key: row[key] for key in ("nav", "cagr", "max_drawdown")} == {
                key: daily[key] for key in ("nav", "cagr", "max_drawdown")
            }
        metrics = result[phase]["metrics"]
        expected = metrics_snapshot(Fraction(1000), Fraction(metrics["final_nav"]),
                                    Fraction(metrics["max_drawdown"]),
                                    assets["AAA"][0]["date"], assets["AAA"][-1]["date"])
        assert metrics["cagr"] == expected["cagr"] == rows[-1]["cagr"]


def test_portfolio_recursive_criteria_and_public_spec_roundtrip(monkeypatch):
    assets = {"AAA": bars_for([100, 110, 120])}
    entry = {"all": [ALWAYS, {"not": NEVER}]}
    result = run_fixture(monkeypatch, assets, entry=entry)
    assert result["strategy"]["fills"]
    assert PortfolioSpec.model_validate(result["spec"]).entry.model_dump() == entry


def test_progress_callback_can_abort_without_suppression(monkeypatch):
    assets = {"AAA": bars_for([100, 110, 120])}
    monkeypatch.setattr(portfolio, "load_market", lambda root: snapshot_for(assets))
    callbacks = []

    def cancel(row):
        callbacks.append(row)
        raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        run_market_portfolio("unused", spec_for(assets), on_progress=cancel)
    assert len(callbacks) == 1
    assert callbacks[0]["phase"] == "strategy"