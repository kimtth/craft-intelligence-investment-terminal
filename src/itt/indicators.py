"""Display-only technicals on validated, ordered market bars, not engine signals."""

from collections.abc import Mapping, Sequence
from decimal import (
    ROUND_HALF_EVEN,
    Context,
    Decimal,
    DivisionByZero,
    InvalidOperation,
    Overflow,
    localcontext,
)
from typing import Literal, TypedDict


class Technicals(TypedDict):
    version: Literal["1"]
    basis: Literal["provider_close"]
    sma20: list[str | None]
    sma50: list[str | None]
    rsi14: list[str | None]
    series: dict[str, list[str | None]]
    definitions: dict[str, str]


_PERIODS = (5, 10, 20, 50, 100, 200)
_NON_PARITY = "; local formula, no Investing.com parity guaranteed"
_DEFINITIONS = {
    **{f"sma{p}": f"mean(last {p} closes)" for p in _PERIODS},
    **{
        f"ema{p}": f"SMA{p} seed; EMA += 2/({p}+1)*(C-EMA)"
        for p in _PERIODS
    },
    "stoch9_6": "mean6(100*(C-lowestL9)/(highestH9-lowestL9)); fast K then 6 mean",
    "stochrsi14": "100*(RSI14-min14(RSI14))/(max14(RSI14)-min14(RSI14)); unsmoothed",
    "macd12_26": "SMA-seeded EMA12(C)-EMA26(C)",
    "macd_signal9": "EMA9(valid MACD12_26); first 9 MACD values form SMA seed",
    "adx14": (
        "mean14(DX) seed at index27, then Wilder14; "
        "DX=100*abs(+DI--DI)/(+DI+-DI); flat=0"
    ),
    "plus_di14": (
        "100*Wilder14(+DM)/Wilder14(TR), seed indices1..14; "
        "+DM=up if up>down,up>0 else0; up=H-prevH,down=prevL-L; flat=0"
    ),
    "minus_di14": (
        "100*Wilder14(-DM)/Wilder14(TR), seed indices1..14; "
        "-DM=down if down>up,down>0 else0; up=H-prevH,down=prevL-L; flat=0"
    ),
    "williams_r14": "-100*(highestH14-C)/(highestH14-lowestL14)",
    "cci14": (
        "TP=(H+L+C)/3; M=mean(last14 TP); "
        "CCI=(TP-M)/(0.015*mean(abs(each last14 TP-M)))"
    ),
    "atr14": "TR0=H-L; TR=max(H-L,abs(H-prevC),abs(L-prevC)); mean14 seed then Wilder14",
    "highs_lows14": "custom C-(highestH14+lowestL14)/2; explicitly not an Investing.com replica",
    "ultimate7_14_28": (
        "BP=C-min(L,prevC); TR=max(H,prevC)-min(L,prevC); from index1: "
        "100*(4*sum7(BP)/sum7(TR)+2*sum14(BP)/sum14(TR)+sum28(BP)/sum28(TR))/7"
    ),
    "roc12": "100*(C/C12barsAgo-1)",
    "bull13": "H-SMA-seeded EMA13(C)",
    "bear13": "L-SMA-seeded EMA13(C)",
}


def _mean(values: Sequence[Decimal | None]) -> Decimal | None:
    if not values or any(value is None for value in values):
        return None
    return sum((value for value in values if value is not None), Decimal(0)) / len(values)


def _rolling_mean(values: list[Decimal | None], period: int) -> list[Decimal | None]:
    return [
        None if index < period - 1 else _mean(values[index + 1 - period:index + 1])
        for index in range(len(values))
    ]


def _smooth(
    values: Sequence[Decimal | None], period: int, *, wilder: bool = False,
) -> list[Decimal | None]:
    """SMA seed over a complete window, then EMA or Wilder average; never fill gaps."""
    result: list[Decimal | None] = []
    previous = None
    alpha = Decimal(2) / (period + 1)
    for index, value in enumerate(values):
        if value is None:
            previous = None
        elif previous is None:
            if index >= period - 1:
                previous = _mean(values[index + 1 - period:index + 1])
        elif wilder:
            previous = (previous * (period - 1) + value) / period
        else:
            previous = previous + alpha * (value - previous)
        result.append(previous)
    return result


def _ratio(numerator: Decimal, denominator: Decimal) -> Decimal | None:
    return None if denominator == 0 else numerator / denominator


def _extrema(
    highs: Sequence[Decimal | None], lows: Sequence[Decimal | None], index: int, period: int,
) -> tuple[Decimal, Decimal] | None:
    if index < period - 1:
        return None
    high_window = highs[index + 1 - period:index + 1]
    low_window = lows[index + 1 - period:index + 1]
    if any(value is None for value in (*high_window, *low_window)):
        return None
    return (
        max(value for value in high_window if value is not None),
        min(value for value in low_window if value is not None),
    )


