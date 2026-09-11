"""Saved-Yahoo, long-only allocation with close targets and next-open execution.

This is not an adapter to the synthetic engine. Archive normalization and criteria
are shared with the single-symbol path; accounting uses exact rational values.
Only aligned saved sessions are accepted: no intersection, forward-fill or hidden
date shifts. Signals update eligibility daily; allocation trades occur on explicit
rebalance sessions. Fixed ineligible weights remain cash; momentum shares the
original allocation budget equally among eligible positive-return winners.
"""

from fractions import Fraction
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from itt.criteria import (
    SUPPORTED_OPERANDS,
    Criterion,
    DecimalString,
    SessionDate,
    _amount,
    _ratio,
    generate_signals,
)
from itt.market import load_market

Symbol = Annotated[str, Field(strict=True, pattern=r"^[A-Z][A-Z0-9.-]{0,9}$")]


class AllocationSpec(BaseModel):
    """Defaults preserve fixed weights; momentum uses 20 sessions and one winner."""

    model_config = ConfigDict(extra="forbid", strict=True)
    mode: Literal["fixed", "momentum"] = "fixed"
    lookback: Annotated[int, Field(strict=True, ge=1, le=252)] = 20
    top_n: Annotated[int, Field(strict=True, ge=1, le=10)] = 1
    minimum_return: DecimalString = "0"


