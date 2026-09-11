"""Display-only technical votes, not model recommendations or engine orders."""

from collections.abc import Mapping
from decimal import Context, Decimal, InvalidOperation, localcontext
from typing import Literal, TypedDict

from itt.indicators import Technicals

Status = Literal["Buy", "Sell", "Neutral", "Unavailable"]


class Reason(TypedDict):
    id: Literal["trend", "macd", "rsi"]
    label: str
    status: Status
    values: dict[str, str | None]
    rule: str
    explanation: str


class Observation(TypedDict):
    status: Status
    counts: dict[Status, int]
    reasons: list[Reason]


class Signals(TypedDict):
    version: Literal["technical-vote-v1"]
    basis: Literal["provider_close"]
    rule: str
    observations: list[Observation]


_RULE = (
    "Three equal-weight votes: trend (SMA20 vs SMA50), MACD12/26 vs signal9, "
    "and RSI14 momentum (>55 Buy, <45 Sell, 45..55 inclusive Neutral). "
    "Any unavailable vote makes the overall status Unavailable; otherwise "
    "at least two Buy votes mean Buy, at least two Sell votes mean Sell, "
    "and all other combinations mean Neutral. Display-only local rule; "
    "not a validated strategy, personalized recommendation, or order."
)
_STATUSES: tuple[Status, ...] = ("Buy", "Sell", "Neutral", "Unavailable")


def _parse(value: str | None) -> Decimal | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("expected finite technical string or null")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise ValueError("expected finite technical string or null") from None
    if not number.is_finite():
        raise ValueError("expected finite technical string or null")
    return number


def _comparison(
    reason_id: Literal["trend", "macd"], label: str,
    left_key: str, right_key: str, values: dict[str, str | None],
    parsed: dict[str, Decimal | None],
) -> Reason:
    left, right = parsed[left_key], parsed[right_key]
    status: Status
    if left is None or right is None:
        status = "Unavailable"
        explanation = "Required value is null; this vote is unavailable, not neutral."
    else:
        status = "Buy" if left > right else "Sell" if left < right else "Neutral"
        operator = ">" if left > right else "<" if left < right else "="
        explanation = (
            f"{left_key} ({values[left_key]}) {operator} "
            f"{right_key} ({values[right_key]}): {status}."
        )
    return {
        "id": reason_id, "label": label, "status": status,
        "values": {left_key: values[left_key], right_key: values[right_key]},
        "rule": f"{left_key} > {right_key}: Buy; < : Sell; = : Neutral; null: Unavailable.",
        "explanation": explanation,
    }


def signals(technicals: Technicals) -> Signals:
    """Return one observation per technical row without slicing or mutation.

    Consume the existing close-only SMA20/50, RSI14 and MACD series. Required
    arrays must be aligned lists of finite Decimal strings or nulls. Missing
    keys, malformed values and incompatible metadata fail, never become votes.
    Decimal construction and comparison preserve all digits and input strings;
    a private context also isolates malformed-input flags from the caller.
    """
    if (
        not isinstance(technicals, Mapping)
        or technicals.get("version") != "1"
        or technicals.get("basis") != "provider_close"
    ):
        raise ValueError("expected version 1 provider_close technicals")
    series = technicals["series"]
    if not isinstance(series, Mapping):
        raise ValueError("expected technical series mapping")
    columns = {
        "sma20": technicals["sma20"], "sma50": technicals["sma50"],
        "rsi14": technicals["rsi14"],
        "macd12_26": series["macd12_26"], "macd_signal9": series["macd_signal9"],
    }
    if any(not isinstance(column, list) for column in columns.values()):
        raise ValueError("expected aligned technical lists")
    size = len(columns["sma20"])
    if any(len(column) != size for column in columns.values()):
        raise ValueError("expected aligned technical lists")

    observations: list[Observation] = []
    with localcontext(Context()):
        for index in range(size):
            values = {key: column[index] for key, column in columns.items()}
            # Validate every required value even when another component is null.
            parsed = {key: _parse(value) for key, value in values.items()}
            reasons = [
                _comparison("trend", "SMA trend", "sma20", "sma50", values, parsed),
                _comparison(
                    "macd", "MACD momentum", "macd12_26", "macd_signal9", values, parsed,
                ),
            ]
            rsi = parsed["rsi14"]
            rsi_status: Status = (
                "Unavailable" if rsi is None else
                "Buy" if rsi > Decimal("55") else
                "Sell" if rsi < Decimal("45") else "Neutral"
            )
            reasons.append({
                "id": "rsi", "label": "RSI momentum", "status": rsi_status,
                "values": {"rsi14": values["rsi14"]},
                "rule": "RSI14 >55: Buy; <45: Sell; 45..55 inclusive: Neutral; null: Unavailable.",
                "explanation": (
                    "RSI14 is null; this vote is unavailable, not neutral."
                    if rsi is None else
                    f"RSI14 ({values['rsi14']}) gives {rsi_status} under the momentum "
                    "thresholds, not an oversold-reversal rule."
                ),
            })
            counts: dict[Status, int] = {status: 0 for status in _STATUSES}
            for reason in reasons:
                counts[reason["status"]] += 1
            overall: Status = (
                "Unavailable" if counts["Unavailable"] else
                "Buy" if counts["Buy"] >= 2 else
                "Sell" if counts["Sell"] >= 2 else "Neutral"
            )
            observations.append({"status": overall, "counts": counts, "reasons": reasons})
    return {
        "version": "technical-vote-v1", "basis": "provider_close",
        "rule": _RULE, "observations": observations,
    }