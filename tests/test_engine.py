"""P2 production comparisons against static hand-authored answers, not engine oracles."""

import json
from copy import deepcopy
from datetime import datetime
from decimal import ROUND_UP, Decimal, localcontext
from pathlib import Path

import pytest

from itt.contracts import Dataset, ResearchSpec
from itt.data import validate_dataset
from itt.engine import run_backtest

FIXTURES = Path(__file__).resolve().parent / "fixtures"
D = Decimal
NUMERIC_KEYS = {
    "cash", "receivables", "nav", "raw_price", "price", "notional", "fee", "slippage",
    "cash_after", "initial_nav", "final_nav", "total_return", "max_drawdown", "turnover",
    "traded_notional", "fees", "total_costs",
}


def read(name: str, phase: str = "p2") -> dict:
    return json.loads((FIXTURES / phase / name).read_text(encoding="utf-8"))


@pytest.fixture
def bundle() -> dict:
    return read("normal.json")


@pytest.fixture
def spec() -> dict:
    return read("spec.json")


def run(bundle: dict, spec: dict) -> dict:
    return run_backtest(Dataset.model_validate(bundle), ResearchSpec.model_validate(spec))


def compare(actual: dict, expected: dict) -> None:
    """Compare every explicit independent field; lists must match in full and in order."""
    for key, value in expected.items():
        if key in NUMERIC_KEYS:
            assert isinstance(actual[key], str)
            assert abs(D(actual[key]) - D(value)) <= D("1e-8"), key
        elif isinstance(value, list):
            assert len(actual[key]) == len(value), key
            for got, wanted in zip(actual[key], value, strict=True):
                compare(got, wanted)
        elif isinstance(value, dict) and key != "positions":
            compare(actual[key], value)
        else:
            assert actual[key] == value, key


def action_case(bundle: dict, spec: dict, kind: str) -> tuple[dict, dict]:
    cases = read("actions.json")
    scenario = cases[kind]
    bundle, spec = deepcopy(bundle), deepcopy(spec)
    spec.update(cases["spec_overrides"])
    action = scenario["action"]
    bundle["corporate_actions"] = [action]
    retained = []
    for row in bundle["observations"]:
        if row["asset_id"] == "SYN-A" and row["observed_at"] >= action["effective_at"]:
            if scenario["price_after"] is None:
                continue
            row["value"] = scenario["price_after"]
        retained.append(row)
    bundle["observations"] = retained
    return bundle, spec


def add_exit(bundle: dict, asset: str = "SYN-A", day: str = "2024-01-04") -> None:
    bundle["universe_events"].append({
        "asset_id": asset, "effective_at": f"{day}T14:30:00Z",
        "available_at": f"{day}T14:30:00Z", "action": "exit", "source": "synthetic://exit",
    })


def test_complete_normal_ledger_and_metrics_against_static_oracle(bundle, spec):
    assert len(bundle["sessions"]) == 5 and len(bundle["observations"]) == 20
    assert all(row["observed_at"] == row["available_at"] for row in bundle["observations"])
    result = run(bundle, spec)
    oracle = read("oracle.json")["normal"]
    for name in ("strategy", "benchmark"):
        compare(result[name], oracle[name])
        assert result[name]["pending_orders"] == []
    strategy = result["strategy"]
    assert strategy["decisions"][0]["targets"] == {"SYN-A": 5, "SYN-B": 5}
    assert strategy["decisions"][1]["targets"] == {"SYN-A": 4, "SYN-B": 4}
    partial = [o for o in strategy["orders"] if o["event"] == "expired"]
    assert len(partial) == 1
    assert partial[0]["reason"] == "insufficient_cash_including_fees"
    assert partial[0]["filled_quantity"] == 4 and partial[0]["remaining_quantity"] == 1
    assert D(strategy["daily"][1]["actual_weights"]["SYN-A"]) == D(500) / D(991)
    assert D(strategy["daily"][1]["actual_weights"]["SYN-B"]) == D(400) / D(991)
    assert result["synthetic"] is True and result["external_audit"] is False
    assert result["schema_version"] == "0.1" and result["engine_version"]


