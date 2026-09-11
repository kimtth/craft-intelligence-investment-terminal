"""Declarative close criteria on verified saved Yahoo snapshots, not PIT datasets.

No eval, network fetch, synthetic-engine adapter, dividend credit or split event
reapplication. Integer quantities are simulated units of the current provider's
possibly split-adjusted OHLC prices, not reconstructed historical share counts.
"""

import re
from collections.abc import Callable
from datetime import date
from decimal import Context, Decimal, DecimalException, localcontext
from fractions import Fraction
from pathlib import Path
from typing import Annotated, Literal, get_args

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    model_serializer,
    model_validator,
)

from itt.indicators import _sma, _smooth
from itt.market import load_market
from itt.progress import metrics_snapshot

# Explicit public allowlist: all 27 existing expanded series, legacy RSI14,
# and OHLC. Never accept a user-supplied attribute, expression or series name.
Operand = Literal[
    "open", "high", "low", "close",
    "sma5", "sma10", "sma20", "sma50", "sma100", "sma200",
    "ema5", "ema10", "ema20", "ema50", "ema100", "ema200",
    "rsi14", "stoch9_6", "stochrsi14", "macd12_26", "macd_signal9",
    "adx14", "plus_di14", "minus_di14", "williams_r14", "cci14", "atr14",
    "highs_lows14", "ultimate7_14_28", "roc12", "bull13", "bear13",
]
SUPPORTED_OPERANDS = get_args(Operand)
_DECIMAL_PATTERN = r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$"
MAX_DEPTH, MAX_NODES, MAX_CHILDREN, MAX_COST = 12, 128, 32, 4096


def _finite(value: str) -> str:
    if len(value) > 64 or not re.fullmatch(_DECIMAL_PATTERN, value):
        raise ValueError("bounded finite decimal required")
    if abs(int(re.split("[eE]", value)[1] if "e" in value.lower() else "0")) > 100:
        raise ValueError("decimal requires at most 64 characters and exponent in [-100, 100]")
    if not Decimal(value).is_finite():
        raise ValueError("finite decimal string required")
    return value


def _session_date(value: str) -> str:
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValueError("date must be YYYY-MM-DD")
    date.fromisoformat(value)
    return value


DecimalString = Annotated[
    str, Field(strict=True, max_length=64, pattern=_DECIMAL_PATTERN), AfterValidator(_finite),
]
SessionDate = Annotated[str, Field(strict=True), AfterValidator(_session_date)]


