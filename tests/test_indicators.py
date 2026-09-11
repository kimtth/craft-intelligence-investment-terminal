"""Independent numeric oracles for display-only, current-inclusive technicals."""

from copy import deepcopy
from decimal import ROUND_DOWN, ROUND_HALF_EVEN, ROUND_UP, Decimal, Inexact, localcontext
from fractions import Fraction

import pytest

from itt.indicators import technicals

SERIES = ("sma20", "sma50", "rsi14")
PERIODS = (5, 10, 20, 50, 100, 200)
FIRST_VALID = {
    **{f"sma{period}": period - 1 for period in PERIODS},
    **{f"ema{period}": period - 1 for period in PERIODS},
    "stoch9_6": 13, "stochrsi14": 27,
    "macd12_26": 25, "macd_signal9": 33,
    "adx14": 27, "plus_di14": 14, "minus_di14": 14,
    "williams_r14": 13, "cci14": 13, "atr14": 13,
    "highs_lows14": 13, "ultimate7_14_28": 28,
    "roc12": 12, "bull13": 12, "bear13": 12,
}
WILDER_CLOSES = (
    "44.34", "44.09", "44.15", "43.61", "44.33", "44.83", "45.10",
    "45.42", "45.84", "46.08", "45.89", "46.03", "45.61", "46.28",
    "46.28", "46.00", "46.03", "46.41", "46.22", "45.64", "46.21",
)


def bars(closes):
    return [{"close": str(close)} for close in closes]


@pytest.mark.parametrize("length", [0, 1, 13, 14, 15, 19, 20, 49, 50, 65])
def test_exact_schema_alignment_and_warmups(length):
    value = technicals(bars(range(1, length + 1)))
    assert set(value) == {"version", "basis", *SERIES, "series", "definitions"}
    assert value["version"] == "1" and value["basis"] == "provider_close"
    for key, first in zip(SERIES, [19, 49, 14], strict=True):
        assert len(value[key]) == length
        assert value[key][:first] == [None] * min(length, first)
        assert all(isinstance(item, str) for item in value[key][first:])


@pytest.mark.parametrize("closes, expected", [
    (range(1, 66), "100"), (range(65, 0, -1), "0"), (["42.125"] * 65, "50"),
])
def test_rsi_rising_falling_flat(closes, expected):
    assert technicals(bars(closes))["rsi14"] == [None] * 14 + [expected] * 51


def test_known_wilder_example_seed_and_recursive_smoothing():
    # Classic Wilder worksheet: seed from the first 14 deltas, then retain
    # unrounded averages. Published two-decimal RSI oracle, not a rolling RSI.
    values = technicals(bars(WILDER_CLOSES))["rsi14"]
    assert values[:14] == [None] * 14
    with localcontext() as context:
        context.prec = 28
        context.rounding = ROUND_HALF_EVEN
        rounded = [str(Decimal(value).quantize(Decimal("0.01"))) for value in values[14:]]
    assert rounded == ["70.46", "66.25", "66.48", "69.35", "66.29", "57.92", "62.88"]
    # Independently summed seed gains/losses are 3.34/1.40; the common /14
    # cancels, so exact RSI = 100 * 3.34 / (3.34 + 1.40) = 16700/237.
    # At this two-integer-digit value, Decimal precision 28 has ULP 1e-26.
    # Allow one ULP for intermediate rounding, not a different RSI formula.
    # Fraction keeps the reference and error comparison exact.
    assert abs(Fraction(values[14]) - Fraction(16700, 237)) <= Fraction(1, 10**26)


def test_sma_arithmetic_sequence_oracle_and_current_inclusive_window():
    values = technicals(bars(range(1, 61)))
    assert values["sma20"] == [None] * 19 + [f"{n}.5" for n in range(10, 51)]
    assert values["sma50"] == [None] * 49 + [f"{n}.5" for n in range(25, 36)]
    # A final impulse belongs in the current window, not the previous value.
    impulse = technicals(bars(["10"] * 50 + ["110"]))
    assert impulse["sma20"][-2:] == ["10", "15"]
    assert impulse["sma50"][-2:] == ["10", "12"]