def test_gap_does_not_reoptimize_decision_targets(bundle, spec):
    spec["end"] = "2024-01-03"
    for row in bundle["observations"]:
        if row["asset_id"] == "SYN-A" and row["observed_at"].startswith("2024-01-03"):
            row["value"] = "200"
    oracle = read("oracle.json")["gap"]
    for portfolio in (run(bundle, spec)[name] for name in ("strategy", "benchmark")):
        assert portfolio["decisions"][0]["targets"] == oracle["targets"]
        compare(portfolio["daily"][1], oracle["daily"])
        compare(portfolio, {"fills": oracle["fills"]})


def test_fees_and_slippage_both_buy_and_sell(bundle, spec):
    spec["slippage_rate"] = "0.01"
    result = run(bundle, spec)
    compare(result["strategy"], read("oracle.json")["fee_and_slippage"])
    assert result["strategy"]["fills"][:2] == [
        dict(fill, order_id=fill["order_id"].replace("benchmark", "strategy"))
        for fill in result["benchmark"]["fills"]
    ]


@pytest.mark.parametrize("kind", ["split", "dividend", "delist"])
def test_separate_corporate_action_oracles(bundle, spec, kind):
    bundle, spec = action_case(bundle, spec, kind)
    portfolio = run(bundle, spec)["strategy"]
    oracle = read("oracle.json")["actions"]
    compare(portfolio["daily"][1], oracle["before"])
    compare(portfolio["daily"][2], oracle[kind])
    if kind != "split":
        compare(portfolio["daily"][-1], oracle[f"{kind}_paid"])
        assert [a["event"] for a in portfolio["actions"]] == [kind, "payment"]
    if kind == "delist":
        compare(portfolio["metrics"], {"total_return": "-0.4", "max_drawdown": "0.4"})
        assert portfolio["actions"][0]["eligible_quantity"] == 5
        assert D(portfolio["actions"][0]["amount"]) == D(100)


def test_delist_future_payment_preserves_receivable_and_loss(bundle, spec):
    bundle, spec = action_case(bundle, spec, "delist")
    bundle["corporate_actions"][0]["pay_at"] = "2024-01-10T14:30:00Z"
    portfolio = run(bundle, spec)["strategy"]
    compare(portfolio["daily"][-1], {
        "cash": "500", "positions": {}, "receivables": "100", "nav": "600",
    })
    item = portfolio["daily"][-1]["receivable_items"][0]
    assert item["kind"] == "delist" and item["quantity"] == 5
    assert datetime.fromisoformat(item["pay_at"]).day == 10
    assert not any(a["event"] == "payment" for a in portfolio["actions"])


@pytest.mark.parametrize("missing", ["cash_per_share", "pay_at"])
def test_unknown_delist_is_denied(bundle, spec, missing):
    bundle, spec = action_case(bundle, spec, "delist")
    del bundle["corporate_actions"][0][missing]
    with pytest.raises(ValueError, match="explicit cash_per_share and pay_at"):
        run(bundle, spec)


def test_split_pending_orders_and_not_previous_history(bundle, spec):
    bundle, spec = action_case(bundle, spec, "split")
    action = bundle["corporate_actions"][0]
    action.update(effective_at="2024-01-03T14:30:00Z", available_at="2024-01-02T12:00:00Z")
    for row in bundle["observations"]:
        if row["asset_id"] == "SYN-A" and row["observed_at"] >= action["effective_at"]:
            row["value"] = "50"
    portfolio = run(bundle, spec)["strategy"]
    assert portfolio["decisions"][0]["targets"] == {"SYN-A": 5}
    assert portfolio["orders"][0]["quantity"] == 5
    assert portfolio["fills"][0]["quantity"] == 10
    assert portfolio["daily"][1]["positions"] == {"SYN-A": 10}
    assert portfolio["actions"][0]["pending_changes"] == [
        {"order_id": "strategy-1", "before": 5, "after": 10}
    ]


