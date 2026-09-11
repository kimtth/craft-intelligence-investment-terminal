"""Independent accounting oracles; invented Yahoo-shaped fixtures are test data only.

The public CLI tests read a real temporary archive through the production hash
verification/normalization path, but do not claim actual Yahoo market provenance.
"""

import json
import os
import subprocess
import sys
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from decimal import Context, Decimal, localcontext
from io import BytesIO
from pathlib import Path

import pytest
from pydantic import ValidationError

from itt import criteria, market
from itt.criteria import SUPPORTED_OPERANDS, CriteriaSpec, run_market_backtest
from itt.indicators import technicals
from itt.rpc import RPCServer

ARCHIVE = "11111111-1111-4111-8111-111111111111"


def bars_for(closes, opens=None):
    opens = closes if opens is None else opens
    start = datetime(2024, 1, 2, 14, 30, tzinfo=UTC)
    return [{
        "date": (start + timedelta(days=i)).date().isoformat(),
        "timestamp": int((start + timedelta(days=i)).timestamp()),
        "open": str(open_), "close": str(close),
        "high": str(max(Decimal(str(open_)), Decimal(str(close)))),
        "low": str(min(Decimal(str(open_)), Decimal(str(close)))), "volume": "1000",
    } for i, (open_, close) in enumerate(zip(opens, closes, strict=True))]


def snapshot_for(bars):
    return {
        "manifest": {"id": ARCHIVE},
        "symbols": [{
            "symbol": "SPY", "currency": "USD", "price_basis": market._PRICE_BASIS,
            "date_basis": "exchange_timezone", "bars": bars, "technicals": technicals(bars),
        }],
    }


def spec_for(bars, **changes):
    return {
        "archive_id": ARCHIVE, "symbol": "SPY",
        "start": bars[0]["date"], "end": bars[-1]["date"],
        "initial_cash": "1000", "fee_bps": "0", "slippage_bps": "0",
        "entry": {"left": "close", "op": "gt", "right": "90"},
        "exit": {"left": "close", "op": "lt", "right": "90"},
        **changes,
    }


def run_fixture(monkeypatch, bars, **changes):
    snapshot = snapshot_for(bars)
    monkeypatch.setattr(criteria, "load_market", lambda root: snapshot)
    return run_market_backtest(Path("unused"), spec_for(bars, **changes))


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("unmocked network access")

    monkeypatch.setattr(market.urllib.request, "urlopen", forbidden)


def test_manual_next_open_costs_and_independent_buy_hold(monkeypatch):
    bars = bars_for([100, 120, 80, 90], [100, 100, 110, 80])
    result = run_fixture(monkeypatch, bars, fee_bps="100", slippage_bps="100")
    strategy, benchmark = result["strategy"], result["benchmark"]
    buy, sell = strategy["fills"]
    assert (buy["signal_date"], buy["date"], buy["quantity"]) == (
        bars[0]["date"], bars[1]["date"], 9,
    )
    assert Decimal(buy["price"]) == Decimal("101")
    assert Decimal(buy["fee"]) == Decimal("9.09")
    assert Decimal(buy["cash_after"]) == Decimal("81.91")
    assert Decimal(buy["slippage_cost"]) == 9
    assert (sell["signal_date"], sell["date"], sell["side"], sell["quantity"]) == (
        bars[2]["date"], bars[3]["date"], "sell", 9,
    )
    assert Decimal(sell["price"]) == Decimal("79.2")
    assert Decimal(sell["fee"]) == Decimal("7.128")
    assert [Decimal(row["nav"]) for row in strategy["daily"]] == [
        Decimal("1000"), Decimal("1161.91"), Decimal("801.91"), Decimal("787.582"),
    ]
    assert Decimal(strategy["metrics"]["total_return"]) == Decimal("-0.212418")
    assert Decimal(strategy["metrics"]["fees"]) == Decimal("16.218")
    with localcontext(Context(prec=28)):
        expected_dd = Decimal("374.328") / Decimal("1161.91")
    assert Decimal(strategy["metrics"]["max_drawdown"]) == expected_dd
    assert benchmark["fills"] == [buy]
    assert benchmark["metrics"]["final_quantity"] == 9
    assert Decimal(benchmark["metrics"]["final_nav"]) == Decimal("891.91")
    assert Decimal(benchmark["metrics"]["fees"]) == Decimal("9.09")
    assert [row["date"] for row in strategy["daily"]] == [
        row["date"] for row in benchmark["daily"]
    ]
    assert all(Decimal(row["cash"]) >= 0 for row in strategy["daily"])
    assert json.loads(json.dumps(result, allow_nan=False)) == result