class PortfolioSpec(BaseModel):
    """Shared per-asset criteria; every counts sessions or observed calendar periods.

    Calendar mode decides at the window start and first observed session of each
    selected month/quarter, executes next open, and never decides at the final bar.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    archive_id: Annotated[str, Field(strict=True, min_length=1)]
    weights: Annotated[dict[Symbol, DecimalString], Field(min_length=1, max_length=10)]
    rebalance_every: Annotated[int, Field(strict=True, ge=1)]
    start: SessionDate
    end: SessionDate
    initial_cash: DecimalString
    fee_bps: DecimalString
    slippage_bps: DecimalString
    entry: Criterion
    exit: Criterion
    allocation: AllocationSpec = Field(default_factory=AllocationSpec)
    rebalance_calendar: Literal["sessions", "monthly", "quarterly"] = "sessions"

    @model_validator(mode="after")
    def validate_ranges(self) -> "PortfolioSpec":
        if self.start >= self.end:
            raise ValueError("start must precede end; at least two saved sessions required")
        if Fraction(self.initial_cash) <= 0:
            raise ValueError("initial_cash must be positive")
        if any(not 0 <= Fraction(v) < 10000 for v in (self.fee_bps, self.slippage_bps)):
            raise ValueError("fee_bps and slippage_bps must be in [0, 10000)")
        weights = [Fraction(value) for value in self.weights.values()]
        if any(not 0 <= weight <= 1 for weight in weights) or not 0 < sum(weights) <= 1:
            raise ValueError("weights must be in [0, 1] and sum to (0, 1]")
        return self


def _aligned_window(snapshot: dict, spec: PortfolioSpec) -> tuple[dict, dict]:
    """Validate before accounting; preserve full per-asset causal warmup prefixes."""
    if snapshot["manifest"]["id"] != spec.archive_id:
        raise ValueError("archive_id does not match the verified saved market archive")
    by_symbol = {item["symbol"]: item for item in snapshot["symbols"]}
    if not set(spec.weights).issubset(by_symbol):
        raise ValueError("symbol is not in the verified saved market archive")
    bars, signals = {}, {}
    reference = None
    reference_zone = None
    reference_basis = None
    for symbol in sorted(spec.weights):
        item = by_symbol[symbol]
        dates = [bar["date"] for bar in item["bars"]]
        timestamps = [bar["timestamp"] for bar in item["bars"]]
        if len(dates) < 2 or dates != sorted(set(dates)):
            raise ValueError("at least two unique ascending saved daily sessions required")
        if timestamps != sorted(set(timestamps)):
            raise ValueError("saved timestamps must be unique and ascending")
        if spec.start not in dates or spec.end not in dates:
            raise ValueError("start and end must be exact saved session dates for every asset")
        if item["currency"] != "USD":
            raise ValueError("portfolio requires USD")
        basis = item["date_basis"]
        if reference_basis is not None and basis != reference_basis:
            raise ValueError("portfolio assets must share the same date basis")
        reference_basis = basis
        # Identical dates alone do not establish simultaneous daily trading sessions.
        # Require matching timezone and bar timestamps; these still are NOT audited
        # exchange open/close times or historical information-availability evidence.
        zone = item["timezone"]
        if reference_zone is not None and zone != reference_zone:
            raise ValueError("portfolio assets must share the same exchange timezone")
        reference_zone = zone
        first, last = dates.index(spec.start), dates.index(spec.end)
        selected = item["bars"][first:last + 1]
        calendar = [(bar["date"], bar["timestamp"]) for bar in selected]
        if reference is not None and calendar != reference:
            raise ValueError("portfolio assets must have identical saved dates and timestamps")
        reference = calendar
        bars[symbol] = selected
        signals[symbol] = generate_signals(item, spec.entry, spec.exit, first, last)
    return bars, signals


def _period(session: str, calendar: str) -> str:
    if calendar == "quarterly":
        return f"{session[:4]}-Q{(int(session[5:7]) - 1) // 3 + 1}"
    return session[:7]


def _simulate(
    bars: dict, signals: dict, spec: PortfolioSpec, *, benchmark: bool,
    momentum: dict | None = None, on_progress=None,
) -> dict:
    from itt.progress import metrics_snapshot

    symbols = sorted(bars)
    initial = Fraction(spec.initial_cash)
    cash, peak = initial, initial
    fees = slippage_cost = traded_notional = drawdown = Fraction(0)
    fee_rate = Fraction(spec.fee_bps) / 10000
    slip = Fraction(spec.slippage_bps) / 10000
    positions = dict.fromkeys(symbols, 0)
    eligible = dict.fromkeys(symbols, False)
    pending = []
    daily, fills, orders, decisions = [], [], [], []
    period_index = -1
    previous_period = None
    for index, session in enumerate(bars[symbols[0]]):
        # Frozen close-time integer targets, not targets recalculated using future
        # opens. Sell first, then alphabetical buys. Unaffordable remainders expire.
        for order in sorted(pending, key=lambda row: (row["side"] != "sell", row["symbol"])):
            symbol, side = order["symbol"], order["side"]
            bar = bars[symbol][index]
            raw = Fraction(bar["open"])
            price = raw * (1 + slip if side == "buy" else 1 - slip)
            requested = order["requested_quantity"]
            units = (min(requested, int(cash // (price * (1 + fee_rate))))
                     if side == "buy" else requested)
            if units:
                notional, fee = units * price, units * price * fee_rate
                cost = units * abs(price - raw)
                cash += -(notional + fee) if side == "buy" else notional - fee
                positions[symbol] += units if side == "buy" else -units
                fees += fee
                slippage_cost += cost
                traded_notional += notional
                fills.append({
                    **order, "date": bar["date"], "timestamp": bar["timestamp"],
                    "quantity": units, "open": bar["open"], "price": _amount(price),
                    "notional": _amount(notional), "fee": _amount(fee),
                    "slippage_cost": _amount(cost), "cash_after": _amount(cash),
                    "quantity_after": positions[symbol],
                })
            orders.append({
                **order, "date": bar["date"], "timestamp": bar["timestamp"],
                "filled_quantity": units, "remaining_quantity": requested - units,
                "status": "filled" if units == requested else "expired",
                "reason": None if units == requested else "insufficient_cash_including_fees",
            })
        pending = []
        assert cash >= 0 and all(quantity >= 0 for quantity in positions.values())
        values = {symbol: positions[symbol] * Fraction(bars[symbol][index]["close"])
                  for symbol in symbols}
        nav = cash + sum(values.values())
        peak = max(peak, nav)
        drawdown = max(drawdown, (peak - nav) / peak)
        progress = metrics_snapshot(initial, nav, drawdown, spec.start, session["date"])
        daily.append({
            "date": session["date"], "timestamp": session["timestamp"],
            **progress, "cash": _amount(cash), "positions": dict(positions),
            "market_values": {symbol: _amount(value) for symbol, value in values.items()},
            "weights": {symbol: _ratio(value / nav) for symbol, value in values.items()},
            "cash_weight": _ratio(cash / nav),
        })
        if on_progress is not None:
            on_progress({
                "phase": "benchmark" if benchmark else "strategy",
                "completed": index + 1, "total": len(bars[symbols[0]]),
                "date": session["date"], **progress,
            })
        for symbol in symbols:
            status = signals[symbol][index]["status"]
            if status == "entry":
                eligible[symbol] = True
            elif status == "exit":
                eligible[symbol] = False
        period = _period(session["date"], spec.rebalance_calendar)
        new_period = period != previous_period
        if new_period:
            period_index += 1
        previous_period = period
        due = (index % spec.rebalance_every == 0 if spec.rebalance_calendar == "sessions"
               else new_period and period_index % spec.rebalance_every == 0)
        if benchmark:
            due = index == 0
        if not due or index == len(bars[symbols[0]]) - 1:
            continue
        targets, reasons = {}, {}
        dynamic = not benchmark and spec.allocation.mode == "momentum"
        selected = []
        scores = {}
        if dynamic:
            if momentum is None:
                raise ValueError("momentum requires full-archive trailing returns")
            scores = {symbol: momentum[symbol][index] for symbol in symbols}
            selected = sorted(
                (symbol for symbol in symbols
                 if eligible[symbol] and signals[symbol][index]["status"] != "unavailable"
                 and scores[symbol] is not None
                 and scores[symbol] > max(Fraction(0), Fraction(spec.allocation.minimum_return))),
                key=lambda symbol: (-scores[symbol], symbol),
            )[:spec.allocation.top_n]
        budget = sum(Fraction(weight) for weight in spec.weights.values())
        for symbol in symbols:
            status = signals[symbol][index]["status"]
            if dynamic:
                weight = budget / len(selected) if symbol in selected else Fraction(0)
                targets[symbol] = int(nav * weight // Fraction(bars[symbol][index]["close"]))
                reasons[symbol] = "momentum_selected" if symbol in selected else "momentum_cash"
            elif not benchmark and status == "unavailable":
                targets[symbol] = positions[symbol]
                reasons[symbol] = "criterion_unavailable_freeze_quantity"
            elif benchmark or eligible[symbol]:
                targets[symbol] = int(nav * Fraction(spec.weights[symbol])
                                      // Fraction(bars[symbol][index]["close"]))
                reasons[symbol] = "benchmark_weight" if benchmark else "eligible_weight"
            else:
                targets[symbol] = 0
                reasons[symbol] = "ineligible_cash"
        decision_id = len(decisions) + 1
        decisions.append({
            "decision_id": decision_id, "date": session["date"],
            "timestamp": session["timestamp"], "nav": _amount(nav),
            "next_execution_date": bars[symbols[0]][index + 1]["date"],
            "eligible": dict.fromkeys(symbols, True) if benchmark else dict(eligible),
            "targets": targets, "reasons": reasons,
            "close_prices": {symbol: bars[symbol][index]["close"] for symbol in symbols},
            **({"selected": selected, "momentum_returns": {
                symbol: _ratio(score) if score is not None else None
                for symbol, score in scores.items()
            }} if dynamic else {}),
        })
        for symbol, target in targets.items():
            delta = target - positions[symbol]
            if delta:
                side: Literal["buy", "sell"] = "buy" if delta > 0 else "sell"
                pending.append({
                    "decision_id": decision_id, "signal_date": session["date"],
                    "symbol": symbol, "side": side, "requested_quantity": abs(delta),
                    "target_quantity": target,
                })
    final = Fraction(daily[-1]["nav"])
    return {
        "daily": daily, "fills": fills, "orders": orders, "decisions": decisions,
        "metrics": {
            "initial_cash": spec.initial_cash, "final_nav": _amount(final),
            "final_cash": _amount(cash), "final_positions": dict(positions),
            "total_return": _ratio(final / initial - 1), "max_drawdown": _ratio(drawdown),
            "cagr": progress["cagr"],
            "fees": _amount(fees), "slippage_cost": _amount(slippage_cost),
            "traded_notional": _amount(traded_notional),
            "turnover": _ratio(traded_notional / initial),
            "fill_count": len(fills), "rebalance_count": len(decisions),
        },
    }


def run_market_portfolio(store: Path | str, spec: PortfolioSpec | dict, on_progress=None) -> dict:
    """Read/verify the current real archive once, then evaluate without any writes."""
    spec = PortfolioSpec.model_validate(spec)
    snapshot = load_market(Path(store))
    bars, signals = _aligned_window(snapshot, spec)
    momentum = {}
    if spec.allocation.mode == "momentum":
        for item in snapshot["symbols"]:
            symbol = item["symbol"]
            if symbol not in spec.weights:
                continue
            full = item["bars"]
            lookback = spec.allocation.lookback
            momentum[symbol] = [
                Fraction(bar["close"]) / Fraction(full[index - lookback]["close"]) - 1
                if index >= lookback else None
                for index, bar in enumerate(full) if spec.start <= bar["date"] <= spec.end
            ]
    metadata = {
        item["symbol"]: {key: item[key] for key in ("price_basis", "date_basis", "timezone")}
        for item in snapshot["symbols"] if item["symbol"] in spec.weights
    }
    return {
        "spec": spec.model_dump(mode="json", by_alias=True), "archive_id": spec.archive_id,
        "symbols": sorted(spec.weights), "signals": signals,
        "contract": {
            "version": "portfolio-v1", "source": "verified_saved_yahoo_archive",
            "archive_id": spec.archive_id, "symbols": sorted(spec.weights),
            "asset_metadata": metadata,
            "start": spec.start, "end": spec.end, "inclusive": True, "currency": "USD",
            "initial_cash": spec.initial_cash, "fee_bps": spec.fee_bps,
            "slippage_bps": spec.slippage_bps, "weights": dict(spec.weights),
            "rebalance_every": spec.rebalance_every,
            "rebalance_calendar": spec.rebalance_calendar,
            "rebalance_schedule": (
                "window_index_0_N_2N_excluding_final_session"
                if spec.rebalance_calendar == "sessions" else
                "first_observed_session_of_every_N_observed_periods_including_window_start; "
                "close_decision_next_open; excluding_final_session"
            ),
            "signal_time": "after_close_every_saved_session",
            "eligibility": "initially_false; entry_enables; exit_disables; hold_retains",
            "precedence": "exit_before_entry_even_when_flat",
            "null_policy": (
                "retain_eligibility_and_freeze_asset_quantity_on_rebalance"
                if spec.allocation.mode == "fixed" else
                "unavailable_criterion_or_momentum_excludes_asset; unselected_targets_zero"
            ),
            "allocation": (
                "fixed_weights_not_renormalized; ineligible_weight_remains_cash"
                if spec.allocation.mode == "fixed" else
                "rank_eligible_trailing_close_returns_strictly_above_max(0,minimum_return); "
                "descending_return_then_symbol; top_n_equal_share_of_sum_original_weights; "
                "none_selected_all_cash; zero_original_weight_assets_remain_candidates"
            ),
            "allocation_spec": spec.allocation.model_dump(mode="json"),
            "momentum": "close[t]/close[t-lookback]-1; full_archive_observed_sessions",
            "target_quantity": "floor(decision_close_nav * weight / decision_close_price)",
            "execution": "frozen_integer_target_deltas_at_next_observed_open_within_window",
            "order_policy": "sells_first_then_symbol_ascending; cash_limited_remainder_expires",
            "position": "long_only_integer_simulated_price_units; no_borrowing",
            "buy_price": "open * (1 + slippage_bps / 10000)",
            "sell_price": "open * (1 - slippage_bps / 10000)",
            "fee": "quantity * execution_price * fee_bps / 10000",
            "benchmark": "same_weights_start_close_targets_next_open_buy_once_same_costs_dates",
            "valuation": "cash + sum(quantity * close); no_final_liquidation",
            "total_return": "final_nav / initial_cash - 1; decimal_fraction",
            "cagr": (
                "(nav/initial_cash)^(365.25/elapsed_calendar_days)-1; decimal_fraction; "
                "null_at_zero_elapsed_days_or_numeric_overflow; shared_metrics_snapshot"
            ),
            "max_drawdown": "max((running_peak - nav) / running_peak); initial_cash_baseline",
            "turnover": "sum(abs(fill_notional)) / initial_cash; buys_and_sells",
            "arithmetic": "exact_rational_ledger; ratio_metrics_decimal28_half_even",
            "warmup": "full_archive_causal_prefix_including_previous_bar_for_crosses",
            "alignment": (
                "exact_dates_timestamps_timezone_date_basis; no_intersection_or_forward_fill"
            ),
            "timestamp_basis": "provider_bar_timestamp_not_close_or_information_availability_time",
            "supported_operands": list(SUPPORTED_OPERANDS),
            "corporate_actions": "no_split_or_dividend_event_reapplication",
        },
        "strategy": _simulate(bars, signals, spec, benchmark=False,
                              momentum=momentum, on_progress=on_progress),
        "benchmark": _simulate(bars, signals, spec, benchmark=True, on_progress=on_progress),
        "limitations": [
            "Current Yahoo snapshot, not verified historical point-in-time information; "
            "survivorship bias and historical universe completeness remain unresolved.",
            "Price return only, no dividends or split event reapplication. Yahoo OHLC may "
            "already reflect splits; simulated units are not reconstructed historical shares.",
            "Matching saved bars are not a verified exchange calendar; shared missing "
            "sessions are not detected. The latest saved bar may be incomplete.",
            "When timezone data is unavailable, all selected assets must share the same "
            "labeled UTC fallback and exchange timezone metadata; dates may differ from "
            "exchange-local dates. See contract.asset_metadata for each asset's date basis.",
            "Signals update eligibility daily, but entries and exits trade only on the "
            "rebalance cadence. Unavailable criteria freeze quantity in fixed mode; "
            "momentum mode excludes unavailable assets and targets them to zero.",
            "Weights are targets, not guaranteed realized weights: integer rounding, "
            "price gaps, costs and alphabetical cash-limited execution cause deviations.",
            "No volume, liquidity, market impact, taxes, interest, final liquidation "
            "or actual order execution. Results are returned, not persisted as research runs.",
        ],
    }