@pytest.mark.parametrize("pending", [False, True])
def test_fractional_split_positions_or_pending_rejected(bundle, spec, pending):
    bundle, spec = action_case(bundle, spec, "split")
    action = bundle["corporate_actions"][0]
    action["ratio"] = "0.5"
    if pending:
        action.update(effective_at="2024-01-03T14:30:00Z",
                      available_at="2024-01-02T12:00:00Z")
    with pytest.raises(ValueError, match="fractional split"):
        run(bundle, spec)


def test_multikind_same_asset_timestamp_is_explicitly_blocked(bundle, spec):
    bundle, spec = action_case(bundle, spec, "split")
    bundle["corporate_actions"].append(read("actions.json")["dividend"]["action"])
    assert validate_dataset(Dataset.model_validate(bundle))["status"] == "passed"
    with pytest.raises(ValueError, match="multiple corporate action kinds"):
        run(bundle, spec)


def test_same_day_new_buys_have_no_dividend_entitlement(bundle, spec):
    bundle, spec = action_case(bundle, spec, "dividend")
    bundle["corporate_actions"][0].update(
        effective_at="2024-01-03T14:30:00Z", available_at="2024-01-02T12:00:00Z")
    portfolio = run(bundle, spec)["strategy"]
    assert portfolio["fills"][0]["quantity"] == 5
    assert portfolio["actions"][0]["eligible_quantity"] == 0
    assert D(portfolio["actions"][0]["amount"]) == 0
    assert all(D(row["receivables"]) == 0 for row in portfolio["daily"])


@pytest.mark.parametrize("pay_time,filled", [
    ("14:30:00", 10), ("18:00:00", 0), ("21:00:00", 0),
])
def test_open_payment_can_fund_buys_but_intraday_payment_cannot(bundle, spec, pay_time, filled):
    spec.update(allocation="fixed", weights={"SYN-A": "1"}, fee_rate="0")
    action = read("actions.json")["dividend"]["action"]
    action.update(cash_per_share="100", pay_at=f"2024-01-05T{pay_time}Z")
    bundle["corporate_actions"] = [action]
    portfolio = run(bundle, spec)["strategy"]
    assert D(portfolio["daily"][2]["cash"]) == 0
    assert D(portfolio["daily"][2]["receivables"]) == 1000
    assert portfolio["daily"][3]["positions"]["SYN-A"] == 10 + filled
    assert D(portfolio["daily"][3]["cash"]) == 1000 - filled * 100
    assert D(portfolio["daily"][3]["receivables"]) == 0
    attempts = [o for o in portfolio["orders"]
                if o["at"].startswith("2024-01-05T14:30") and o["side"] == "buy"]
    assert len(attempts) == 1 and attempts[0]["filled_quantity"] == filled


def test_delist_cancels_pending_and_never_reenters_without_universe_exit(bundle, spec):
    bundle, spec = action_case(bundle, spec, "delist")
    spec.update(rebalance_every=1)
    # Prior-day NAV falls to 750, so target 7 shares creates a pending buy of 2.
    for row in bundle["observations"]:
        if row["asset_id"] == "SYN-A" and row["observed_at"] == "2024-01-03T21:00:00Z":
            row["value"] = "50"
    portfolio = run(bundle, spec)["strategy"]
    cancellations = [o for o in portfolio["orders"] if o["event"] == "cancelled"]
    assert len(cancellations) == 1
    assert cancellations[0]["reason"] == "delisted" and cancellations[0]["quantity"] == 2
    assert all("SYN-A" not in d["weights"] for d in portfolio["decisions"][2:])
    assert len(portfolio["fills"]) == 1


