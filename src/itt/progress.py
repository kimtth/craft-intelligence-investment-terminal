"""Standalone, deterministic metrics shared by final and per-session results."""

from datetime import date
from decimal import Context, Decimal, DecimalException, localcontext
from fractions import Fraction


def metrics_snapshot(
    initial: Fraction, nav: Fraction, drawdown: Fraction, start: str, current: str,
) -> dict:
    """CAGR uses calendar days / 365.25; undefined or overflowed CAGR is null.

    NAV retains exact terminating ledger decimals. Ratios use decimal28 half-even.
    Negative NAV is outside the long-only contract. Drawdown is the running maximum
    supplied by the simulator, not an instantaneous drawdown recomputed here.
    """
    if initial <= 0 or nav < 0 or not 0 <= drawdown <= 1:
        raise ValueError("expected positive initial, nonnegative NAV and drawdown in [0, 1]")
    elapsed = (date.fromisoformat(current) - date.fromisoformat(start)).days
    if elapsed < 0:
        raise ValueError("current must not precede start")
    precision = len(str(abs(nav.numerator))) + nav.denominator.bit_length() + 1
    with localcontext(Context(prec=precision)):
        nav_text = str(Decimal(nav.numerator) / Decimal(nav.denominator))
    with localcontext(Context(prec=28, Emin=-999999, Emax=999999)):
        maximum = str(Decimal(drawdown.numerator) / Decimal(drawdown.denominator))
        cagr = None
        if elapsed:
            try:
                relative = nav / initial
                ratio = Decimal(relative.numerator) / Decimal(relative.denominator)
                value = ratio ** (Decimal("365.25") / elapsed) - 1
                if value.is_finite():
                    cagr = str(value)
            except (DecimalException, OverflowError):
                # Never emit NaN/Infinity or fail the ledger due to annualization.
                pass
    return {"nav": nav_text, "cagr": cagr, "max_drawdown": maximum}