def test_drawdown_includes_initial_cash_and_no_final_liquidation(monkeypatch):
    result = run_fixture(monkeypatch, bars_for([100, 50], [100, 100]))
    for account in (result["strategy"], result["benchmark"]):
        assert Decimal(account["metrics"]["max_drawdown"]) == Decimal("0.5")
        assert Decimal(account["metrics"]["total_return"]) == Decimal("-0.5")
        assert account["metrics"]["final_quantity"] == 10
        assert len(account["fills"]) == 1
    assert result["signals"][-1]["status"] == "exit"
    assert result["signals"][-1]["next_execution_date"] is None


def test_last_signal_cannot_execute_in_archive_after_end(monkeypatch):
    bars = bars_for([80, 100, 500])
    result = run_fixture(monkeypatch, bars, end=bars[1]["date"])
    assert result["signals"][-1]["entry"] is True
    assert result["signals"][-1]["execution_reason"] == "end_of_window"
    assert result["strategy"]["fills"] == []
    assert len(result["strategy"]["daily"]) == 2
    assert result["benchmark"]["fills"][0]["date"] == bars[1]["date"]


def test_next_open_not_signal_close_or_same_bar(monkeypatch):
    result = run_fixture(monkeypatch, bars_for([100, 120, 120], [100, 200, 120]))
    fill = result["strategy"]["fills"][0]
    assert Decimal(fill["price"]) == 200
    assert fill["quantity"] == 5
    assert result["strategy"]["daily"][0]["quantity"] == 0


@pytest.mark.parametrize(("op", "previous", "current", "expected"), [
    ("gt", 9, 10, False), ("lt", 11, 10, False),
    ("gt", 10, 11, True), ("lt", 10, 9, True),
    ("crosses_above", 10, 11, True), ("crosses_above", 9, 11, True),
    ("crosses_above", 9, 10, False), ("crosses_above", 11, 12, False),
    ("crosses_below", 10, 9, True), ("crosses_below", 11, 9, True),
    ("crosses_below", 11, 10, False), ("crosses_below", 9, 8, False),
])
def test_comparators_and_cross_equality(monkeypatch, op, previous, current, expected):
    bars = bars_for([previous, current, current])
    result = run_fixture(
        monkeypatch, bars, start=bars[1]["date"],
        entry={"left": "close", "op": op, "right": "10"},
        exit={"left": "close", "op": "lt", "right": "0"},
    )
    signal = result["signals"][0]
    assert signal["entry"] is expected
    reason = signal["entry_reason"]
    assert reason["left_value"] == str(current)
    assert reason["right_value"] == "10"
    assert reason["reason"] == ("condition_true" if expected else "condition_false")
    if op.startswith("crosses"):
        assert reason["previous_left_value"] == str(previous)
        assert reason["previous_right_value"] == "10"
        assert reason["previous_date"] == bars[0]["date"]


def test_cross_uses_both_previous_series_values(monkeypatch):
    bars = bars_for([10, 11, 12], [11, 10, 12])
    result = run_fixture(
        monkeypatch, bars,
        entry={"left": "close", "op": "crosses_above", "right": "open"},
    )
    assert result["signals"][0]["entry"] is None
    assert result["signals"][0]["entry_reason"]["reason"] == "previous_operand_unavailable"
    assert result["signals"][1]["entry"] is True
    assert result["signals"][1]["entry_reason"]["previous_right_value"] == "11"


def test_nulls_are_not_filled_or_treated_as_false(monkeypatch):
    result = run_fixture(
        monkeypatch, bars_for([100, 101, 102]),
        exit={"left": "sma200", "op": "lt", "right": "close"},
    )
    assert all(row["entry"] is True and row["exit"] is None for row in result["signals"])
    assert all(row["status"] == "unavailable" for row in result["signals"])
    assert result["signals"][0]["exit_reason"]["left_value"] is None
    assert result["strategy"]["fills"] == []
    assert len(result["benchmark"]["fills"]) == 1


def test_exit_precedence_even_when_flat_and_when_holding(monkeypatch):
    bars = bars_for([100, 120, 130, 140])
    result = run_fixture(
        monkeypatch, bars, exit={"left": "close", "op": "gt", "right": "110"},
    )
    assert [row["status"] for row in result["signals"]] == ["entry", "exit", "exit", "exit"]
    assert [fill["side"] for fill in result["strategy"]["fills"]] == ["buy", "sell"]
    flat = run_fixture(
        monkeypatch, bars, exit={"left": "close", "op": "gt", "right": "0"},
    )
    assert flat["strategy"]["fills"] == []