@pytest.mark.parametrize("allocation", ["equal", "fixed"])
def test_exit_targets_zero_sells_before_buys_and_benchmark_holds(bundle, spec, allocation):
    spec.update(fee_rate="0", allocation=allocation)
    if allocation == "fixed":
        spec["weights"] = {"SYN-A": "0.5", "SYN-B": "0.5"}
    # B exits: its sell must precede the lexically earlier A buy.
    add_exit(bundle, "SYN-B")
    result = run(bundle, spec)
    decision = result["strategy"]["decisions"][2]
    assert decision["targets"]["SYN-B"] == 0
    assert D(decision["weights"]["SYN-A"]) == (D(1) if allocation == "equal" else D(".5"))
    fills = [f for f in result["strategy"]["fills"] if f["date"] == "2024-01-05"]
    assert fills[0]["asset_id"] == "SYN-B" and fills[0]["side"] == "sell"
    if allocation == "equal":
        assert fills[1]["asset_id"] == "SYN-A" and fills[1]["side"] == "buy"
        assert D(fills[1]["cash_after"]) == 0
    else:
        assert len(fills) == 1 and D(fills[0]["cash_after"]) == 500
    assert result["benchmark"]["daily"][-1]["positions"] == {"SYN-A": 5, "SYN-B": 5}
    assert len(result["benchmark"]["decisions"]) == 1


def test_p1_data_contract_valid_but_first_decision_unavailable_is_rejected():
    bundle, spec = read("valid.json", "p1"), read("spec.json", "p1")
    assert validate_dataset(Dataset.model_validate(bundle))["status"] == "passed"
    with pytest.raises(ValueError, match="missing exact available close.*SYN-B"):
        run(bundle, spec)


@pytest.mark.parametrize("field,at,available", [
    ("open", "2024-01-03T14:30:00Z", "2024-01-03T14:31:00Z"),
    ("close", "2024-01-02T21:00:00Z", "2024-01-03T14:30:00Z"),
    ("close", "2024-01-04T21:00:00Z", "2024-01-05T14:30:00Z"),
])
def test_delayed_exact_prices_never_use_stale_or_future_substitutes(bundle, spec, field, at,
                                                                 available):
    if at.startswith("2024-01-04"):
        add_exit(bundle)
        spec["rebalance_every"] = 20  # Exited holding still needs an exact current close.
    for row in bundle["observations"]:
        if row["asset_id"] == "SYN-A" and row["field"] == field and row["observed_at"] == at:
            row["available_at"] = available
    assert validate_dataset(Dataset.model_validate(bundle))["status"] == "passed"
    with pytest.raises(ValueError, match=f"missing exact available {field}"):
        run(bundle, spec)


@pytest.mark.parametrize("field", ["open", "close"])
def test_missing_price_is_denied_before_execution(bundle, spec, field):
    bundle["observations"] = [
        row for row in bundle["observations"]
        if not (row["asset_id"] == "SYN-A" and row["field"] == field
                and row["observed_at"].startswith("2024-01-03"))
    ]
    with pytest.raises(ValueError, match="missing required raw price"):
        run(bundle, spec)


def test_public_api_calls_shared_spec_validation(bundle, spec, monkeypatch):
    from itt import research

    calls = []

    def reject(candidate_spec, candidate_dataset):
        calls.append((candidate_spec.dataset_id, candidate_dataset.manifest.dataset_id))
        raise ValueError("validation sentinel")

    monkeypatch.setattr(research, "validate_spec", reject)
    with pytest.raises(ValueError, match="validation sentinel"):
        run(bundle, spec)
    assert calls == [(spec["dataset_id"], bundle["manifest"]["dataset_id"])]


def test_start_after_historical_split_has_only_new_cash_and_no_phantom_entitlement(bundle, spec):
    bundle, spec = action_case(bundle, spec, "split")
    spec.update(start="2024-01-05", lookback=3)
    portfolio = run(bundle, spec)["strategy"]
    compare(portfolio["daily"][0], {"cash": "1000", "nav": "1000", "positions": {}})
    assert portfolio["actions"] == []
    assert portfolio["decisions"][0]["targets"] == {"SYN-A": 10}
    assert portfolio["fills"][0]["quantity"] == 10


