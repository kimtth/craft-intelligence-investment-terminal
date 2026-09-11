"""Bounded synthetic daily engine: close decisions, one next-open execution attempt.

Orders are integer deltas toward fixed decision-time targets. A cash-limited
remainder expires after that attempt (logged, never silently retried). History
is append-only; pending copies alone are adjusted for corporate actions.
"""

from datetime import datetime
from decimal import ROUND_FLOOR, Context, Decimal, localcontext
from fractions import Fraction

from itt.contracts import Dataset, ResearchSpec, Session
from itt.data import observations_at, universe_at

ENGINE_VERSION = "0.2.1"
ZERO = Decimal("0")
ONE = Decimal("1")


def _json(value):
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json(item) for item in value]
    return value


def _prices(dataset: Dataset, at: datetime, field: str, assets: set[str]) -> dict:
    current = {
        row.asset_id: row.value for row in observations_at(dataset, at)
        if row.field == field and row.observed_at == at
    }
    missing = sorted(assets - current.keys())
    if missing:
        raise ValueError(f"missing exact available {field} at {at.isoformat()}: {missing}")
    return {asset: current[asset] for asset in sorted(assets)}


def _scaled(quantity: int, ratio: Decimal) -> int:
    # Fraction checks integrality exactly, even beyond Decimal's working precision.
    result = quantity * Fraction(ratio)
    if result.denominator != 1:
        raise ValueError("fractional split quantity unsupported without cash-in-lieu evidence")
    return int(result)


def _settle(state: dict, at: datetime) -> None:
    unpaid = []
    for item in state["receivables"]:
        if item["pay_at"] <= at:
            state["cash"] += item["amount"]
            state["actions"].append({
                **item, "event": "payment", "at": item["pay_at"],
                "processed_at": at, "cash_after": state["cash"],
            })
        else:
            unpaid.append(item)
    state["receivables"] = unpaid


def _apply_actions(state: dict, dataset: Dataset, session: Session) -> None:
    for action in sorted(dataset.corporate_actions,
                         key=lambda item: (item.effective_at, item.asset_id, item.action_id)):
        if action.action_id in state["applied"] or action.effective_at > session.open_at:
            continue
        if action.available_at > session.open_at:
            raise ValueError("corporate action is unavailable at its execution cutoff")
        state["applied"].add(action.action_id)
        asset = action.asset_id
        quantity = state["positions"].get(asset, 0)
        event = {
            "event": action.kind, "at": action.effective_at, "action_id": action.action_id,
            "asset_id": asset, "eligible_quantity": quantity, "source": action.source,
        }
        if action.kind == "split":
            assert action.ratio is not None
            adjusted = _scaled(quantity, action.ratio)
            changes = []
            for order in state["pending"]:
                if order["asset_id"] == asset:
                    before = order["quantity"]
                    order["quantity"] = _scaled(before, action.ratio)
                    order["target_quantity"] = _scaled(order["target_quantity"], action.ratio)
                    changes.append({"order_id": order["order_id"], "before": before,
                                    "after": order["quantity"]})
            if adjusted:
                state["positions"][asset] = adjusted
            event.update(ratio=action.ratio, quantity_after=adjusted, pending_changes=changes)
        else:
            assert action.cash_per_share is not None and action.pay_at is not None
            amount = quantity * action.cash_per_share
            receivable = {
                "action_id": action.action_id, "asset_id": asset, "kind": action.kind,
                "quantity": quantity, "amount": amount, "pay_at": action.pay_at,
            }
            if quantity:
                state["receivables"].append(receivable)
            event.update(amount=amount, cash_per_share=action.cash_per_share,
                         pay_at=action.pay_at)
            if action.kind == "delist":
                state["delisted"].add(asset)
                state["positions"].pop(asset, None)
                for order in state["pending"]:
                    if order["asset_id"] == asset:
                        state["orders"].append({
                            **order, "event": "cancelled", "at": action.effective_at,
                            "reason": "delisted", "remaining_quantity": order["quantity"],
                        })
                state["pending"] = [o for o in state["pending"] if o["asset_id"] != asset]
        state["actions"].append(event)