def test_warmup_uses_full_prefix_and_future_mutation_cannot_change_past(monkeypatch):
    bars = bars_for(list(range(100, 170)))
    rules = {
        "start": bars[25]["date"], "end": bars[60]["date"],
        "entry": {"left": "close", "op": "gt", "right": "sma20"},
        "exit": {"left": "close", "op": "lt", "right": "sma20"},
    }
    original = run_fixture(monkeypatch, bars, **rules)
    assert Decimal(original["signals"][0]["entry_reason"]["right_value"]) == Decimal("115.5")
    changed = deepcopy(bars)
    for bar in changed[45:]:
        for field in ("open", "high", "low", "close"):
            bar[field] = "9999"
    mutated = run_fixture(monkeypatch, changed, **rules)
    assert original["signals"][:20] == mutated["signals"][:20]
    for name in ("strategy", "benchmark"):
        assert original[name]["daily"][:20] == mutated[name]["daily"][:20]
        assert original[name]["fills"] == mutated[name]["fills"]
    after_end = deepcopy(bars)
    for bar in after_end[61:]:
        for field in ("open", "high", "low", "close"):
            bar[field] = "9999"
    assert run_fixture(monkeypatch, after_end, **rules) == original


def test_allowlist_matches_existing_series_plus_ohlc_and_legacy_rsi():
    values = technicals(bars_for([100, 101]))
    assert set(SUPPORTED_OPERANDS) == set(values["series"]) | {
        "open", "high", "low", "close", "rsi14",
    }
    assert "macd_signal9" in SUPPORTED_OPERANDS


@pytest.mark.parametrize("key", SUPPORTED_OPERANDS)
def test_every_supported_operand_resolves_against_production_technicals(monkeypatch, key):
    bars = bars_for(list(range(100, 310)))
    result = run_fixture(
        monkeypatch, bars, start=bars[-2]["date"],
        entry={"left": key, "op": "gt", "right": key},
        exit={"left": "close", "op": "lt", "right": "0"},
    )
    evidence = result["signals"][0]["entry_reason"]
    assert evidence["left_value"] == evidence["right_value"]
    # Some indicators (e.g. StochRSI on flat RSI) remain mathematically undefined.
    assert evidence["result"] is (None if evidence["left_value"] is None else False)


def test_decimal_context_does_not_change_accounting_or_metrics(monkeypatch):
    bars = bars_for([100, 120, 80, 90], [100, 100, 110, 80])
    expected = run_fixture(monkeypatch, bars, fee_bps="100", slippage_bps="100")
    with localcontext(Context(prec=3)):
        assert run_fixture(monkeypatch, bars, fee_bps="100", slippage_bps="100") == expected


@pytest.mark.parametrize("changes", [
    {"extra": "forbidden"}, {"archive_id": 12}, {"symbol": "spy"},
    {"initial_cash": 1000}, {"initial_cash": True}, {"initial_cash": "NaN"},
    {"initial_cash": "Infinity"}, {"initial_cash": "1_000"},
    {"initial_cash": " 1000"}, {"initial_cash": "0"}, {"initial_cash": "-1"},
    {"fee_bps": "-1"}, {"fee_bps": "10000"}, {"slippage_bps": "10000"},
    {"fee_bps": 1.0}, {"slippage_bps": "-0.01"},
    {"start": "2024-1-02"}, {"start": "2024-02-30"},
    {"start": "2024-01-02T00:00:00"}, {"end": "2024-01-02"},
    {"entry": {"left": "volume", "op": "gt", "right": "1"}},
    {"entry": {"left": "close", "op": "ge", "right": "1"}},
    {"entry": {"left": "close", "op": "gt", "right": "eval('1')"}},
    {"entry": {"left": "close", "op": "gt", "right": "NaN"}},
    {"entry": {"left": "close", "op": "gt", "right": True}},
    {"entry": {"left": "close", "op": "gt", "right": "1", "extra": 0}},
])
def test_invalid_contract_rejected(changes):
    with pytest.raises(ValidationError):
        CriteriaSpec.model_validate(spec_for(bars_for([100, 101]), **changes))