class IndicatorOperand(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    indicator: Literal["sma", "ema", "rsi", "roc", "return", "volatility"]
    period: Annotated[int, Field(ge=1, le=252)]
    lag: Annotated[int, Field(ge=0, le=252)] = 0


class FieldOperand(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    field: Literal["open", "high", "low", "close", "volume"]
    lag: Annotated[int, Field(ge=0, le=252)] = 0


class ArithmeticOperand(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    operation: Literal["add", "subtract", "multiply", "divide"]
    left: "Expression"
    right: "Expression"


def _number(value: int | float) -> int | float:
    _finite(str(value))
    return value


Numeric = Annotated[int | float, AfterValidator(_number)]
Expression = Operand | DecimalString | Numeric | IndicatorOperand | FieldOperand | ArithmeticOperand
SeriesExpression = Operand | IndicatorOperand | FieldOperand | ArithmeticOperand


class Comparison(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    left: SeriesExpression
    op: Literal["gt", "lt", "gte", "lte", "eq", "crosses_above", "crosses_below"]
    right: Expression


class AllRules(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    all: Annotated[list["Criterion"], Field(min_length=1, max_length=MAX_CHILDREN)]


class AnyRules(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    any: Annotated[list["Criterion"], Field(min_length=1, max_length=MAX_CHILDREN)]


class NotRule(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    not_: "Criterion" = Field(alias="not")


class Criterion(RootModel[Comparison | AllRules | AnyRules | NotRule]):
    """Bound the raw tree *before* Pydantic descends into recursive unions.

    Depth starts at one and counts rules and operands (not list containers).
    Cost counts each node, weighting indicators by period and cross operands by 2.
    """

    @model_validator(mode="wrap")
    @classmethod
    def bounded(cls, value, handler):
        # A wrap validator also sees existing Criterion instances. Normalize one
        # node at a time: recursive model_dump would descend before the guard,
        # and leaving models in the tree lets Pydantic trust unvalidated children.
        normalized = {}
        stack = [(value, 1, 1, normalized, "root")]
        nodes = cost = 0
        while stack:
            node, depth, weight, parent, slot = stack.pop()
            nodes += 1
            if depth > MAX_DEPTH or nodes > MAX_NODES:
                raise ValueError("criterion exceeds depth/node limit (12/128)")
            cost += weight
            if isinstance(node, Criterion):
                node = node.root
            if isinstance(node, (Comparison, AllRules, AnyRules, NotRule,
                                 IndicatorOperand, FieldOperand, ArithmeticOperand)):
                fields = type(node).model_fields
                node = {
                    (fields[key].alias or key) if key in fields else key: item
                    for key, item in node.__dict__.items()
                    if key in node.model_fields_set or key not in fields
                }
            if isinstance(node, dict):
                node = dict(node)
                period = node.get("period")
                if "indicator" in node and type(period) is int and 1 <= period <= 252:
                    cost += weight * (period - 1)
                keys = set(node)
                if keys in ({"all"}, {"any"}):
                    key = next(iter(keys))
                    children = node[key]
                    if not isinstance(children, list) or not 1 <= len(children) <= MAX_CHILDREN:
                        raise ValueError("all/any require 1..32 rules")
                    node[key] = [None] * len(children)
                    stack.extend((child, depth + 1, weight, node[key], index)
                                 for index, child in enumerate(children))
                elif keys == {"not"}:
                    stack.append((node["not"], depth + 1, weight, node, "not"))
                elif keys in ({"left", "op", "right"}, {"operation", "left", "right"}):
                    factor = 2 if node.get("op") in ("crosses_above", "crosses_below") else 1
                    stack.extend((node[key], depth + 1, weight * factor, node, key)
                                 for key in ("left", "right"))
                elif keys not in ({"indicator", "period"}, {"indicator", "period", "lag"},
                                  {"field"}, {"field", "lag"}):
                    raise ValueError("unknown expression shape or extra keys")
            if cost > MAX_COST:
                raise ValueError("criterion exceeds cost limit (4096)")
            parent[slot] = node
        return handler(normalized["root"])

    @model_serializer
    def serialize(self):
        # Also applies when nested inside CriteriaSpec/PortfolioSpec.
        return self.root.model_dump(mode="json", by_alias=True, exclude_unset=True)

    @property
    def left(self):
        """Retain attribute access for legacy leaf Criterion callers."""
        if not isinstance(self.root, Comparison):
            raise AttributeError("compound criterion has no left operand")
        return self.root.left

    @property
    def op(self):
        if not isinstance(self.root, Comparison):
            raise AttributeError("compound criterion has no comparison operator")
        return self.root.op

    @property
    def right(self):
        if not isinstance(self.root, Comparison):
            raise AttributeError("compound criterion has no right operand")
        return self.root.right


ArithmeticOperand.model_rebuild()
Criterion.model_rebuild()


class CriteriaSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, revalidate_instances="always")

    archive_id: Annotated[str, Field(strict=True, min_length=1)]
    symbol: Annotated[str, Field(strict=True, pattern=r"^[A-Z][A-Z0-9.-]{0,9}$")]
    start: SessionDate
    end: SessionDate
    initial_cash: DecimalString
    fee_bps: DecimalString
    slippage_bps: DecimalString
    entry: Criterion
    exit: Criterion

    @model_validator(mode="after")
    def validate_ranges(self) -> "CriteriaSpec":
        if self.start >= self.end:
            raise ValueError("start must precede end; at least two saved sessions required")
        if Decimal(self.initial_cash) <= 0:
            raise ValueError("initial_cash must be positive")
        for value in (self.fee_bps, self.slippage_bps):
            if not 0 <= Decimal(value) < 10000:
                raise ValueError("fee_bps and slippage_bps must be in [0, 10000)")
        return self


def _amount(value: Fraction) -> str:
    """Exact terminating ledger decimal; only ratio metrics are rounded to 28 digits."""
    # Ledger inputs are finite decimals and operations are +, -, *, so their
    # denominators contain only 2 and 5. This precision safely covers all digits.
    precision = len(str(abs(value.numerator))) + value.denominator.bit_length() + 1
    with localcontext(Context(prec=precision)):
        return str(Decimal(value.numerator) / Decimal(value.denominator))


def _ratio(value: Fraction) -> str:
    with localcontext(Context(prec=28)):
        return str(Decimal(value.numerator) / Decimal(value.denominator))


def _custom_series(bars: list[dict], kind: str, period: int) -> list[str | None]:
    """Close-based indicators; SMA/EMA/Wilder RSI share legacy decimal28 math.

    return is a decimal fraction over p sessions; ROC is that return times 100.
    Volatility is population stddev of p simple one-session returns, unannualized.
    """
    with localcontext(Context(prec=28, Emin=-999999, Emax=999999)):
        closes = [Decimal(bar["close"]) for bar in bars]
        if kind == "sma":
            return _sma(closes, period)
        if kind == "ema":
            return [None if value is None else str(value) for value in _smooth(closes, period)]
        values: list[str | None] = [None] * len(closes)
        gain_sum = loss_sum = gain_avg = loss_avg = Decimal(0)
        returns = [
            None if previous == 0 else current / previous - 1
            for previous, current in zip(closes, closes[1:], strict=False)
        ]
        for index in range(1, len(closes)):
            if kind == "rsi":
                delta = closes[index] - closes[index - 1]
                gain, loss = max(delta, Decimal(0)), max(-delta, Decimal(0))
                if index <= period:
                    gain_sum += gain
                    loss_sum += loss
                    if index < period:
                        continue
                    gain_avg, loss_avg = gain_sum / period, loss_sum / period
                else:
                    gain_avg = (gain_avg * (period - 1) + gain) / period
                    loss_avg = (loss_avg * (period - 1) + loss) / period
                value = (Decimal(50) if gain_avg == loss_avg == 0 else Decimal(100)
                         if loss_avg == 0 else Decimal(0) if gain_avg == 0
                         else 100 - 100 / (1 + gain_avg / loss_avg))
            elif index < period:
                continue
            elif kind in ("roc", "return"):
                if closes[index - period] == 0:
                    continue
                value = closes[index] / closes[index - period] - 1
                if kind == "roc":
                    value *= 100
            else:
                window = returns[index - period:index]
                if any(value is None for value in window):
                    continue
                numbers = [value for value in window if value is not None]
                mean = sum(numbers, Decimal(0)) / period
                value = (
                    sum(((value - mean) ** 2 for value in numbers), Decimal(0)) / period
                ).sqrt()
            values[index] = str(value) if value.is_finite() else None
        return values


class _Operands:
    """Per-evaluation cache, bounded by the rule tree; never attached to the archive."""

    def __init__(self, item: dict, last: int):
        self.item, self.last = item, last
        self.cache: dict[tuple[str, int], list[str | None]] = {}

    def value(self, key, index: int) -> str | None:
        if index < 0:
            return None
        if isinstance(key, (int, float)):
            return str(key)
        if isinstance(key, FieldOperand):
            index -= key.lag
            return None if index < 0 else self.item["bars"][index].get(key.field)
        if isinstance(key, IndicatorOperand):
            index -= key.lag
            if index < 0:
                return None
            identity = (key.indicator, key.period)
            if identity not in self.cache:
                self.cache[identity] = _custom_series(
                    self.item["bars"][:self.last + 1], *identity,
                )
            return self.cache[identity][index]
        if isinstance(key, ArithmeticOperand):
            left, right = self.value(key.left, index), self.value(key.right, index)
            if left is None or right is None:
                return None
            with localcontext(Context(prec=28, Emin=-999999, Emax=999999)):
                try:
                    a, b = Decimal(left), Decimal(right)
                    if key.operation == "add":
                        value = a + b
                    elif key.operation == "subtract":
                        value = a - b
                    elif key.operation == "multiply":
                        value = a * b
                    elif b == 0:
                        return None
                    else:
                        value = a / b
                    return str(value) if value.is_finite() else None
                except DecimalException:
                    return None
        if key in ("open", "high", "low", "close"):
            return self.item["bars"][index][key]
        if key == "rsi14":
            return self.item["technicals"]["rsi14"][index]
        if key in SUPPORTED_OPERANDS:
            return self.item["technicals"]["series"][key][index]
        return key  # Already validated decimal literal.


def _operand(item: dict, key, index: int) -> str | None:
    return _Operands(item, index).value(key, index)


def _evaluate(item: dict, rule: Criterion, index: int, operands: _Operands | None = None) -> dict:
    operands = operands or _Operands(item, index)
    node = rule.root
    if not isinstance(node, Comparison):
        kind = (
            "all" if isinstance(node, AllRules) else "any" if isinstance(node, AnyRules) else "not"
        )
        children = (
            node.all if isinstance(node, AllRules)
            else node.any if isinstance(node, AnyRules) else [node.not_]
        )
        evidence = [_evaluate(item, child, index, operands) for child in children]
        results = [child["result"] for child in evidence]
        # Conservative null propagation, even under any(true, unavailable) or not.
        result = (
            None if None in results else all(results) if kind == "all"
            else any(results) if kind == "any" else not results[0]
        )
        return {
            **rule.model_dump(), "children": evidence, "result": result,
            "reason": (
                "criterion_unavailable" if result is None
                else "condition_true" if result else "condition_false"
            ),
        }
    left = operands.value(node.left, index)
    right = operands.value(node.right, index)
    cross = node.op in ("crosses_above", "crosses_below")
    previous_left = operands.value(node.left, index - 1) if cross else None
    previous_right = operands.value(node.right, index - 1) if cross else None
    result: bool | None = None
    reason = "current_operand_unavailable"
    if left is not None and right is not None:
        a, b = Decimal(left), Decimal(right)
        if not cross:
            result = {"gt": a > b, "lt": a < b, "gte": a >= b, "lte": a <= b, "eq": a == b}[node.op]
        elif previous_left is None or previous_right is None:
            reason = "previous_operand_unavailable"
        else:
            pa, pb = Decimal(previous_left), Decimal(previous_right)
            result = (pa <= pb and a > b) if node.op == "crosses_above" else (pa >= pb and a < b)
        if result is not None:
            reason = "condition_true" if result else "condition_false"
    return {
        **rule.model_dump(),
        "left_value": left, "right_value": right,
        "previous_left_value": previous_left, "previous_right_value": previous_right,
        "previous_date": item["bars"][index - 1]["date"] if cross and index > 0 else None,
        "result": result, "reason": reason,
    }


def generate_signals(
    item: dict, entry_rule: Criterion, exit_rule: Criterion, first: int, last: int,
) -> list[dict]:
    """Shared causal evaluator for single-symbol and portfolio saved-market paths."""
    rows = []
    operands = _Operands(item, last)
    for index in range(first, last + 1):
        bar = item["bars"][index]
        entry = _evaluate(item, entry_rule, index, operands)
        exit_ = _evaluate(item, exit_rule, index, operands)
        if entry["result"] is None or exit_["result"] is None:
            status, reason = "unavailable", "criterion_unavailable"
        elif exit_["result"]:
            status, reason = "exit", "exit_precedence"
        elif entry["result"]:
            status, reason = "entry", "entry_true"
        else:
            status, reason = "hold", "no_condition_true"
        rows.append({
            "date": bar["date"], "timestamp": bar["timestamp"], "status": status,
            "entry": entry["result"], "exit": exit_["result"],
            "entry_reason": entry, "exit_reason": exit_, "reason": reason,
            "next_execution_date": item["bars"][index + 1]["date"] if index < last else None,
            "execution_reason": "next_observed_open" if index < last else "end_of_window",
        })
    return rows


def _simulate(
    bars: list[dict], rows: list[dict], spec: CriteriaSpec, *, hold: bool,
    on_progress: Callable[[dict], None] | None = None,
) -> dict:
    initial = Fraction(spec.initial_cash)
    fee_rate, slip = Fraction(spec.fee_bps) / 10000, Fraction(spec.slippage_bps) / 10000
    cash, fees, peak, drawdown = initial, Fraction(0), initial, Fraction(0)
    quantity = 0
    daily, fills = [], []
    pending: str | None = None
    for index, (bar, signal) in enumerate(zip(bars, rows, strict=True)):
        if pending is not None:
            raw_open = Fraction(bar["open"])
            price = raw_open * (1 + slip if pending == "buy" else 1 - slip)
            units = int(cash // (price * (1 + fee_rate))) if pending == "buy" else quantity
            if units:
                notional = units * price
                fee = notional * fee_rate
                cash += -(notional + fee) if pending == "buy" else notional - fee
                quantity += units if pending == "buy" else -units
                fees += fee
                fills.append({
                    "signal_date": rows[index - 1]["date"], "date": bar["date"],
                    "timestamp": bar["timestamp"], "side": pending, "quantity": units,
                    "open": bar["open"], "price": _amount(price), "fee": _amount(fee),
                    "notional": _amount(notional), "cash_after": _amount(cash),
                    "quantity_after": quantity,
                    "slippage_cost": _amount(units * abs(price - raw_open)),
                })
        assert cash >= 0 and quantity >= 0
        nav = cash + quantity * Fraction(bar["close"])
        peak = max(peak, nav)
        drawdown = max(drawdown, (peak - nav) / peak)
        metrics = metrics_snapshot(initial, nav, drawdown, bars[0]["date"], bar["date"])
        daily.append({
            "date": bar["date"], **metrics, "cash": _amount(cash),
            "quantity": quantity,
        })
        pending = None
        if index < len(bars) - 1:
            if hold:
                if index == 0:
                    pending = "buy"
            elif signal["status"] == "exit" and quantity:
                pending = "sell"
            elif signal["status"] == "entry" and not quantity:
                pending = "buy"
        if on_progress is not None:
            on_progress({
                "phase": "benchmark" if hold else "strategy",
                "completed": index + 1, "total": len(bars), "date": bar["date"], **metrics,
            })
    final = Fraction(daily[-1]["nav"])
    return {
        "daily": daily, "fills": fills,
        "metrics": {
            "total_return": _ratio(final / initial - 1),
            "max_drawdown": metrics["max_drawdown"], "cagr": metrics["cagr"], "fees": _amount(fees),
            "final_nav": metrics["nav"], "initial_cash": spec.initial_cash,
            "final_cash": _amount(cash), "final_quantity": quantity,
            "fill_count": len(fills),
        },
    }


def run_market_backtest(
    store: Path | str, spec: CriteriaSpec | dict, *,
    on_progress: Callable[[dict], None] | None = None,
) -> dict:
    """Verify the latest saved archive against the exact requested ID, then simulate.

    Both date endpoints must be saved sessions; never silently move them. Indicators
    are computed by load_market on the full archive before the inclusive window is
    selected. Crosses may use the immediately preceding saved warmup bar.
    """
    spec = CriteriaSpec.model_validate(spec)
    snapshot = load_market(Path(store))
    if snapshot["manifest"]["id"] != spec.archive_id:
        raise ValueError("archive_id does not match the verified saved market archive")
    item = next((item for item in snapshot["symbols"] if item["symbol"] == spec.symbol), None)
    if item is None:
        raise ValueError("symbol is not in the verified saved market archive")
    dates = [bar["date"] for bar in item["bars"]]
    if len(dates) < 2 or len(set(dates)) != len(dates):
        raise ValueError("at least two unique saved daily sessions required")
    if spec.start not in dates or spec.end not in dates:
        raise ValueError("start and end must be exact saved session dates")
    first, last = dates.index(spec.start), dates.index(spec.end)
    if last <= first:
        raise ValueError("at least two saved sessions required in the evaluation window")
    rows = generate_signals(item, spec.entry, spec.exit, first, last)
    bars = item["bars"][first:last + 1]
    contract = {
        "version": "criteria-v1", "source": "verified_saved_yahoo_archive",
        "archive_id": spec.archive_id, "symbol": spec.symbol,
        "start": spec.start, "end": spec.end, "inclusive": True,
        "currency": item["currency"], "initial_cash": spec.initial_cash,
        "fee_bps": spec.fee_bps, "slippage_bps": spec.slippage_bps,
        "cost_bps_denominator": "10000", "cost_bps_range": "0 <= bps < 10000",
        "position": "single_symbol_long_only_all_cash_integer_simulated_price_units",
        "signal_time": "after_close", "execution": "next_observed_open_within_window",
        "timestamp_basis": "provider_bar_timestamp_not_close_or_information_availability_time",
        "warmup": "full_archive_causal_prefix_including_previous_bar_for_crosses",
        "null_policy": "either_criterion_unavailable_suppresses_both_actions",
        "precedence": "exit_before_entry_even_when_flat",
        "gt": "left > right", "lt": "left < right",
        "gte": "left >= right", "lte": "left <= right", "eq": "left == right",
        "compound_null_policy": "any_unavailable_descendant_makes_entire_rule_unavailable",
        "expression_limits": {
            "depth": MAX_DEPTH, "nodes": MAX_NODES, "children": MAX_CHILDREN, "cost": MAX_COST,
        },
        "custom_indicators": {
            "basis": "close; period 1..252 observed sessions; lag 0..252 sessions",
            "sma": "mean(last period closes); first at period-1",
            "ema": "SMA seed then alpha=2/(period+1); first at period-1",
            "rsi": "Wilder smoothing seeded by period close changes; first at period; flat=50",
            "return": "close / close[period sessions ago] - 1; decimal fraction",
            "roc": "100 * return(period); percent",
            "volatility": "population stddev of period simple one-session returns; not annualized",
        },
        "expression_arithmetic": (
            "decimal28_half_even; division_by_zero_or_nonfinite_is_unavailable"
        ),
        "crosses_above": "previous_left <= previous_right and left > right",
        "crosses_below": "previous_left >= previous_right and left < right",
        "buy_price": "open * (1 + slippage_bps / 10000)",
        "sell_price": "open * (1 - slippage_bps / 10000)",
        "fee": "quantity * execution_price * fee_bps / 10000",
        "entry_quantity": "floor(cash / (buy_price * (1 + fee_bps / 10000)))",
        "position_policy": "no_pyramiding; exit_all; zero_affordable_quantity_no_fill",
        "benchmark": "start_close_signal_then_next_open_buy_once_same_costs_and_dates",
        "valuation": "cash + quantity * close; no_final_liquidation",
        "total_return": "final_nav / initial_cash - 1; decimal_fraction",
        "cagr": (
            "(nav / initial_cash) ** (365.25 / elapsed_calendar_days) - 1; "
            "null at start or overflow"
        ),
        "max_drawdown": "max((running_peak - nav) / running_peak); initial_cash_baseline",
        "arithmetic": "exact_rational_ledger; ratio_metrics_decimal28_half_even",
        "supported_operands": list(SUPPORTED_OPERANDS),
        "price_basis": item["price_basis"], "date_basis": item["date_basis"],
        "corporate_actions": "no_split_or_dividend_event_reapplication",
    }
    return {
        "spec": spec.model_dump(mode="json"), "archive_id": spec.archive_id,
        "symbol": spec.symbol, "contract": contract, "signals": rows,
        "strategy": _simulate(bars, rows, spec, hold=False, on_progress=on_progress),
        "benchmark": _simulate(bars, rows, spec, hold=True, on_progress=on_progress),
        "limitations": [
            "Current Yahoo price snapshot, not point-in-time information or audited provenance.",
            "Survivorship bias and historical universe completeness are not resolved.",
            "Yahoo OHLC may already reflect splits; quantities are simulated adjusted-price "
            "units, not historical shares. Split events are not applied again.",
            "Price-return simulation only: dividends are not credited and adjusted-close "
            "total returns are not used. No final liquidation or hypothetical exit fee.",
            "Next observed valid bar is not a verified exchange calendar; missing bars "
            "are not filled. The latest saved bar may be incomplete.",
            "No volume, liquidity, market impact, taxes, interest or actual order execution.",
        ],
    }