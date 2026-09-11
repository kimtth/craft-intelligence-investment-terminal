"""Offline analysis of user-normalized 13F holdings, not authenticated SEC data.

No network, bundled fund universe, persistence, price history or return estimates.
Manager identifiers and CUSIPs must be normalized upstream; identity is exact and
case-sensitive. Repeated manager/period filings (including amendments) and repeated
CUSIPs within a filing are rejected, never silently selected or aggregated. Importers
must resolve amendments and deliberately aggregate comparable share-class rows first.

Bounds: 1,000 filings, 10,000 holdings per filing, 100,000 holdings overall;
amount strings <=64 characters, values in [0, 10**18], decimal exponents in [-18, 18].
Empty imports/filings are allowed. Periods need not be consecutive quarter ends:
comparisons use the two latest *available supplied periods*, not a presumed quarter.
"""

from decimal import Decimal, InvalidOperation
from fractions import Fraction
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    model_validator,
)

from itt.criteria import DecimalString, SessionDate, _amount

MAX_FILINGS = 1000
MAX_HOLDINGS_PER_FILING = 10000
MAX_TOTAL_HOLDINGS = 100000


def _clean_text(value: str) -> str:
    if value != value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("text must be trimmed and contain no control characters")
    return value


def _bounded_decimal(value: object) -> object:
    # Bound before the shared DecimalString validator and before Fraction creation.
    if not isinstance(value, str):
        return value  # The underlying strict string field rejects numbers/bools.
    if len(value) > 64:
        raise ValueError("amount string exceeds 64 characters")
    try:
        amount = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError("finite decimal string required") from exc
    if not amount.is_finite() or not 0 <= amount <= Decimal("1e18"):
        raise ValueError("amount must be finite and in [0, 1e18]")
    exponent = amount.as_tuple().exponent
    if not isinstance(exponent, int) or not -18 <= exponent <= 18:
        raise ValueError("decimal exponent must be in [-18, 18]")
    return value


def _sec_url(value: str) -> str:
    # A syntactic provenance constraint ONLY: this does not fetch or authenticate.
    if any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("SEC source URL must contain no whitespace or controls")
    if "\\" in value:
        raise ValueError("SEC source URL must contain no backslashes")
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or parsed.netloc != "www.sec.gov"
            or not value.startswith("https://www.sec.gov/") or not parsed.path.startswith("/")):
        raise ValueError("source_url must start with https://www.sec.gov/ on that exact host")
    return value


Amount = Annotated[
    DecimalString, Field(max_length=64), BeforeValidator(_bounded_decimal),
]
Manager = Annotated[str, Field(strict=True, min_length=1, max_length=200),
                    AfterValidator(_clean_text)]
Cusip = Annotated[str, Field(strict=True, min_length=1, max_length=32),
                  AfterValidator(_clean_text)]
Name = Annotated[str, Field(strict=True, min_length=1, max_length=300),
                 AfterValidator(_clean_text)]
SourceURL = Annotated[str, Field(strict=True, min_length=1, max_length=2048),
                      AfterValidator(_sec_url)]
BoundedDate = Annotated[SessionDate, Field(max_length=10)]


class _GuruModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, revalidate_instances="always")


class GuruHolding(_GuruModel):
    cusip: Cusip
    name: Name
    value_usd: Amount
    shares: Amount


class GuruFiling(_GuruModel):
    manager: Manager
    period: BoundedDate
    filed_at: BoundedDate
    source_url: SourceURL
    holdings: Annotated[list[GuruHolding], Field(max_length=MAX_HOLDINGS_PER_FILING)]

    @model_validator(mode="after")
    def validate_filing(self) -> "GuruFiling":
        if self.period > self.filed_at:
            raise ValueError("period must be on or before filed_at")
        cusips = [holding.cusip for holding in self.holdings]
        if len(cusips) != len(set(cusips)):
            raise ValueError("duplicate CUSIP in a filing; explicitly aggregate comparable rows")
        return self


class GuruSpec(_GuruModel):
    """Bounded import; filed_at <= as_of is inclusive, date-level availability only."""

    filings: Annotated[list[GuruFiling], Field(max_length=MAX_FILINGS)]
    as_of: BoundedDate

    @model_validator(mode="after")
    def validate_import(self) -> "GuruSpec":
        keys = [(filing.manager, filing.period) for filing in self.filings]
        if len(keys) != len(set(keys)):
            raise ValueError("ambiguous manager/period; resolve duplicates and amendments upstream")
        if sum(len(filing.holdings) for filing in self.filings) > MAX_TOTAL_HOLDINGS:
            raise ValueError("import exceeds 100000 total holdings")
        return self