def _expanded(
    closes: list[Decimal], highs: list[Decimal | None], lows: list[Decimal | None],
    rsi: list[str | None],
) -> dict[str, list[str | None]]:
    size = len(closes)
    values: dict[str, list[Decimal | None]] = {
        key: [None] * size for key in _DEFINITIONS
    }
    for period in _PERIODS:
        values[f"sma{period}"] = [
            None if value is None else Decimal(value) for value in _sma(closes, period)
        ]
        values[f"ema{period}"] = _smooth(closes, period)
    ema12, ema26, ema13 = (_smooth(closes, period) for period in (12, 26, 13))
    values["macd12_26"] = [
        None if fast is None or slow is None else fast - slow
        for fast, slow in zip(ema12, ema26, strict=True)
    ]
    values["macd_signal9"] = _smooth(values["macd12_26"], 9)
    rsi_values = [None if value is None else Decimal(value) for value in rsi]
    fast_k: list[Decimal | None] = [None] * size
    typical: list[Decimal | None] = [
        None if high is None or low is None else (high + low + close) / 3
        for high, low, close in zip(highs, lows, closes, strict=True)
    ]
    tr: list[Decimal | None] = [None] * size
    plus_dm: list[Decimal | None] = [None] * size
    minus_dm: list[Decimal | None] = [None] * size
    bp: list[Decimal | None] = [None] * size
    ultimate_tr: list[Decimal | None] = [None] * size
    for index, close in enumerate(closes):
        high, low = highs[index], lows[index]
        bounds9 = _extrema(highs, lows, index, 9)
        if bounds9 is not None:
            top, bottom = bounds9
            fast_k[index] = _ratio(100 * (close - bottom), top - bottom)
        bounds14 = _extrema(highs, lows, index, 14)
        if bounds14 is not None:
            top, bottom = bounds14
            values["williams_r14"][index] = _ratio(-100 * (top - close), top - bottom)
            values["highs_lows14"][index] = close - (top + bottom) / 2
        rsi_bounds = _extrema(rsi_values, rsi_values, index, 14)
        current_rsi = rsi_values[index]
        if rsi_bounds is not None and current_rsi is not None:
            top, bottom = rsi_bounds
            values["stochrsi14"][index] = _ratio(
                100 * (current_rsi - bottom), top - bottom,
            )
        if index >= 12:
            relative = _ratio(close, closes[index - 12])
            values["roc12"][index] = None if relative is None else (relative - 1) * 100
        average = ema13[index]
        if average is not None:
            values["bull13"][index] = None if high is None else high - average
            values["bear13"][index] = None if low is None else low - average
        if index >= 13:
            window = typical[index - 13:index + 1]
            center = _mean(window)
            point = typical[index]
            if center is not None and point is not None:
                deviation = _mean([abs(item - center) for item in window if item is not None])
                if deviation is not None:
                    values["cci14"][index] = _ratio(point - center, Decimal("0.015") * deviation)
        if high is not None and low is not None:
            tr[index] = high - low
            if index > 0:
                previous_close = closes[index - 1]
                tr[index] = max(
                    high - low, abs(high - previous_close), abs(low - previous_close),
                )
                bp[index] = close - min(low, previous_close)
                ultimate_tr[index] = max(high, previous_close) - min(low, previous_close)
                previous_high, previous_low = highs[index - 1], lows[index - 1]
                if previous_high is not None and previous_low is not None:
                    up, down = high - previous_high, previous_low - low
                    plus_dm[index] = up if up > down and up > 0 else Decimal(0)
                    minus_dm[index] = down if down > up and down > 0 else Decimal(0)
        if index >= 28:
            ratios: list[Decimal] = []
            for period in (7, 14, 28):
                pressures = bp[index + 1 - period:index + 1]
                spans = ultimate_tr[index + 1 - period:index + 1]
                if any(value is None for value in (*pressures, *spans)):
                    break
                pressure = sum((value for value in pressures if value is not None), Decimal(0))
                span = sum((value for value in spans if value is not None), Decimal(0))
                ratio = _ratio(pressure, span)
                if ratio is None:
                    break
                ratios.append(ratio)
            if len(ratios) == 3:
                values["ultimate7_14_28"][index] = (
                    (4 * ratios[0] + 2 * ratios[1] + ratios[2]) / 7 * 100
                )
    values["stoch9_6"] = _rolling_mean(fast_k, 6)
    values["atr14"] = _smooth(tr, 14, wilder=True)
    # ADX excludes bar zero: fourteen movements seed DI at index14, then
    # fourteen DX observations (indices14..27) seed ADX at index27.
    movement_tr = [
        None if plus_dm[index] is None else value for index, value in enumerate(tr)
    ]
    average_tr = _smooth(movement_tr, 14, wilder=True)
    average_plus = _smooth(plus_dm, 14, wilder=True)
    average_minus = _smooth(minus_dm, 14, wilder=True)
    dx: list[Decimal | None] = [None] * size
    for index, (span, plus, minus) in enumerate(zip(
        average_tr, average_plus, average_minus, strict=True,
    )):
        if span is None or plus is None or minus is None:
            continue
        plus_di = Decimal(0) if span == 0 else 100 * plus / span
        minus_di = Decimal(0) if span == 0 else 100 * minus / span
        values["plus_di14"][index] = plus_di
        values["minus_di14"][index] = minus_di
        total = plus_di + minus_di
        dx[index] = Decimal(0) if total == 0 else 100 * abs(plus_di - minus_di) / total
    values["adx14"] = _smooth(dx, 14, wilder=True)
    return {
        key: [None if item is None else str(item) for item in series]
        for key, series in values.items()
    }