@pytest.mark.parametrize("op", ["gte", "lte", "eq"])
def test_new_equality_operators_and_numeric_literals(monkeypatch, op):
    result = run_fixture(monkeypatch, bars_for([100, 100]),
                         entry={"left": "close", "op": op, "right": 100})
    assert all(row["entry"] is True for row in result["signals"])
    assert result["spec"]["entry"]["right"] == 100


@pytest.mark.parametrize(("kind", "period", "expected"), [
    ("sma", 3, "2"), ("ema", 3, "2"), ("rsi", 2, "100"),
    ("roc", 2, "200"), ("return", 2, "2"), ("volatility", 2, "0.25"),
])
def test_custom_period_formula_oracles(monkeypatch, kind, period, expected):
    result = run_fixture(monkeypatch, bars_for([1, 2, 3, 4]),
                         entry={"left": {"indicator": kind, "period": period},
                                "op": "gte", "right": 0})
    assert Decimal(result["signals"][2]["entry_reason"]["left_value"]) == Decimal(expected)
    assert result["signals"][0]["entry"] is None


@pytest.mark.parametrize(("kind", "period", "legacy"), [
    ("sma", 20, "sma20"), ("ema", 20, "ema20"), ("rsi", 14, "rsi14"),
    ("roc", 12, "roc12"),
])
def test_custom_defaults_equal_legacy_series(monkeypatch, kind, period, legacy):
    bars = bars_for([100 + (i * 7 % 19) for i in range(70)])
    result = run_fixture(monkeypatch, bars,
                         entry={"left": {"indicator": kind, "period": period},
                                "op": "eq", "right": legacy})
    for row in result["signals"]:
        evidence = row["entry_reason"]
        if evidence["left_value"] is not None:
            assert Decimal(evidence["left_value"]) == Decimal(evidence["right_value"])
            assert row["entry"] is True


def test_recursive_rules_lags_arithmetic_and_future_mutation(monkeypatch):
    bars = bars_for([100 + (i * 7 % 19) for i in range(80)])
    entry = {"all": [
        {"any": [
            {"left": {"indicator": "ema", "period": 7, "lag": 1}, "op": "crosses_above",
             "right": {"indicator": "sma", "period": 9}},
            {"left": {"field": "volume", "lag": 2}, "op": "gte", "right": 1000},
        ]},
        {"not": {"left": {"operation": "divide", "left": {"field": "close"},
                           "right": {"field": "close", "lag": 1}}, "op": "lte", "right": "0.5"}},
    ]}
    exit_ = {"all": [
        {"left": {"indicator": kind, "period": 5}, "op": "lt", "right": "-100"}
        for kind in ("rsi", "roc", "return", "volatility")
    ]}
    original = run_fixture(monkeypatch, bars, entry=entry, exit=exit_)
    assert original["spec"]["entry"] == entry
    assert all(row["status"] == "unavailable" for row in original["signals"][:9])
    changed = deepcopy(bars)
    for bar in changed[40:]:
        for field in ("open", "high", "low", "close", "volume"):
            bar[field] = "9999"
    mutated = run_fixture(monkeypatch, changed, entry=entry, exit=exit_)
    assert original["signals"][:40] == mutated["signals"][:40]
    assert original["strategy"]["daily"][:40] == mutated["strategy"]["daily"][:40]
    with localcontext(Context(prec=3)):
        assert run_fixture(monkeypatch, bars, entry=entry, exit=exit_) == original


@pytest.mark.parametrize("kind", ["all", "any", "not"])
def test_nested_unavailable_never_becomes_action(monkeypatch, kind):
    missing = {"left": {"indicator": "sma", "period": 252}, "op": "gt", "right": 0}
    rule = {kind: missing if kind == "not" else [
        {"left": "close", "op": "gt", "right": 0}, missing,
    ]}
    result = run_fixture(monkeypatch, bars_for([100, 101]), entry=rule)
    assert all(row["status"] == "unavailable" for row in result["signals"])
    assert not result["strategy"]["fills"]


@pytest.mark.parametrize(("operation", "expected"), [
    ("add", "105"), ("subtract", "95"), ("multiply", "500"), ("divide", "20"),
])
def test_arithmetic_oracle(monkeypatch, operation, expected):
    result = run_fixture(monkeypatch, bars_for([100, 100]), entry={
        "left": {"operation": operation, "left": "close", "right": "5"},
        "op": "eq", "right": expected,
    })
    assert all(row["entry"] is True for row in result["signals"])


def test_divide_by_zero_unavailable(monkeypatch):
    result = run_fixture(monkeypatch, bars_for([100, 101]), entry={
        "left": {"operation": "divide", "left": "close", "right": 0}, "op": "gt", "right": 0,
    })
    assert all(row["status"] == "unavailable" for row in result["signals"])