_LIMITATIONS = (
    "User-imported normalized holdings are not authenticated from SEC. The SEC source URL "
    "is syntax-checked only; no network access, filing verification or curated fund dataset.",
    "13F filings generally lag quarter end by up to 45 days and can be late or amended. "
    "Availability uses the supplied filed_at <= as_of, inclusive at date granularity; "
    "no intraday publication time or historical authenticity is established.",
    "This normalized analysis covers reported long US equity holdings only, not the full "
    "portfolio: shorts, cash, derivatives and non-US holdings are excluded here. Actual 13F "
    "scope is the SEC reportable-securities list, which can include certain options and ADRs; "
    "importers must exclude incompatible instruments rather than merge them as equity shares.",
    "Quarter-end holdings cannot establish trade dates, execution prices, dividends, flows, "
    "fees or manager realized returns. No actual fund returns, estimated performance, CAGR "
    "or MDD are inferred or fabricated.",
    "Comparisons use each manager's latest and previous available supplied periods, which "
    "may not be consecutive quarters. No previous filing means unknown, not new. New/exited "
    "mean row presence/absence in the supplied snapshots, not verified purchases/sales; "
    "omissions, confidential treatment, splits and identifier changes can affect differences.",
    "Popularity counts distinct exact manager identifiers in their latest visible filing, "
    "not all managers or a licensed 79-fund universe; periods may differ across managers. "
    "Values are supplied quarter-end USD amounts (not thousands), not current valuations. "
    "Weights use only imported holdings; a zero total yields zero weights. Zero rows are retained.",
    "Identifiers must be normalized upstream; duplicate manager/periods and filing CUSIPs "
    "are rejected. Popularity groups by CUSIP; conflicting names use the first manager in "
    "alphabetical order, not an authenticated security master.",
)


def run_guru_analysis(spec: dict | GuruSpec) -> dict:
    """Return deterministic JSON-safe summaries without reading or writing any files.

    Managers and holdings/changes sort by manager then CUSIP. Popularity sorts by
    manager count descending, exact USD sum descending, then CUSIP ascending.
    `changes` includes every current holding (even unknown/unchanged) plus exits;
    exits are absent from current holdings/popularity. Amounts/deltas are exact
    decimal strings; weights are finite float fractions in [0, 1], not percentages.
    """
    spec = GuruSpec.model_validate(spec)
    visible: dict[str, list[GuruFiling]] = {}
    for filing in spec.filings:
        if filing.filed_at <= spec.as_of:
            visible.setdefault(filing.manager, []).append(filing)

    managers, changes = [], []
    popular: dict[str, dict] = {}
    for manager in sorted(visible):
        history = sorted(visible[manager], key=lambda filing: filing.period)
        latest = history[-1]
        previous = ({holding.cusip: holding for holding in history[-2].holdings}
                    if len(history) > 1 else None)
        total = sum((Fraction(holding.value_usd) for holding in latest.holdings), Fraction(0))
        holdings, manager_changes = [], []
        for holding in sorted(latest.holdings, key=lambda row: row.cusip):
            value = Fraction(holding.value_usd)
            delta = None
            if previous is None:
                change = "unknown"
            elif holding.cusip not in previous:
                change, delta = "new", Fraction(holding.shares)
            else:
                delta = Fraction(holding.shares) - Fraction(previous[holding.cusip].shares)
                change = "increased" if delta > 0 else "reduced" if delta < 0 else "unchanged"
            change_shares = None if delta is None else _amount(delta)
            holdings.append({
                **holding.model_dump(), "weight": float(value / total) if total else 0.0,
                "change_shares": change_shares, "change": change,
            })
            manager_changes.append({
                "manager": manager, "cusip": holding.cusip, "name": holding.name,
                "change": change, "change_shares": change_shares,
            })
            aggregate = popular.setdefault(holding.cusip, {
                "cusip": holding.cusip, "name": holding.name,
                "manager_count": 0, "value_usd": Fraction(0),
            })
            aggregate["manager_count"] += 1
            aggregate["value_usd"] += value

        current_cusips = {holding.cusip for holding in latest.holdings}
        for cusip, holding in (previous or {}).items():
            if cusip not in current_cusips:
                manager_changes.append({
                    "manager": manager, "cusip": cusip, "name": holding.name,
                    "change": "exited", "change_shares": _amount(-Fraction(holding.shares)),
                })
        changes.extend(sorted(manager_changes, key=lambda row: row["cusip"]))
        managers.append({
            "manager": manager, "period": latest.period, "filed_at": latest.filed_at,
            "source_url": latest.source_url, "total_value_usd": _amount(total),
            "holdings": holdings,
        })

    ranked = sorted(popular.values(), key=lambda row: (
        -row["manager_count"], -row["value_usd"], row["cusip"],
    ))
    return {
        "as_of": spec.as_of, "managers": managers,
        "popular": [{**row, "value_usd": _amount(row["value_usd"])} for row in ranked],
        "changes": changes, "limitations": list(_LIMITATIONS),
    }