def _fill(state: dict, dataset: Dataset, spec: ResearchSpec, session: Session) -> None:
    pending = sorted(state["pending"], key=lambda o: (o["side"] != "sell", o["asset_id"]))
    prices = _prices(dataset, session.open_at, "open", {o["asset_id"] for o in pending})
    for order in pending:
        asset, requested = order["asset_id"], order["quantity"]
        buy = order["side"] == "buy"
        raw = prices[asset]
        price = raw * (ONE + spec.slippage_rate if buy else ONE - spec.slippage_rate)
        quantity = requested
        if buy:
            unit_cost = price * (ONE + spec.fee_rate)
            affordable = int((state["cash"] / unit_cost).to_integral_value(rounding=ROUND_FLOOR))
            quantity = min(requested, affordable)
            # Verify actual rounded arithmetic, rather than spending a rounding overshoot.
            if quantity * price + quantity * price * spec.fee_rate > state["cash"]:
                quantity = max(0, quantity - 1)
        elif requested > state["positions"].get(asset, 0):
            raise ValueError("sell order exceeds holdings")
        notional = quantity * price
        fee = notional * spec.fee_rate
        slippage = quantity * abs(price - raw)
        if quantity:
            state["cash"] += -notional - fee if buy else notional - fee
            held = state["positions"].get(asset, 0) + (quantity if buy else -quantity)
            if held:
                state["positions"][asset] = held
            else:
                state["positions"].pop(asset, None)
            state["fills"].append({
                "order_id": order["order_id"], "decision_at": order["decision_at"],
                "at": session.open_at, "date": session.session_date.isoformat(),
                "asset_id": asset, "side": order["side"], "quantity": quantity,
                "requested_quantity": requested, "raw_price": raw, "price": price,
                "notional": notional, "fee": fee, "slippage": slippage,
                "cash_after": state["cash"], "position_after": held,
            })
        state["orders"].append({
            **order, "event": "executed" if quantity == requested else "expired",
            "at": session.open_at, "filled_quantity": quantity,
            "remaining_quantity": requested - quantity,
            "reason": None if quantity == requested else "insufficient_cash_including_fees",
        })
    state["pending"] = []
    if state["cash"] < ZERO:
        raise ValueError("negative cash is unsupported")


def _weights(spec: ResearchSpec, active: tuple[str, ...], benchmark: bool) -> dict:
    if benchmark or spec.allocation == "equal":
        return {asset: ONE / len(active) for asset in active} if active else {}
    return {asset: spec.weights[asset] for asset in active if spec.weights.get(asset, ZERO) > ZERO}


def _decide(state: dict, spec: ResearchSpec, session: Session, active: tuple[str, ...],
            weights: dict, prices: dict, nav: Decimal, equal: bool) -> None:
    targets = {}
    for asset in sorted(set(weights) | state["positions"].keys()):
        # Never floor a rounded repeating equal weight (e.g. 1/3) into one fewer share.
        weight = (Fraction(1, len(weights)) if equal and asset in weights
                  else Fraction(weights.get(asset, ZERO)))
        exact = Fraction(nav) * weight / Fraction(prices[asset])
        targets[asset] = exact.numerator // exact.denominator
    state["decisions"].append({
        "at": session.close_at, "date": session.session_date.isoformat(), "nav": nav,
        "universe": list(active), "weights": weights, "prices": prices, "targets": targets,
        "weight_rule": "equal_exact_ratio" if equal else "fixed_decimal",
    })
    for asset, target in targets.items():
        delta = target - state["positions"].get(asset, 0)
        if not delta:
            continue
        state["sequence"] += 1
        order = {
            "order_id": f"{state['name']}-{state['sequence']}", "asset_id": asset,
            "decision_at": session.close_at, "at": session.close_at,
            "event": "created", "side": "buy" if delta > 0 else "sell",
            "quantity": abs(delta), "target_quantity": target, "decision_nav": nav,
            "decision_close": prices[asset], "target_weight": weights.get(asset, ZERO),
        }
        state["orders"].append(order)
        state["pending"].append(dict(order))