def test_legacy_constructor_attributes_and_serialization():
    rule = criteria.Criterion(left="close", op="gt", right="100")
    assert (rule.left, rule.op, rule.right) == ("close", "gt", "100")
    assert rule.model_dump() == {"left": "close", "op": "gt", "right": "100"}


def test_composed_criterion_depth_is_one_budget():
    raw = {"left": "close", "op": "gt", "right": 0}
    composed = criteria.Criterion.model_validate(raw)
    # Leaf operands are depth two; ten not wrappers reach exactly twelve.
    for _ in range(criteria.MAX_DEPTH - 2):
        raw = {"not": raw}
        composed = criteria.Criterion.model_validate({"not": composed})
        assert composed.model_dump() == raw
    for value in ({"not": raw}, {"not": composed},
                  criteria.NotRule.model_construct(not_=composed)):
        with pytest.raises(ValidationError, match="depth/node limit"):
            criteria.Criterion.model_validate(value)


@pytest.mark.parametrize("budget", ["nodes", "cost", "width"])
def test_composed_criterion_limits_match_raw_json(budget):
    leaf = criteria.Criterion(left="close", op="gt", right=0)
    if budget == "nodes":
        child = criteria.Criterion.model_validate({"all": [leaf.model_dump()] * 32})
        children = [child] * 32  # 1 + 32 * (1 + 32 * 3) = 3105 nodes.
    elif budget == "cost":
        child = criteria.Criterion(left={"indicator": "ema", "period": 252},
                                   op="crosses_above", right=0)
        children = [child] * 9
    else:
        children = [leaf] * 33
    raw = {"all": [child.model_dump() for child in children]}
    for value in (raw, {"all": children}, criteria.AllRules.model_construct(all=children)):
        with pytest.raises(ValidationError, match="limit|1..32"):
            criteria.Criterion.model_validate(value)


@pytest.mark.parametrize("budget", ["nodes", "cost", "operand_depth"])
def test_composed_models_at_budget_boundary_match_json(budget):
    leaf = criteria.Criterion(left="close", op="gt", right=0)
    if budget == "nodes":
        child = criteria.Criterion.model_validate({"all": [leaf] * 32})
        valid = {"all": [child, *([leaf] * 10)]}  # 1 + 97 + 30 = 128.
        invalid = {"all": [*valid["all"], leaf]}
    elif budget == "cost":
        child = criteria.Criterion(
            left=criteria.IndicatorOperand(indicator="ema", period=252),
            op="crosses_above", right=0,
        )
        tail = criteria.Criterion(
            left=criteria.IndicatorOperand(indicator="sma", period=37), op="gt", right=0,
        )
        valid = {"all": [*([child] * 8), tail]}  # 1 + 8 * 507 + 39 = 4096.
        invalid = {"all": [*([child] * 8), criteria.Criterion(
            left=criteria.IndicatorOperand(indicator="sma", period=38), op="gt", right=0,
        )]}
    else:
        operand = "close"
        for _ in range(criteria.MAX_DEPTH - 2):
            operand = criteria.ArithmeticOperand(operation="add", left=operand, right=0)
        valid = {"left": operand, "op": "gt", "right": 0}
        invalid = {**valid, "left": criteria.ArithmeticOperand(
            operation="add", left=operand, right=0,
        )}
    model = criteria.Criterion.model_validate(valid)
    raw = json.loads(model.model_dump_json())
    assert criteria.Criterion.model_validate_json(json.dumps(raw)).model_dump() == raw
    # These small over-limit trees can safely be serialized by the test oracle;
    # production validation must not serialize before checking the budget.
    raw_invalid = json.loads(json.dumps(invalid, default=lambda model: model.model_dump()))
    for value in (invalid, raw_invalid):
        with pytest.raises(ValidationError, match="limit"):
            criteria.Criterion.model_validate(value)


@pytest.mark.parametrize("operand,raw", [
    (criteria.IndicatorOperand.model_construct(indicator="sma", period=True),
     {"indicator": "sma", "period": True}),
    (criteria.FieldOperand.model_construct(field="close", lag="1"),
     {"field": "close", "lag": "1"}),
    (criteria.ArithmeticOperand.model_construct(operation="add", left="close", right=True),
     {"operation": "add", "left": "close", "right": True}),
])
def test_nested_operand_models_preserve_strict_json_rejection(operand, raw):
    for left in (operand, raw):
        for value in ({"left": left, "op": "gt", "right": 0},
                      criteria.Comparison.model_construct(left=left, op="gt", right=0)):
            with pytest.raises(ValidationError):
                criteria.Criterion.model_validate(value)


