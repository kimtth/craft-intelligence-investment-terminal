"""Read-only saved-price correlation and structured retrospective event studies.

No NLP, trading, archive writes, missing-session intersection or forward filling.
Correlation samples only within the requested window; trigger warmup may use the
full causal archive prefix, but outcomes never extend past the requested end.
"""

from datetime import date
from decimal import Context, Decimal, localcontext
from fractions import Fraction
from pathlib import Path
from statistics import median
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from itt.criteria import Criterion, SessionDate, _evaluate, _Operands, _ratio
from itt.market import load_market

Symbol = Annotated[str, Field(strict=True, pattern=r"^[A-Z][A-Z0-9.-]{0,9}$")]
Horizon = Annotated[int, Field(strict=True, ge=1, le=60)]


class _WindowSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    archive_id: Annotated[str, Field(strict=True, min_length=1)]
    start: SessionDate
    end: SessionDate

    @model_validator(mode="after")
    def validate_window(self):
        if self.start >= self.end:
            raise ValueError("start must precede end; at least two saved sessions required")
        return self


class CorrelationSpec(_WindowSpec):
    symbols: Annotated[list[Symbol], Field(min_length=2, max_length=10)]
    frequency: Literal["daily", "weekly", "monthly"] = "daily"

    @model_validator(mode="after")
    def validate_symbols(self):
        if len(set(self.symbols)) != len(self.symbols):
            raise ValueError("duplicate symbols")
        return self


class TriggerSpec(_WindowSpec):
    model_config = ConfigDict(revalidate_instances="always")

    symbol: Symbol
    target_symbol: Symbol
    condition: Criterion
    horizons: Annotated[list[Horizon], Field(min_length=1, max_length=60)] = Field(
        default_factory=lambda: [1, 5, 20],
    )

    @model_validator(mode="after")
    def validate_horizons(self):
        if len(set(self.horizons)) != len(self.horizons):
            raise ValueError("duplicate horizons")
        return self


def _load_window(store: Path | str, spec: _WindowSpec, symbols: list[str]) -> tuple[dict, dict]:
    snapshot = load_market(Path(store))
    if snapshot["manifest"]["id"] != spec.archive_id:
        raise ValueError("archive_id does not match the verified saved market archive")
    items = {item["symbol"]: item for item in snapshot["symbols"]}
    if not set(symbols).issubset(items):
        raise ValueError("symbol is not in the verified saved market archive")
    reference = metadata = None
    windows = {}
    for symbol in symbols:
        item = items[symbol]
        bars = item["bars"]
        dates = [bar["date"] for bar in bars]
        stamps = [bar["timestamp"] for bar in bars]
        if len(dates) < 2 or dates != sorted(set(dates)):
            raise ValueError("at least two unique ascending saved daily sessions required")
        if stamps != sorted(set(stamps)):
            raise ValueError("saved timestamps must be unique and ascending")
        if spec.start not in dates or spec.end not in dates:
            raise ValueError("start and end must be exact saved session dates for every asset")
        current = (item["timezone"], item["date_basis"], item["currency"])
        if metadata is not None and metadata != current:
            raise ValueError("assets must share timezone, date basis and currency")
        metadata = current
        first, last = dates.index(spec.start), dates.index(spec.end)
        selected = bars[first:last + 1]
        calendar = [(bar["date"], bar["timestamp"]) for bar in selected]
        if reference is not None and reference != calendar:
            raise ValueError("assets must have identical saved dates and timestamps")
        reference = calendar
        windows[symbol] = {"item": item, "first": first, "last": last, "bars": selected}
    return snapshot, windows


def _contract(spec: _WindowSpec, windows: dict) -> dict:
    return {
        "source": "verified_saved_yahoo_archive", "archive_id": spec.archive_id,
        "start": spec.start, "end": spec.end, "inclusive": True,
        "alignment": "exact_endpoints_dates_timestamps_timezone_date_basis_currency; no_fill",
        "timestamp_basis": "provider_bar_timestamp_not_close_or_information_availability_time",
        "asset_metadata": {
            symbol: {key: window["item"][key]
                     for key in ("currency", "timezone", "date_basis", "price_basis")}
            for symbol, window in windows.items()
        },
    }


