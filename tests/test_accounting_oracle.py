"""Independent Decimal hand arithmetic ONLY: no production imports or engine verification."""

import json
from decimal import ROUND_FLOOR, Decimal, localcontext
from pathlib import Path

import pytest

ORACLE = Path(__file__).resolve().parent / "fixtures" / "p1" / "oracle.json"


@pytest.fixture
def oracle() -> dict:
    return json.loads(ORACLE.read_text(encoding="utf-8"))


def test_shared_cash_hand_arithmetic(oracle: dict) -> None:
    case = oracle["cost_shared_cash"]
    i = {key: Decimal(value) for key, value in case["input"].items()}
    e = {key: Decimal(value) for key, value in case["expected"].items()}
    with localcontext() as context:
        context.prec = 28
        target_a = i["initial_cash"] * i["weight_a"] / i["signal_close_a"]
        target_b = i["initial_cash"] * i["weight_b"] / i["signal_close_b"]
        assert target_a == e["target_a"] == Decimal("5")
        assert target_b == e["target_b"] == Decimal("5")
        fee_a = Decimal("5") * i["open_a"] * i["fee_rate"]
        remaining = i["initial_cash"] - Decimal("5") * i["open_a"] - fee_a
        affordable_b = (remaining / (i["open_b"] * (Decimal("1") + i["fee_rate"])))
        quantity_b = affordable_b.to_integral_value(rounding=ROUND_FLOOR)
        assert e["quantity_a"] == Decimal("5")
        assert quantity_b == e["quantity_b"] == Decimal("4")
        fee_b = quantity_b * i["open_b"] * i["fee_rate"]
        cash = remaining - quantity_b * i["open_b"] - fee_b
        nav = cash + Decimal("5") * i["close_a"] + quantity_b * i["close_b"]
        assert fee_a == e["fee_a"] == Decimal("5")
        assert fee_b == e["fee_b"] == Decimal("4")
        assert cash == e["cash"] == Decimal("91")
        assert nav == e["nav"] == Decimal("991")
        assert e["actual_weight_a_numerator"] == Decimal("5") * i["close_a"]
        assert e["actual_weight_b_numerator"] == quantity_b * i["close_b"]
        assert e["actual_weight_denominator"] == nav
        assert e["actual_weight_a_numerator"] / nav != i["weight_a"]
        assert e["actual_weight_b_numerator"] / nav != i["weight_b"]


def test_gap_preserves_signal_targets_but_cash_limits_fills(oracle: dict) -> None:
    case = oracle["gap_up"]
    i = {key: Decimal(value) for key, value in case["input"].items()}
    e = {key: Decimal(value) for key, value in case["expected"].items()}
    with localcontext() as context:
        context.prec = 28
        assert i["initial_cash"] * i["weight_a"] / i["signal_close_a"] == e["target_a"]
        assert i["initial_cash"] * i["weight_b"] / i["signal_close_b"] == e["target_b"]
        assert e["target_a"] == e["target_b"] == Decimal("5")
        unit_a = i["open_a"] * (Decimal("1") + i["fee_rate"])
        quantity_a = (i["initial_cash"] / unit_a).to_integral_value(rounding=ROUND_FLOOR)
        remaining = i["initial_cash"] - quantity_a * unit_a
        unit_b = i["open_b"] * (Decimal("1") + i["fee_rate"])
        quantity_b = (remaining / unit_b).to_integral_value(rounding=ROUND_FLOOR)
        assert quantity_a == e["quantity_a"] == Decimal("4")
        assert quantity_b == e["quantity_b"] == Decimal("1")
        assert quantity_a * i["open_a"] * i["fee_rate"] == e["fee_a"] == Decimal("8")
        assert quantity_b * i["open_b"] * i["fee_rate"] == e["fee_b"] == Decimal("1")
        cash = remaining - quantity_b * unit_b
        assert cash == e["cash"] == Decimal("91")
        assert cash + quantity_a * i["close_a"] + quantity_b * i["close_b"] == e["nav"]
        assert e["nav"] == Decimal("991")


def test_split_hand_arithmetic_preserves_nav(oracle: dict) -> None:
    i = {key: Decimal(value) for key, value in oracle["split"]["input"].items()}
    e = {key: Decimal(value) for key, value in oracle["split"]["expected"].items()}
    with localcontext() as context:
        context.prec = 28
        assert i["quantity"] * i["ratio"] == e["quantity"] == Decimal("10")
        assert i["cash"] == e["cash"] == Decimal("500")
        before = i["cash"] + i["quantity"] * i["price_before"]
        after = e["cash"] + e["quantity"] * i["price_after"]
        assert before == after == e["nav"] == Decimal("1000")


def test_dividend_receivable_and_payment_hand_arithmetic(oracle: dict) -> None:
    i = {key: Decimal(value) for key, value in oracle["dividend"]["input"].items()}
    e = {key: Decimal(value) for key, value in oracle["dividend"]["expected"].items()}
    with localcontext() as context:
        context.prec = 28
        receivable = i["eligible_quantity"] * i["cash_per_share"]
        assert i["cash"] == e["cash_before_payment"] == Decimal("500")
        assert receivable == e["receivable_before_payment"] == Decimal("10")
        before = i["cash"] + i["eligible_quantity"] * i["ex_date_close"] + receivable
        assert before == e["nav_before_payment"] == Decimal("1000")
        assert i["cash"] + receivable == e["cash_after_payment"] == Decimal("510")
        assert receivable - receivable == e["receivable_after_payment"] == Decimal("0")
        after = e["cash_after_payment"] + i["eligible_quantity"] * i["ex_date_close"]
        assert after == before == e["nav_after_payment"]
        assert Decimal("0") * i["cash_per_share"] == e["same_day_new_buy_entitlement"]


def test_delist_loss_and_initial_peak_hand_arithmetic(oracle: dict) -> None:
    i = {key: Decimal(value) for key, value in oracle["delist"]["input"].items()}
    e = {key: Decimal(value) for key, value in oracle["delist"]["expected"].items()}
    with localcontext() as context:
        context.prec = 28
        assert i["cash"] + i["quantity"] * i["price_before"] == i["initial_nav"]
        receivable = i["quantity"] * i["cash_per_share"]
        assert receivable == e["receivable"] == Decimal("100")
        assert i["quantity"] - i["quantity"] == e["quantity"] == Decimal("0")
        nav = i["cash"] + receivable
        assert nav == e["nav"] == e["cash_after_payment"] == Decimal("600")
        assert nav / i["initial_nav"] - Decimal("1") == e["total_return"] == Decimal("-0.4")
        drawdown = Decimal("1") - nav / max(i["running_peak"], nav)
        assert drawdown == e["max_drawdown"] == Decimal("0.4")


def test_oracle_is_explicitly_independent_not_engine_evidence(oracle: dict) -> None:
    assert oracle["schema_version"] == "0.1"
    assert oracle["precision"] == 28
    assert Decimal(oracle["tolerance"]) == Decimal("1e-8")
    assert "not an engine run or engine verification" in oracle["scope"]
    assert oracle["unknown_delist"]["missing_fields"] == ["cash_per_share", "pay_at"]
    assert oracle["unknown_delist"]["expected"].startswith("reject;")