def test_decimal_strings_never_lose_sub_float_precision():
    close = "100.000000000000000001"
    value = technicals(bars([close] * 50))
    assert value["sma20"][19:] == [close] * 31
    assert value["sma50"][49] == close
    assert value["rsi14"][14:] == ["50"] * 36


def test_every_prefix_is_invariant_to_future_append_and_mutation():
    records = bars(WILDER_CLOSES * 4)
    original = deepcopy(records)
    full = technicals(records)
    for end in range(len(records) + 1):
        prefix = technicals(records[:end])
        mutated = technicals(records[:end] + bars(range(1000, 1017)))
        for key in SERIES:
            assert prefix[key] == full[key][:end] == mutated[key][:end]
    assert records == original


@pytest.mark.parametrize("rounding", [ROUND_UP, ROUND_DOWN])
def test_caller_decimal_context_cannot_change_output_or_be_changed(rounding):
    records = bars(WILDER_CLOSES * 3)
    expected = technicals(records)
    with localcontext() as context:
        context.prec = 3
        context.rounding = rounding
        context.Emax = 1
        context.Emin = -1
        context.capitals = 0
        context.clamp = 1
        context.traps[Inexact] = True
        context.clear_flags()
        assert technicals(records) == expected
        assert context.prec == 3 and context.rounding == rounding
        assert context.Emax == 1 and context.Emin == -1
        assert context.capitals == 0 and context.clamp == 1
        assert context.traps[Inexact] is True
        assert not any(context.flags.values())


@pytest.mark.parametrize("close", [None, 100, 1.25, True, "NaN", "Infinity", "0", "-1", "bad"])
def test_invalid_close_values_rejected(close):
    with pytest.raises(ValueError, match="expected positive finite close string"):
        technicals([{"close": close}])


def ohlc(closes, spread=2):
    return [
        {"close": str(close), "high": str(close + spread), "low": str(close - spread)}
        for close in closes
    ]