_LIMITATIONS = [
    "Current Yahoo price snapshot, not verified historical point-in-time availability; "
    "survivorship bias and historical universe completeness remain unresolved.",
    "Price returns only, not dividend total returns; no split or dividend reapplication.",
    "Aligned saved sessions are not a verified exchange calendar; shared missing sessions "
    "are undetected and the latest saved bar may be incomplete.",
]


def _sample_indices(bars: list[dict], frequency: str) -> list[int]:
    if frequency == "daily":
        return list(range(len(bars)))
    ends = {}
    for index, bar in enumerate(bars):
        day = date.fromisoformat(bar["date"])
        key = day.isocalendar()[:2] if frequency == "weekly" else (day.year, day.month)
        ends[key] = index
    return list(ends.values())


def _pearson(a: list[Fraction], b: list[Fraction]) -> tuple[float | None, str | None]:
    n = len(a)
    if n < 2:
        return None, "insufficient_returns"
    sa, sb = sum(a), sum(b)
    va = n * sum(x * x for x in a) - sa * sa
    vb = n * sum(x * x for x in b) - sb * sb
    if va == 0 or vb == 0:
        return None, "zero_variance"
    covariance = n * sum(x * y for x, y in zip(a, b, strict=True)) - sa * sb
    # Compute a bounded exact rational before sqrt to avoid float overflow or
    # catastrophic cancellation for very small/large decimal price changes.
    squared = covariance * covariance / (va * vb)
    with localcontext(Context(prec=28)):
        magnitude = (Decimal(squared.numerator) / Decimal(squared.denominator)).sqrt()
    return float(magnitude) * (-1 if covariance < 0 else 1), None


def run_market_correlation(store: Path | str, spec: CorrelationSpec | dict) -> dict:
    spec = CorrelationSpec.model_validate(spec)
    _, windows = _load_window(store, spec, spec.symbols)
    bars = windows[spec.symbols[0]]["bars"]
    indices = _sample_indices(bars, spec.frequency)
    series = {}
    for symbol in spec.symbols:
        closes = [Fraction(windows[symbol]["bars"][index]["close"]) for index in indices]
        series[symbol] = [current / previous - 1
                          for previous, current in zip(closes, closes[1:], strict=False)]
    matrix, reasons = [], []
    for left in spec.symbols:
        values, why = [], []
        for right in spec.symbols:
            value, reason = _pearson(series[left], series[right])
            values.append(value)
            why.append(reason)
        matrix.append(values)
        reasons.append(why)
    return {
        "spec": spec.model_dump(mode="json", by_alias=True), "archive_id": spec.archive_id,
        "symbols": list(spec.symbols), "matrix": matrix, "reasons": reasons,
        "observations": max(0, len(indices) - 1),
        "sample_dates": [bars[index]["date"] for index in indices],
        "returns": {symbol: [_ratio(value) for value in values]
                    for symbol, values in series.items()},
        "contract": {
            **_contract(spec, windows), "version": "correlation-v1",
            "frequency": spec.frequency, "method": "pearson_simple_close_price_returns",
            "sampling": "last_observed_close_per_ISO_week_or_calendar_month_strictly_within_window",
            "partial_periods": "included; no_pre_window_base_price_or_post_window_period_end",
            "null_policy": "fewer_than_two_returns_or_either_zero_variance; see_reasons_matrix",
            "observations": "common_return_count_for_every_matrix_cell",
            "arithmetic": "exact_rational_moments; decimal28_sqrt; JSON_number_coefficients",
        },
        "limitations": [*_LIMITATIONS,
                        "Correlation is descriptive, not causation or a forecast. Partial "
                        "boundary periods can have shorter return intervals."],
    }