def _portfolio(dataset: Dataset, spec: ResearchSpec, benchmark: bool) -> dict:
    sessions = [s for s in dataset.sessions if spec.start <= s.session_date <= spec.end]
    start_index = list(dataset.sessions).index(sessions[0])
    previous_close = dataset.sessions[start_index - 1].close_at if start_index else None
    historical = [a for a in dataset.corporate_actions
                  if previous_close is not None and a.effective_at <= previous_close]
    state = {
        "name": "benchmark" if benchmark else "strategy", "sequence": 0,
        "cash": spec.initial_cash, "positions": {}, "receivables": [], "pending": [],
        "applied": {a.action_id for a in historical},
        "delisted": {a.asset_id for a in historical if a.kind == "delist"},
        "daily": [], "decisions": [], "orders": [], "fills": [], "actions": [],
    }
    for index, session in enumerate(sessions):
        _apply_actions(state, dataset, session)
        _settle(state, session.open_at)
        _fill(state, dataset, spec, session)
        _settle(state, session.close_at)
        decide = index == 0 if benchmark else index % spec.rebalance_every == 0
        active = tuple(a for a in universe_at(dataset, session.close_at)
                       if a not in state["delisted"])
        weights = _weights(spec, active, benchmark) if decide else {}
        prices = _prices(dataset, session.close_at, "close",
                         set(state["positions"]) | set(weights))
        values = {a: q * prices[a] for a, q in sorted(state["positions"].items())}
        receivables = sum((r["amount"] for r in state["receivables"]), ZERO)
        nav = state["cash"] + sum(values.values(), ZERO) + receivables
        row = {
            "date": session.session_date.isoformat(), "cash": state["cash"],
            "positions": dict(sorted(state["positions"].items())),
            "prices": {a: prices[a] for a in values}, "position_values": values,
            "receivables": receivables,
            "receivable_items": [dict(r) for r in state["receivables"]], "nav": nav,
            "actual_weights": {a: value / nav if nav else ZERO for a, value in values.items()},
            "cash_weight": state["cash"] / nav if nav else ZERO,
            "receivable_weight": receivables / nav if nav else ZERO,
        }
        state["daily"].append(row)
        if decide:
            _decide(state, spec, session, active, weights, prices, nav,
                    benchmark or spec.allocation == "equal")
    peak, drawdown = spec.initial_cash, ZERO
    for row in state["daily"]:
        peak = max(peak, row["nav"])
        drawdown = max(drawdown, ONE - row["nav"] / peak)
    fees = sum((f["fee"] for f in state["fills"]), ZERO)
    slippage = sum((f["slippage"] for f in state["fills"]), ZERO)
    traded = sum((f["notional"] for f in state["fills"]), ZERO)
    return {
        "daily": state["daily"], "decisions": state["decisions"],
        "orders": state["orders"], "fills": state["fills"], "actions": state["actions"],
        "pending_orders": state["pending"],
        "metrics": {
            "initial_nav": spec.initial_cash, "final_nav": state["daily"][-1]["nav"],
            "total_return": state["daily"][-1]["nav"] / spec.initial_cash - ONE,
            "max_drawdown": drawdown, "turnover": traded / spec.initial_cash,
            "traded_notional": traded, "fees": fees, "slippage": slippage,
            "total_costs": fees + slippage,
        },
    }


def run_backtest(dataset: Dataset, spec: ResearchSpec) -> dict:
    """Run both portfolios without IO, global context changes, or input mutation.

    Exact current PIT prices are mandatory; this is not a real-archive engine.
    All monetary/rate outputs are Decimal strings, and quantities are integers.
    """
    # Lazy import permits research's integration entry point to import this module.
    from itt.research import validate_spec

    with localcontext(Context(prec=28)):
        dataset = Dataset.model_validate(dataset)
        spec = ResearchSpec.model_validate(spec)
        validate_spec(spec, dataset)
        seen = set()
        for action in dataset.corporate_actions:
            key = (action.asset_id, action.effective_at)
            if key in seen:
                raise ValueError("multiple corporate action kinds at one asset/effective timestamp")
            seen.add(key)
        return _json({
            "schema_version": "0.1", "engine_version": ENGINE_VERSION,
            "spec": spec.model_dump(mode="json"), "kind": dataset.manifest.kind,
            "synthetic": True, "external_audit": False,
            "strategy": _portfolio(dataset, spec, False),
            "benchmark": _portfolio(dataset, spec, True),
        })