def test_composed_models_preserve_output_attributes_and_service_results(monkeypatch):
    bars = bars_for([10, 8, 12, 9, 15])
    comparison = criteria.Comparison(
        left=criteria.ArithmeticOperand(
            operation="add", left=criteria.IndicatorOperand(indicator="sma", period=2),
            right=0,
        ), op="gt", right=criteria.FieldOperand(field="close", lag=1),
    )
    leaf = criteria.Criterion(comparison)
    assert (leaf.left.operation, leaf.op, leaf.right.lag) == ("add", "gt", 1)
    composed = criteria.Criterion(criteria.AllRules(all=[
        leaf, criteria.Criterion(criteria.AnyRules(any=[
            criteria.Criterion(criteria.NotRule.model_validate({"not": leaf})), leaf,
        ])),
    ]))
    raw = json.loads(composed.model_dump_json())
    assert criteria.Criterion.model_validate_json(json.dumps(raw)).model_dump() == raw
    monkeypatch.setattr(criteria, "load_market", lambda root: snapshot_for(bars))
    spec = spec_for(bars, entry=composed)
    expected = run_market_backtest("unused", {**spec, "entry": raw})
    assert run_market_backtest("unused", spec) == expected
    assert run_market_backtest("unused", CriteriaSpec.model_validate(spec)) == expected
    assert json.loads(json.dumps(expected, allow_nan=False)) == expected


@pytest.mark.parametrize("cyclic", [False, True])
def test_existing_deep_models_rejected_before_serialization_or_service_io(monkeypatch, cyclic):
    leaf = criteria.Criterion(left="close", op="gt", right=0)
    deep = leaf
    for _ in range(1000):
        deep = criteria.Criterion.model_construct(
            criteria.NotRule.model_construct(not_=deep),
        )
    if cyclic:
        deep.root.not_ = deep

    def forbidden(*args, **kwargs):
        pytest.fail("invalid tree must be rejected before serialization or archive I/O")

    monkeypatch.setattr(criteria.Criterion, "model_dump", forbidden)
    monkeypatch.setattr(criteria.NotRule, "model_dump", forbidden)
    monkeypatch.setattr(criteria, "load_market", forbidden)
    base = CriteriaSpec.model_validate(spec_for(bars_for([100, 101])))
    for field in ("entry", "exit"):
        raw_spec = spec_for(bars_for([100, 101]), **{field: deep})
        existing = base.model_copy(update={field: deep})
        for validate, value in (
            (criteria.Criterion.model_validate, deep),
            (CriteriaSpec.model_validate, raw_spec),
            (CriteriaSpec.model_validate, existing),
            (lambda spec: run_market_backtest("unused", spec), raw_spec),
            (lambda spec: run_market_backtest("unused", spec), existing),
        ):
            with pytest.raises(ValidationError, match="depth/node limit"):
                validate(value)


@pytest.mark.parametrize(("kind", "expected"), [("all", False), ("any", True), ("not", False)])
def test_compound_boolean_oracles(monkeypatch, kind, expected):
    true = {"left": "close", "op": "gt", "right": 0}
    false = {"left": "close", "op": "lt", "right": 0}
    rule = {kind: true if kind == "not" else [true, false]}
    result = run_fixture(monkeypatch, bars_for([100, 101]), entry=rule)
    assert all(row["entry"] is expected for row in result["signals"])


def test_custom_cross_uses_previous_values_and_truncated_prefix(monkeypatch):
    bars = bars_for([10, 8, 12, 9, 15])
    rule = {"left": {"indicator": "sma", "period": 1}, "op": "crosses_above",
            "right": {"field": "close", "lag": 1}}
    result = run_fixture(monkeypatch, bars, entry=rule)
    assert [row["entry"] for row in result["signals"]] == [None, None, True, False, True]
    evidence = result["signals"][2]["entry_reason"]
    assert (evidence["previous_left_value"], evidence["previous_right_value"]) == ("8", "10")
    for index in range(len(bars)):
        item = snapshot_for(bars[:index + 1])["symbols"][0]
        assert criteria._evaluate(
            item, criteria.Criterion.model_validate(rule), index,
        ) == result["signals"][index]["entry_reason"]