def test_initial_day_cash_only_last_decision_pending_no_outside_fills(bundle, spec):
    spec.update(start="2024-01-03", end="2024-01-03", lookback=1)
    for portfolio in (run(bundle, spec)[name] for name in ("strategy", "benchmark")):
        assert portfolio["fills"] == []
        assert len(portfolio["pending_orders"]) == 2
        compare(portfolio["daily"][0], {"cash": "1000", "nav": "1000", "positions": {}})
        assert all(o["decision_at"].startswith("2024-01-03T21:00")
                   for o in portfolio["pending_orders"])


def test_rebalance_index_starts_at_evaluation_start_and_warmup_never_shifts(bundle, spec):
    spec.update(start="2024-01-03", lookback=1, rebalance_every=2)
    result = run(bundle, spec)
    assert [d["date"] for d in result["strategy"]["decisions"]] == ["2024-01-03", "2024-01-05"]
    for name in ("strategy", "benchmark"):
        assert [d["date"] for d in result[name]["daily"]] == [
            "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08"]
        assert all("2024-01-04" <= f["date"] <= "2024-01-08" for f in result[name]["fills"])
    spec["lookback"] = 2
    with pytest.raises(ValueError, match="insufficient warmup"):
        run(bundle, spec)


def test_final_unfilled_orders_are_retained_without_execution(bundle, spec):
    add_exit(bundle, "SYN-A", "2024-01-08")
    portfolio = run(bundle, spec)["strategy"]
    assert [(o["asset_id"], o["side"], o["quantity"]) for o in portfolio["pending_orders"]] == [
        ("SYN-A", "sell", 4), ("SYN-B", "buy", 5)]
    assert all(f["date"] < "2024-01-08" for f in portfolio["fills"])


def test_input_immutability_determinism_json_and_decimal_context_independence(bundle, spec):
    dataset, research = Dataset.model_validate(bundle), ResearchSpec.model_validate(spec)
    before = (dataset.model_dump_json(), research.model_dump_json())
    first = run_backtest(dataset, research)
    with localcontext() as context:
        context.prec = 6
        context.rounding = ROUND_UP
        assert run_backtest(dataset, research) == first
        assert context.prec == 6 and context.rounding == ROUND_UP
    assert run_backtest(dataset, research) == first
    assert (dataset.model_dump_json(), research.model_dump_json()) == before
    assert json.loads(json.dumps(first, allow_nan=False)) == first
    assert first["spec"] == research.model_dump(mode="json")
    for name in ("strategy", "benchmark"):
        assert "cagr" not in first[name]["metrics"] and "sharpe" not in first[name]["metrics"]


def test_record_input_order_does_not_affect_result(bundle, spec):
    original = run(bundle, spec)
    for section in ("observations", "universe_events", "corporate_actions"):
        bundle[section].reverse()
    assert run(bundle, spec) == original


def test_equal_thirds_do_not_lose_integer_share_at_rounding_boundary(bundle, spec):
    spec.update(initial_cash="3000", fee_rate="0")
    bundle["universe_events"].append(dict(bundle["universe_events"][0], asset_id="SYN-C"))
    bundle["observations"].extend([
        dict(row, asset_id="SYN-C") for row in bundle["observations"]
        if row["asset_id"] == "SYN-A"
    ])
    result = run(bundle, spec)
    for name in ("strategy", "benchmark"):
        assert result[name]["decisions"][0]["targets"] == {
            "SYN-A": 10, "SYN-B": 10, "SYN-C": 10,
        }
        assert result[name]["daily"][1]["positions"] == {
            "SYN-A": 10, "SYN-B": 10, "SYN-C": 10,
        }
        assert D(result[name]["daily"][1]["cash"]) == 0