def run_market_trigger(store: Path | str, spec: TriggerSpec | dict) -> dict:
    spec = TriggerSpec.model_validate(spec)
    symbols = list(dict.fromkeys([spec.symbol, spec.target_symbol]))
    _, windows = _load_window(store, spec, symbols)
    source, target = windows[spec.symbol], windows[spec.target_symbol]
    bars = target["bars"]
    events, signals = [], []
    samples = {h: [] for h in spec.horizons}
    intervals = {h: [] for h in spec.horizons}
    operands = _Operands(source["item"], source["last"])
    for index, bar in enumerate(source["bars"]):
        evaluation = _evaluate(source["item"], spec.condition, source["first"] + index, operands)
        signals.append({"date": bar["date"], "timestamp": bar["timestamp"], **evaluation})
        if evaluation["result"] is not True:
            continue
        outcomes = []
        for horizon in spec.horizons:
            if index + horizon >= len(bars):
                outcomes.append({"horizon": horizon, "return": None,
                                 "reason": "insufficient_future_sessions_within_window",
                                 "entry_date": None, "exit_date": None})
                continue
            entry, exit_ = bars[index + 1], bars[index + horizon]
            value = Fraction(exit_["close"]) / Fraction(entry["open"]) - 1
            samples[horizon].append(value)
            intervals[horizon].append((index + 1, index + horizon))
            outcomes.append({
                "horizon": horizon, "return": _ratio(value), "reason": None,
                "entry_date": entry["date"], "exit_date": exit_["date"],
                "entry_open": entry["open"], "exit_close": exit_["close"],
            })
        events.append({"date": bar["date"], "timestamp": bar["timestamp"],
                       "condition": evaluation, "outcomes": outcomes})
    summary = []
    for horizon, values in samples.items():
        spans = intervals[horizon]
        overlap = any(right[0] <= left[1]
                  for left, right in zip(spans, spans[1:], strict=False))
        summary.append({
            "horizon": horizon, "n": len(values),
            "mean": _ratio(sum(values) / len(values)) if values else None,
            "median": _ratio(median(values)) if values else None,
            "win_rate": _ratio(Fraction(sum(value > 0 for value in values), len(values)))
            if values else None,
            "reason": None if values else "no_complete_outcomes",
            "overlapping_samples": overlap,
        })
    return {
        "spec": spec.model_dump(mode="json", by_alias=True), "archive_id": spec.archive_id,
        "symbol": spec.symbol, "target_symbol": spec.target_symbol,
        "analysis_type": "retrospective_event_study_not_tradable_backtest",
        "signals": signals, "events": events, "event_count": len(events), "summary": summary,
        "contract": {
            **_contract(spec, windows), "version": "trigger-v1",
            "condition_time": "after_close; full_archive_causal_prefix_warmup",
            "events": "every_true_session; not_only_false_to_true_transitions",
            "outcome": "target_close[t+h]/target_open[t+1]-1; h_observed_sessions_after_trigger",
            "horizon_one": "next_session_open_to_same_session_close",
            "window_policy": "no_outcome_or_entry_beyond_end; incomplete_outcomes_null_not_zero",
            "statistics": "complete_outcomes_only; decimal_fraction_strings; win_is_return_gt_zero",
            "future_data": "retrospective_outcomes_only; never_used_to_select_events",
            "costs": "no_fees_slippage_or_execution_model; not_a_tradable_backtest",
        },
        "limitations": [*_LIMITATIONS,
                        "Retrospective event study, not a tradable backtest or causal evidence. "
                        "Future prices appear only in explicitly labeled outcomes.",
                        "Overlapping samples are dependent, not independent trials; no "
                        "significance or multiple-testing adjustment is provided."],
        "warnings": (["overlapping_samples"] if any(row["overlapping_samples"] for row in summary)
                     else []),
    }