def test_max_period_and_lag_warmup_boundaries(monkeypatch):
    bars = bars_for([100] * 505)
    rule = {"left": {"indicator": "sma", "period": 252, "lag": 252}, "op": "eq", "right": 100}
    result = run_fixture(monkeypatch, bars, entry=rule)
    assert result["signals"][502]["entry"] is None
    assert result["signals"][503]["entry"] is True


@pytest.mark.parametrize("operand", [
    {"indicator": "sma", "period": value} for value in (0, 253, 1.5, "2", True, None)
] + [
    {"field": "close", "lag": value} for value in (-1, 253, 1.5, "2", True, None)
] + [
    {"indicator": "eval", "period": 2}, {"field": "adjusted_close"},
    {"indicator": "sma", "period": 2, "source": "future"},
    {"operation": "power", "left": "close", "right": 2},
    {"operation": "add", "left": "close"},
])
def test_strict_expression_shapes(operand):
    with pytest.raises(ValidationError):
        criteria.Criterion.model_validate({"left": operand, "op": "gt", "right": 0})


def test_depth_width_node_cost_and_decimal_limits():
    leaf = {"left": "close", "op": "gt", "right": 0}
    deep = leaf
    for _ in range(1000):
        deep = {"not": deep}
    cyclic = {}
    cyclic["not"] = cyclic
    many = {"all": [{"any": [leaf] * 32}] * 2}
    costly = {"all": [{"left": {"indicator": "ema", "period": 252},
                       "op": "crosses_above", "right": 0}] * 9}
    invalid = [deep, cyclic, many, costly, {"all": []}, {"any": [leaf] * 33},
               {"not": leaf, "all": [leaf]}, {"all": [None]}]
    invalid += [{**leaf, "right": number} for number in
                ("1e101", "1e-101", "1" * 65, float("inf"), float("nan"))]
    for value in invalid:
        with pytest.raises(ValidationError):
            criteria.Criterion.model_validate(value)
    for number in ("1e100", "1e-100", "1" * 64, "+.5", 1, 0.5):
        assert criteria.Criterion.model_validate({**leaf, "right": number})


def test_progress_matches_daily_and_final_with_callback_failures_propagated(monkeypatch):
    bars = bars_for([100, 120, 80, 90])
    monkeypatch.setattr(criteria, "load_market", lambda root: snapshot_for(bars))
    events = []
    result = run_market_backtest("unused", spec_for(bars), on_progress=events.append)
    assert len(events) == 2 * len(bars)
    assert result == run_market_backtest("unused", spec_for(bars))
    for phase_index, phase in enumerate(("strategy", "benchmark")):
        partial = events[phase_index * len(bars):(phase_index + 1) * len(bars)]
        assert [event["completed"] for event in partial] == [1, 2, 3, 4]
        for event, row in zip(partial, result[phase]["daily"], strict=True):
            assert event == {
                "phase": phase, "completed": partial.index(event) + 1,
                "total": 4,
                **{key: row[key] for key in ("date", "nav", "cagr", "max_drawdown")},
            }
        assert partial[0]["cagr"] is None
        assert partial[-1]["cagr"] == result[phase]["metrics"]["cagr"]
        assert partial[-1]["nav"] == result[phase]["metrics"]["final_nav"]
        assert partial[-1]["max_drawdown"] == result[phase]["metrics"]["max_drawdown"]

    def cancel(event):
        raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        run_market_backtest("unused", spec_for(bars), on_progress=cancel)


@pytest.mark.parametrize("changes", [
    {"archive_id": "stale"}, {"symbol": "QQQ"},
    {"start": "2024-01-01"}, {"end": "2024-01-05"},
])
def test_archive_symbol_and_exact_session_rejections(monkeypatch, changes):
    with pytest.raises(ValueError):
        run_fixture(monkeypatch, bars_for([100, 101, 102]), **changes)


def test_short_archive_rejected(monkeypatch):
    with pytest.raises(ValueError, match="at least two"):
        run_fixture(monkeypatch, bars_for([100]), end="2024-01-03")


def test_exact_integer_affordability_and_no_negative_cash(monkeypatch):
    bars = bars_for(["0.1", "0.1", "0.1"])
    rule = {"left": "close", "op": "gt", "right": "0"}
    result = run_fixture(monkeypatch, bars, initial_cash="0.3", entry=rule,
                         exit={"left": "close", "op": "lt", "right": "0"})
    assert result["strategy"]["fills"][0]["quantity"] == 3
    assert Decimal(result["strategy"]["metrics"]["final_cash"]) == 0
    tiny = run_fixture(monkeypatch, bars, initial_cash="0.09", entry=rule)
    assert tiny["strategy"]["fills"] == []
    assert tiny["benchmark"]["fills"] == []
    assert Decimal(tiny["benchmark"]["metrics"]["final_nav"]) == Decimal("0.09")