@pytest.mark.parametrize("mutation", ["prices", "revision", "entry", "split"])
def test_valid_future_mutations_preserve_all_earlier_ledgers(bundle, spec, mutation):
    original = run(bundle, spec)
    if mutation == "prices":
        for row in bundle["observations"]:
            if row["observed_at"] >= "2024-01-05":
                row["value"] = "777"
    elif mutation == "revision":
        revised = dict(bundle["observations"][1], revision=2, value="999",
                       available_at="2024-01-05T20:00:00Z")
        bundle["observations"].append(revised)
    elif mutation == "entry":
        bundle["universe_events"].append({
            "asset_id": "SYN-C", "effective_at": "2024-01-05T14:30:00Z",
            "available_at": "2024-01-05T14:30:00Z", "action": "enter",
            "source": "synthetic://future-entry",
        })
        bundle["observations"].extend([
            dict(row, asset_id="SYN-C", value="123") for row in bundle["observations"]
            if row["asset_id"] == "SYN-A" and row["observed_at"] >= "2024-01-05"
        ])
    else:
        action = read("actions.json")["split"]["action"]
        action.update(effective_at="2024-01-05T14:30:00Z",
                      available_at="2024-01-02T12:00:00Z")
        bundle["corporate_actions"] = [action]
        for row in bundle["observations"]:
            if row["asset_id"] == "SYN-A" and row["observed_at"] >= action["effective_at"]:
                row["value"] = "50"
    assert validate_dataset(Dataset.model_validate(bundle))["status"] == "passed"
    changed = run(bundle, spec)
    for name in ("strategy", "benchmark"):
        assert changed[name]["daily"][:3] == original[name]["daily"][:3]
        for log in ("decisions", "orders", "fills", "actions"):
            before = [r for r in original[name][log] if r["at"][:10] < "2024-01-05"]
            after = [r for r in changed[name][log] if r["at"][:10] < "2024-01-05"]
            assert after == before
    if mutation == "entry":
        assert "SYN-C" in changed["strategy"]["decisions"][3]["universe"]
        assert len(changed["benchmark"]["decisions"]) == 1
        assert "SYN-C" not in changed["benchmark"]["daily"][-1]["positions"]


@pytest.mark.parametrize("scenario", ["normal", "gap", "split", "dividend", "delist", "costs"])
def test_every_row_accounting_and_fill_timing(bundle, spec, scenario):
    if scenario in {"split", "dividend", "delist"}:
        bundle, spec = action_case(bundle, spec, scenario)
    elif scenario == "gap":
        for row in bundle["observations"]:
            if row["asset_id"] == "SYN-A" and row["observed_at"].startswith("2024-01-03"):
                row["value"] = "200"
    elif scenario == "costs":
        spec["slippage_rate"] = "0.01"
    result = run(bundle, spec)
    next_open = {bundle["sessions"][i]["close_at"]: bundle["sessions"][i + 1]["open_at"]
                 for i in range(len(bundle["sessions"]) - 1)}
    for name in ("strategy", "benchmark"):
        portfolio = result[name]
        assert portfolio["daily"][0]["positions"] == {}
        for row in portfolio["daily"]:
            assert D(row["cash"]) >= 0 and D(row["receivables"]) >= 0
            assert all(type(q) is int and q > 0 for q in row["positions"].values())
            holdings = sum((q * D(row["prices"][a]) for a, q in row["positions"].items()), D(0))
            assert D(row["nav"]) == D(row["cash"]) + holdings + D(row["receivables"])
            assert D(row["receivables"]) == sum(
                (D(r["amount"]) for r in row["receivable_items"]), D(0))
            weights = sum((D(w) for w in row["actual_weights"].values()), D(0))
            total_weight = weights + D(row["cash_weight"]) + D(row["receivable_weight"])
            assert abs(total_weight - 1) < D("1e-8")
        for fill in portfolio["fills"]:
            assert type(fill["quantity"]) is int and fill["quantity"] > 0
            decision = datetime.fromisoformat(fill["decision_at"])
            expected = next_open[decision.isoformat().replace("+00:00", "Z")]
            assert datetime.fromisoformat(fill["at"]) == datetime.fromisoformat(expected)
            assert spec["start"] < fill["date"] <= spec["end"]
            assert D(fill["cash_after"]) >= 0