def _sma(closes: list[Decimal], period: int) -> list[str | None]:
    return [
        None if index + 1 < period else str(
            sum(closes[index + 1 - period:index + 1], Decimal(0)) / period
        )
        for index in range(len(closes))
    ]


def _rsi(closes: list[Decimal]) -> list[str | None]:
    values: list[str | None] = [None] * len(closes)
    gain_sum = loss_sum = Decimal(0)
    average_gain = average_loss = Decimal(0)
    for index in range(1, len(closes)):
        delta = closes[index] - closes[index - 1]
        gain, loss = max(delta, Decimal(0)), max(-delta, Decimal(0))
        if index <= 14:
            gain_sum += gain
            loss_sum += loss
            if index < 14:
                continue
            average_gain, average_loss = gain_sum / 14, loss_sum / 14
        else:
            average_gain = (average_gain * 13 + gain) / 14
            average_loss = (average_loss * 13 + loss) / 14
        if average_gain == 0 and average_loss == 0:
            value = Decimal(50)
        elif average_loss == 0:
            value = Decimal(100)
        elif average_gain == 0:
            value = Decimal(0)
        else:
            value = 100 - 100 / (1 + average_gain / average_loss)
        values[index] = str(value)
    return values


def technicals(bars: Sequence[Mapping[str, object]]) -> Technicals:
    """Derive full-bar-aligned display indicators, retaining version1 SMA/RSI.

    The caller owns OHLCV validation and chronological ordering. Only positive,
    finite price strings are accepted here; no sorting, filling, adjustment or
    display-window slicing occurs. Legacy close-only records remain supported:
    absent high/low values leave dependent observations null, never invented.
    Each value includes its current bar, never a future bar. Empty input is
    allowed. Input records are not changed. Warmups and undefined ratios are
    null, except flat RSI=50 and flat directional indicators=0.
    """
    # A fresh explicit context isolates rounding, traps and exponent limits as
    # well as precision from the caller, and never changes its flags/settings.
    with localcontext(Context(
        prec=28, rounding=ROUND_HALF_EVEN, Emin=-999999, Emax=999999,
        capitals=1, clamp=0, flags=[], traps=[InvalidOperation, DivisionByZero, Overflow],
    )):
        closes: list[Decimal] = []
        highs: list[Decimal | None] = []
        lows: list[Decimal | None] = []
        for bar in bars:
            close = bar["close"]
            if not isinstance(close, str):
                raise ValueError("expected positive finite close string")
            try:
                number = Decimal(close)
            except InvalidOperation:
                raise ValueError("expected positive finite close string") from None
            if not number.is_finite() or number <= 0:
                raise ValueError("expected positive finite close string")
            closes.append(number)
            for field, target in (("high", highs), ("low", lows)):
                if field not in bar:
                    target.append(None)
                    continue
                price = bar[field]
                if not isinstance(price, str):
                    raise ValueError(f"expected positive finite {field} string")
                try:
                    parsed = Decimal(price)
                except InvalidOperation:
                    raise ValueError(f"expected positive finite {field} string") from None
                if not parsed.is_finite() or parsed <= 0:
                    raise ValueError(f"expected positive finite {field} string")
                target.append(parsed)
        rsi = _rsi(closes)
        series = _expanded(closes, highs, lows, rsi)
        return {
            "version": "1", "basis": "provider_close",
            "sma20": _sma(closes, 20), "sma50": _sma(closes, 50),
            "rsi14": rsi,
            "series": series,
            "definitions": {key: formula + _NON_PARITY for key, formula in _DEFINITIONS.items()},
        }