@pytest.fixture
def saved(tmp_path, monkeypatch):
    bars = bars_for([100, 120, 80, 90], [100, 100, 110, 80])
    raw = json.dumps({"chart": {"error": None, "result": [{
        "meta": {"symbol": "SPY", "currency": "USD", "exchangeName": "TEST",
                 "exchangeTimezoneName": "UTC"},
        "timestamp": [bar["timestamp"] for bar in bars],
        "indicators": {"quote": [{
            key: [int(bar[key]) for bar in bars]
            for key in ("open", "high", "low", "close", "volume")
        }]},
        "events": {"splits": {"test": {"numerator": 2, "denominator": 1}},
                   "dividends": {"test": {"amount": 100}}},
    }]}}).encode("utf-8")

    class Reply(BytesIO):
        status = 200

    monkeypatch.setattr(market.urllib.request, "urlopen", lambda *a, **kw: Reply(raw))
    root = tmp_path / "market"
    snapshot = market.fetch_market(["SPY"], root)
    spec = spec_for(bars, archive_id=snapshot["manifest"]["id"])
    spec_path = tmp_path / "criteria.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    return root, spec, spec_path


def test_saved_archive_integrity_and_no_corporate_action_reapplication(saved):
    root, spec, _ = saved
    result = run_market_backtest(root, spec)
    assert result["strategy"]["metrics"]["final_quantity"] == 0
    assert Decimal(result["strategy"]["metrics"]["final_cash"]) == 800
    assert result["benchmark"]["metrics"]["final_quantity"] == 10
    assert Decimal(result["benchmark"]["metrics"]["final_nav"]) == 900
    assert result["contract"]["corporate_actions"] == "no_split_or_dividend_event_reapplication"
    raw_path = root / spec["archive_id"] / "raw-SPY.json"
    raw_path.write_bytes(raw_path.read_bytes() + b" ")
    with pytest.raises(ValueError, match="invalid market snapshot"):
        run_market_backtest(root, spec)


def cli(*args):
    root = Path(__file__).resolve().parents[1]
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(root / "src")
    return subprocess.run(
        [sys.executable, "-m", "itt.cli", *args], cwd=root, env=environment,
        capture_output=True, text=True, timeout=30, check=False,
    )


def test_cli_module_guard_capabilities_and_criteria_schema():
    capabilities = cli("capabilities")
    assert capabilities.returncode == 0, capabilities.stderr
    assert capabilities.stdout.strip(), "python -m itt.cli must call main()"
    assert json.loads(capabilities.stdout)["ok"] is True
    schema = cli("schema", "criteria")
    assert schema.returncode == 0, schema.stderr
    result = json.loads(schema.stdout)["result"]
    assert result["additionalProperties"] is False
    assert set(result["required"]) == set(spec_for(bars_for([100, 101])))


def test_cli_rpc_and_shared_service_same_saved_results(saved):
    root, spec, path = saved
    expected = run_market_backtest(root, spec)
    process = cli("market", "backtest", "--spec", str(path), "--store", str(root))
    assert process.returncode == 0, process.stderr
    assert json.loads(process.stdout) == {"ok": True, "result": expected}
    server = RPCServer()
    try:
        response = server.handle(json.dumps({
            "id": 1, "method": "market.backtest",
            "params": {"store_path": str(root), "spec": spec},
        }).encode())
        assert response == {"id": 1, "ok": True, "result": expected}
        bad = server.handle(json.dumps({
            "id": 2, "method": "market.backtest",
            "params": {"store": str(root), "spec": spec},
        }).encode())
        assert bad["error"]["code"] == "invalid_params"
        stale = server.handle(json.dumps({
            "id": 3, "method": "market.backtest",
            "params": {"store_path": str(root), "spec": {**spec, "archive_id": "stale"}},
        }).encode())
        assert stale["error"]["code"] == "input_rejected"
    finally:
        server.job.close()
    path.write_text(json.dumps({**spec, "archive_id": "stale"}), encoding="utf-8")
    rejected = cli("market", "backtest", "--spec", str(path), "--store", str(root))
    assert rejected.returncode == 2
    assert json.loads(rejected.stdout)["error"] == "input_rejected"