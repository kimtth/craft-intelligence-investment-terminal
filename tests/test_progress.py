from decimal import Context, Decimal, localcontext
from fractions import Fraction

import pytest

from itt.progress import metrics_snapshot


def test_calendar_cagr_exact_four_year_oracle_and_context_isolation():
    # Four calendar years spanning one leap day are exactly 4 * 365.25 days.
    args = (Fraction(100), Fraction(14641, 100), Fraction(1, 3), "2020-01-01", "2024-01-01")
    result = metrics_snapshot(*args)
    assert result == {"nav": "146.41", "cagr": "0.100000000000000000000000000",
                      "max_drawdown": "0.3333333333333333333333333333"}
    with localcontext(Context(prec=3, Emax=9, Emin=-9)):
        assert metrics_snapshot(*args) == result


def test_first_date_zero_nav_and_calendar_not_session_count():
    assert metrics_snapshot(Fraction(100), Fraction(100), Fraction(0),
                            "2024-01-05", "2024-01-05")["cagr"] is None
    assert Decimal(metrics_snapshot(Fraction(100), Fraction(0), Fraction(1),
                                    "2024-01-05", "2024-01-08")["cagr"]) == -1
    result = metrics_snapshot(Fraction(100), Fraction(110), Fraction(0), "2024-01-05", "2024-01-08")
    with localcontext(Context(prec=28)):
        assert Decimal(result["cagr"]) == Decimal("1.1") ** (Decimal("365.25") / 3) - 1


def test_cagr_overflow_is_null_not_nonfinite():
    result = metrics_snapshot(
        Fraction(1), Fraction(10 ** 3000), Fraction(0), "2024-01-01", "2024-01-02",
    )
    assert result["cagr"] is None
    assert Decimal(result["nav"]).is_finite()
    assert result["max_drawdown"] == "0"


@pytest.mark.parametrize(("initial", "nav", "drawdown", "start", "current"), [
    (0, 1, 0, "2024-01-01", "2024-01-02"),
    (1, -1, 0, "2024-01-01", "2024-01-02"),
    (1, 1, 2, "2024-01-01", "2024-01-02"),
    (1, 1, -1, "2024-01-01", "2024-01-02"),
    (1, 1, 0, "2024-01-02", "2024-01-01"),
    (1, 1, 0, "2024-02-30", "2024-03-01"),
])
def test_invalid_inputs(initial, nav, drawdown, start, current):
    with pytest.raises(ValueError):
        metrics_snapshot(Fraction(initial), Fraction(nav), Fraction(drawdown), start, current)