def varied_bars(length):
    # Deterministic test-only fixture with gaps, unequal ranges and reversals.
    return [
        {
            "close": str(100 + (index * 17 % 31) + index // 5),
            "high": str(103 + (index * 17 % 31) + index // 5 + index % 4),
            "low": str(98 + (index * 17 % 31) + index // 5 - index % 3),
        }
        for index in range(length)
    ]


def rational_smoothing(samples, period, alpha):
    """Independent closed-form geometric weights, not the production recurrence."""
    result = [None] * len(samples)
    start = next((index for index, sample in enumerate(samples) if sample is not None), None)
    if start is None or start + period > len(samples):
        return result
    seed_index = start + period - 1
    seed = sum(samples[start:seed_index + 1], Fraction(0)) / period
    decay = 1 - alpha
    for index in range(seed_index, len(samples)):
        result[index] = seed * decay ** (index - seed_index) + sum(
            (
                alpha * samples[j] * decay ** (index - j)
                for j in range(seed_index + 1, index + 1)
            ),
            Fraction(0),
        )
    return result


def rational_oracle(records):
    """Exact Fraction OHLC oracle; no indicator implementation helpers imported."""
    c = [Fraction(record["close"]) for record in records]
    h = [Fraction(record["high"]) for record in records]
    lows = [Fraction(record["low"]) for record in records]
    size = len(c)
    expected = {key: [None] * size for key in FIRST_VALID}
    for period in PERIODS:
        for index in range(period - 1, size):
            expected[f"sma{period}"][index] = sum(c[index + 1 - period:index + 1]) / period
        expected[f"ema{period}"] = rational_smoothing(c, period, Fraction(2, period + 1))
    e12, e26, e13 = (
        rational_smoothing(c, period, Fraction(2, period + 1)) for period in (12, 26, 13)
    )
    for index in range(25, size):
        expected["macd12_26"][index] = e12[index] - e26[index]
    expected["macd_signal9"] = rational_smoothing(
        expected["macd12_26"], 9, Fraction(1, 5),
    )
    deltas = [c[index] - c[index - 1] for index in range(1, size)]
    gains = rational_smoothing([None] + [max(x, 0) for x in deltas], 14, Fraction(1, 14))
    losses = rational_smoothing([None] + [max(-x, 0) for x in deltas], 14, Fraction(1, 14))
    rsi = [None] * size
    for index in range(14, size):
        total = gains[index] + losses[index]
        rsi[index] = Fraction(50) if total == 0 else 100 * gains[index] / total
    typical = [(high + low + close) / 3 for high, low, close in zip(h, lows, c, strict=True)]
    fast = [None] * size
    tr = [h[0] - lows[0]] if size else []
    movements_plus, movements_minus = [None], [None]
    bp, spans = [None], [None]
    for index in range(size):
        if index >= 8:
            top, bottom = max(h[index - 8:index + 1]), min(lows[index - 8:index + 1])
            fast[index] = None if top == bottom else 100 * (c[index] - bottom) / (top - bottom)
        if index >= 13:
            fast_window = fast[index - 5:index + 1]
            if all(value is not None for value in fast_window):
                expected["stoch9_6"][index] = sum(fast_window) / 6
            top, bottom = max(h[index - 13:index + 1]), min(lows[index - 13:index + 1])
            expected["williams_r14"][index] = (
                None if top == bottom else 100 * (c[index] - top) / (top - bottom)
            )
            expected["highs_lows14"][index] = c[index] - (top + bottom) / 2
            window = typical[index - 13:index + 1]
            center = sum(window) / 14
            deviation = sum(abs(point - center) for point in window) / 14
            expected["cci14"][index] = (
                None if deviation == 0 else (typical[index] - center) * 200 / (3 * deviation)
            )
        if index >= 27:
            top, bottom = max(rsi[index - 13:index + 1]), min(rsi[index - 13:index + 1])
            expected["stochrsi14"][index] = (
                None if top == bottom else 100 * (rsi[index] - bottom) / (top - bottom)
            )
        if index >= 12:
            expected["roc12"][index] = 100 * (c[index] - c[index - 12]) / c[index - 12]
            expected["bull13"][index] = h[index] - e13[index]
            expected["bear13"][index] = lows[index] - e13[index]
        if index > 0:
            top, bottom = max(h[index], c[index - 1]), min(lows[index], c[index - 1])
            tr.append(top - bottom)
            bp.append(c[index] - bottom)
            spans.append(top - bottom)
            up, down = h[index] - h[index - 1], lows[index - 1] - lows[index]
            movements_plus.append(max(up, 0) if up > down else Fraction(0))
            movements_minus.append(max(down, 0) if down > up else Fraction(0))
        if index >= 28:
            denominators = [sum(spans[index + 1 - p:index + 1]) for p in (7, 14, 28)]
            if all(denominators):
                expected["ultimate7_14_28"][index] = sum(
                    weight * sum(bp[index + 1 - p:index + 1]) / denominator
                    for p, weight, denominator in zip(
                        (7, 14, 28), (4, 2, 1), denominators, strict=True,
                    )
                ) * Fraction(100, 7)
    expected["atr14"] = rational_smoothing(tr, 14, Fraction(1, 14))
    atr_movement = rational_smoothing([None] + tr[1:], 14, Fraction(1, 14))
    plus = rational_smoothing(movements_plus, 14, Fraction(1, 14))
    minus = rational_smoothing(movements_minus, 14, Fraction(1, 14))
    dx = [None] * size
    for index in range(14, size):
        span = atr_movement[index]
        expected["plus_di14"][index] = 100 * plus[index] / span if span else Fraction(0)
        expected["minus_di14"][index] = 100 * minus[index] / span if span else Fraction(0)
        total = plus[index] + minus[index]
        dx[index] = 100 * abs(plus[index] - minus[index]) / total if total else Fraction(0)
    expected["adx14"] = rational_smoothing(dx, 14, Fraction(1, 14))
    return expected


def assert_rational(actual, expected):
    if expected is None:
        assert actual is None
    else:
        assert isinstance(actual, str)
        # Exact rational comparison permits Decimal28 intermediate rounding,
        # but is tighter than binary-float precision and any formula difference.
        assert abs(Fraction(actual) - expected) <= max(1, abs(expected)) * Fraction(1, 10**23)


@pytest.mark.parametrize("length", [0, 1, 12, 13, 14, 15, 26, 27, 28, 29, 33, 34, 199, 200, 215])
def test_expanded_exact_schema_first_valid_and_definitions(length):
    result = technicals(varied_bars(length))
    assert set(result) == {"version", "basis", *SERIES, "series", "definitions"}
    assert result["version"] == "1"
    assert result["basis"] == "provider_close"
    assert set(result["series"]) == set(FIRST_VALID)
    assert set(result["definitions"]) == set(FIRST_VALID)
    for key, first in FIRST_VALID.items():
        values = result["series"][key]
        assert len(values) == length
        assert values[:first] == [None] * min(first, length)
        assert all(
            isinstance(value, str) and Decimal(value).is_finite() for value in values[first:]
        )
        assert "Investing.com" in result["definitions"][key]
        assert "no Investing.com parity guaranteed" in result["definitions"][key]
    for key in ("sma20", "sma50"):
        assert result[key] == result["series"][key]
    assert "custom" in result["definitions"]["highs_lows14"]
    assert "not an Investing.com replica" in result["definitions"]["highs_lows14"]


def test_all_expanded_values_against_independent_exact_rational_oracles():
    records = varied_bars(72)
    actual, expected = technicals(records)["series"], rational_oracle(records)
    for key in FIRST_VALID:
        for index, reference in enumerate(expected[key]):
            try:
                assert_rational(actual[key][index], reference)
            except AssertionError as error:
                raise AssertionError(f"{key} at index {index}") from error


@pytest.mark.parametrize("period", PERIODS)
def test_sma_and_ema_seeds_recursion_and_impulse_for_every_period(period):
    # Constant seed followed by one impulse has a closed-form EMA response.
    series = technicals(ohlc([100] * period + [200] + [100] * 5))["series"]
    assert series[f"ema{period}"][:period - 1] == [None] * (period - 1)
    assert_rational(series[f"ema{period}"][period - 1], Fraction(100))
    alpha = Fraction(2, period + 1)
    for offset in range(6):
        assert_rational(
            series[f"ema{period}"][period + offset],
            100 + 100 * alpha * (1 - alpha) ** offset,
        )
        # For SMA5 the impulse exits on offset5; longer windows retain it.
        expected = Fraction(100) + (Fraction(100, period) if offset < period else 0)
        assert_rational(series[f"sma{period}"][period + offset], expected)


@pytest.mark.parametrize("direction", [1, -1])
def test_monotonic_ohlc_closed_form_indicators(direction):
    series = technicals(ohlc([300 + direction * index for index in range(215)]))["series"]
    for period in PERIODS:
        for index in range(period - 1, 215):
            expected = Fraction(300) + direction * (index - Fraction(period - 1, 2))
            assert_rational(series[f"sma{period}"][index], expected)
            assert_rational(series[f"ema{period}"][index], expected)
    for key, expected in {
        "stoch9_6": Fraction(250, 3) if direction == 1 else Fraction(50, 3),
        "williams_r14": Fraction(-200, 17) if direction == 1 else Fraction(-1500, 17),
        "cci14": direction * Fraction(2600, 21),
        "atr14": Fraction(4), "highs_lows14": direction * Fraction(13, 2),
        "ultimate7_14_28": Fraction(50),
        "plus_di14": Fraction(25) if direction == 1 else Fraction(0),
        "minus_di14": Fraction(0) if direction == 1 else Fraction(25),
        "adx14": Fraction(100), "macd12_26": direction * Fraction(7),
        "macd_signal9": direction * Fraction(7),
        "bull13": Fraction(2 + direction * 6), "bear13": Fraction(-2 + direction * 6),
    }.items():
        for value in series[key][FIRST_VALID[key]:]:
            assert_rational(value, expected)
    assert series["stochrsi14"] == [None] * 215


@pytest.mark.parametrize("spread", [0, 2])
def test_constant_prices_zero_denominators_and_flat_adx(spread):
    series = technicals(ohlc([100] * 215, spread))["series"]
    undefined = {"stochrsi14", "cci14"}
    if spread == 0:
        undefined.update(("stoch9_6", "williams_r14", "ultimate7_14_28"))
    for key, first in FIRST_VALID.items():
        assert series[key][:first] == [None] * first
        if key in undefined:
            assert series[key] == [None] * 215
            continue
        if key.startswith(("sma", "ema")):
            expected = Fraction(100)
        else:
            expected = Fraction({
                "stoch9_6": 50, "williams_r14": -50, "ultimate7_14_28": 50,
                "atr14": 2 * spread, "bull13": spread, "bear13": -spread,
            }.get(key, 0))
        for value in series[key][first:]:
            assert_rational(value, expected)


def test_atr_gap_seed_differs_from_adx_movement_seed_and_dm_ties_are_zero():
    records = ohlc([100] + [120] * 29)
    result = technicals(records)["series"]
    # TR0=4, TR1=22 (gap), remaining TR=4. ADX seed excludes TR0.
    seed = Fraction(4 + 22 + 12 * 4, 14)
    assert_rational(result["atr14"][13], seed)
    assert_rational(result["atr14"][14], (13 * seed + 4) / 14)
    assert_rational(result["plus_di14"][14], Fraction(100 * 20, 22 + 13 * 4))
    assert_rational(result["minus_di14"][14], Fraction(0))
    assert result["adx14"][:27] == [None] * 27
    assert_rational(result["adx14"][27], Fraction(100))
    # Equal upward/downward expansion is not both +DM and -DM.
    ties = [
        {"close": "100", "high": str(101 + index), "low": str(99 - index)}
        for index in range(35)
    ]
    tied = technicals(ties)["series"]
    for key in ("plus_di14", "minus_di14", "adx14"):
        for value in tied[key][FIRST_VALID[key]:]:
            assert_rational(value, Fraction(0))


def test_null_stochastic_window_is_not_filled_and_recovers_after_six_valid_k():
    records = ohlc([100] * 20, 0) + ohlc([101] * 10, 1)
    result = technicals(records)["series"]["stoch9_6"]
    assert result[:25] == [None] * 25
    assert_rational(result[25], Fraction(50))


def test_all_series_every_prefix_and_future_ohlc_mutation_are_invariant():
    records = varied_bars(205)
    saved = deepcopy(records)
    full = technicals(records)
    for end in range(len(records) + 1):
        prefix = technicals(records[:end])
        mutated = technicals(records[:end] + ohlc([10000, 5000, 20000]))
        for key in FIRST_VALID:
            assert prefix["series"][key] == full["series"][key][:end]
            assert mutated["series"][key][:end] == full["series"][key][:end]
        for key in SERIES:
            assert prefix[key] == full[key][:end] == mutated[key][:end]
    assert records == saved


def test_display_window_must_not_reset_full_history_warmup_or_recursive_state():
    records = varied_bars(260)
    full = technicals(records)
    for width in (1, 20, 50):
        start = len(records) - width
        start_prefix = technicals(records[:start + 1])
        end_prefix = technicals(records)
        for key in FIRST_VALID:
            displayed = full["series"][key][-width:]
            # Changing only the display width never recomputes on a sliced input.
            assert displayed[0] == start_prefix["series"][key][-1]
            assert displayed[-1] == end_prefix["series"][key][-1]
            assert all(value is not None for value in displayed)
        sliced = technicals(records[-width:])
        assert sliced["series"]["ema200"] == [None] * width
        assert full["series"]["ema200"][-width:] != sliced["series"]["ema200"]


def test_expanded_price_arithmetic_preserves_sub_float_precision():
    records = [{
        "close": "100.000000000000000001",
        "high": "100.000000000000000003",
        "low": "99.999999999999999999",
    }] * 215
    series = technicals(records)["series"]
    for period in PERIODS:
        for key in (f"sma{period}", f"ema{period}"):
            assert all(
                Fraction(value) == Fraction("100.000000000000000001")
                for value in series[key][period - 1:]
            )
    assert Fraction(series["bull13"][-1]) == Fraction(2, 10**18)
    assert Fraction(series["bear13"][-1]) == Fraction(-2, 10**18)
    assert Fraction(series["atr14"][-1]) == Fraction(4, 10**18)


def test_finite_windows_forget_old_bars_but_recursive_indicators_retain_history():
    records = varied_bars(260)
    full = technicals(records)["series"]
    truncated = technicals(records[30:])["series"]
    finite_windows = {
        *(f"sma{period}" for period in PERIODS),
        "stoch9_6", "williams_r14", "cci14", "highs_lows14", "ultimate7_14_28", "roc12",
    }
    for key in finite_windows:
        assert full[key][-20:] == truncated[key][-20:]
    # Both EMA200s have seeded here, but the later seed is not equivalent to
    # computing on full history then selecting the same visible last20 bars.
    assert all(value is not None for value in truncated["ema200"][-20:])
    assert full["ema200"][-20:] != truncated["ema200"][-20:]


def test_missing_high_is_not_filled_or_allowed_to_contaminate_close_indicators():
    records = varied_bars(65)
    complete = technicals(records)
    del records[35]["high"]
    missing = technicals(records)
    for key in SERIES:
        assert missing[key] == complete[key]
    assert missing["series"]["bull13"][35] is None
    assert missing["series"]["bear13"] == complete["series"]["bear13"]
    assert missing["series"]["atr14"][35:49] == [None] * 14
    assert missing["series"]["atr14"][49] is not None
    assert missing["series"]["williams_r14"][35:49] == [None] * 14
    assert missing["series"]["williams_r14"][49:] == complete["series"]["williams_r14"][49:]


@pytest.mark.parametrize("rounding", [ROUND_UP, ROUND_DOWN])
def test_expanded_ohlc_isolated_decimal_context_and_flags(rounding):
    records = varied_bars(215)
    expected = technicals(records)
    with localcontext() as context:
        context.prec = 3
        context.rounding = rounding
        context.Emax, context.Emin = 1, -1
        context.capitals, context.clamp = 0, 1
        context.traps[Inexact] = True
        context.clear_flags()
        context.flags[Inexact] = True
        before = context.copy()
        assert technicals(records) == expected
        assert context.prec == before.prec and context.rounding == before.rounding
        assert (context.Emax, context.Emin) == (before.Emax, before.Emin)
        assert (context.capitals, context.clamp) == (before.capitals, before.clamp)
        assert dict(context.traps) == dict(before.traps)
        assert dict(context.flags) == dict(before.flags)


def test_close_only_compatibility_does_not_invent_high_or_low():
    result = technicals(bars(range(100, 315)))
    price_only = {
        *(f"sma{p}" for p in PERIODS), *(f"ema{p}" for p in PERIODS),
        "stochrsi14", "macd12_26", "macd_signal9", "roc12",
    }
    for key in set(FIRST_VALID) - price_only:
        assert result["series"][key] == [None] * 215
    assert result["series"]["sma20"] == result["sma20"]
    assert result["series"]["sma50"] == result["sma50"]


@pytest.mark.parametrize("field", ["high", "low"])
@pytest.mark.parametrize("price", [None, 100, True, "0", "-1", "NaN", "Infinity", "bad"])
def test_invalid_high_low_rejected_without_changing_close_contract(field, price):
    record = {"close": "100", "high": "102", "low": "98", field: price}
    with pytest.raises(ValueError, match=f"expected positive finite {field} string"):
        technicals([record])