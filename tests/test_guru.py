"""Invented normalized test rows only; not actual SEC filings or investment evidence."""

import json
import math
import socket
import urllib.request
from copy import deepcopy
from datetime import date
from decimal import Context, Decimal, localcontext

import pytest
from pydantic import ValidationError

from itt.guru import (
    MAX_FILINGS,
    MAX_HOLDINGS_PER_FILING,
    MAX_TOTAL_HOLDINGS,
    GuruSpec,
    run_guru_analysis,
)

SEC_URL = "https://www.sec.gov/Archives/edgar/data/0000000000/test-only.xml"


def holding(cusip="TEST00001", value="10", shares="1", name="Test security"):
    return {"cusip": cusip, "name": name, "value_usd": value, "shares": shares}


def filing(manager="Test manager", period="2026-03-31", filed_at="2026-05-15",
           holdings=None, **overrides):
    return {
        "manager": manager, "period": period, "filed_at": filed_at, "source_url": SEC_URL,
        "holdings": [holding()] if holdings is None else holdings, **overrides,
    }


def spec_for(*filings, as_of="2026-09-11"):
    return {"filings": list(filings), "as_of": as_of}


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Guru analysis must not access the network")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(urllib.request, "urlopen", forbidden)


def test_pit_inclusive_latest_period_not_latest_filing_time_and_future_invariance():
    early = filing(period="2025-12-31", filed_at="2026-06-01", holdings=[holding(shares="2")])
    current = filing(holdings=[holding(shares="3")])
    future = filing(period="2026-06-30", filed_at="2026-08-14",
                    holdings=[holding("FUTURE001", "999", "100", "Future secret")])
    future_manager = filing(manager="Future-only manager", filed_at="2026-08-14")
    spec = spec_for(future, early, current, future_manager, as_of="2026-06-01")
    result = run_guru_analysis(spec)
    assert result == run_guru_analysis(spec_for(early, current, as_of="2026-06-01"))
    assert len(result["managers"]) == 1
    manager = result["managers"][0]
    assert manager["period"] == "2026-03-31"  # Not the period filed most recently.
    assert manager["filed_at"] == "2026-05-15"
    assert manager["source_url"] == SEC_URL
    assert manager["holdings"][0]["change"] == "increased"
    assert manager["holdings"][0]["change_shares"] == "1"
    assert "Future" not in json.dumps(result)


def test_all_changes_exact_totals_popularity_and_exits():
    old = filing(holdings=[
        holding("A", "100", "1.1"), holding("B", "20", "10"),
        holding("C", "10", "2"), holding("X", "50", "5.5", "Exited test security"),
    ])
    latest = filing(period="2026-06-30", filed_at="2026-08-14", holdings=[
        holding("A", "0.1", "1.3"), holding("B", "0.2", "7.5"),
        holding("C", "0.3", "2"), holding("D", "0.4", "3"),
    ])
    other = filing(manager="Other manager", holdings=[
        holding("A", "0.2", "1", "Alternate test name"), holding("Y", "1000", "1"),
    ])
    result = run_guru_analysis(spec_for(latest, old, other))
    manager = result["managers"][1]
    assert manager["total_value_usd"] == "1"
    assert [row["weight"] for row in manager["holdings"]] == [0.1, 0.2, 0.3, 0.4]
    assert [(row["cusip"], row["change"], row["change_shares"])
            for row in result["changes"] if row["manager"] == "Test manager"] == [
        ("A", "increased", "0.2"), ("B", "reduced", "-2.5"),
        ("C", "unchanged", "0"), ("D", "new", "3"), ("X", "exited", "-5.5"),
    ]
    assert result["popular"][0] == {
        "cusip": "A", "name": "Alternate test name", "manager_count": 2, "value_usd": "0.3",
    }
    assert [row["cusip"] for row in result["popular"]] == ["A", "Y", "D", "C", "B"]
    assert "X" not in {row["cusip"] for row in manager["holdings"]}
    assert "X" not in {row["cusip"] for row in result["popular"]}


def test_no_previous_is_unknown_but_empty_previous_means_new():
    current = filing(period="2026-06-30", filed_at="2026-08-14")
    late_old = filing(filed_at="2026-09-12")
    result = run_guru_analysis(spec_for(current, late_old))
    row = result["managers"][0]["holdings"][0]
    assert row["change"] == "unknown" and row["change_shares"] is None
    assert result["changes"][0]["change"] == "unknown"
    result = run_guru_analysis(spec_for(current, filing(holdings=[])))
    assert result["changes"][0]["change"] == "new"
    assert result["changes"][0]["change_shares"] == "1"


def test_three_periods_compare_only_two_latest_and_do_not_fill_missing_quarter():
    result = run_guru_analysis(spec_for(
        filing(period="2025-09-30", filed_at="2025-11-14", holdings=[holding(shares="100")]),
        filing(holdings=[holding(shares="2")]),
        filing(period="2026-06-30", filed_at="2026-08-14", holdings=[holding(shares="5")]),
    ))
    assert result["changes"][0]["change_shares"] == "3"
    result = run_guru_analysis(spec_for(
        filing(period="2025-09-30", filed_at="2025-11-14", holdings=[holding(shares="100")]),
        filing(holdings=[holding(shares="2")]),
    ))
    assert result["changes"][0]["change_shares"] == "-98"


@pytest.mark.parametrize("filings", [[], [filing(filed_at="2026-09-12")]])
def test_empty_or_entirely_future_import(filings):
    result = run_guru_analysis(spec_for(*filings))
    assert result["as_of"] == "2026-09-11"
    assert result["managers"] == result["popular"] == result["changes"] == []
    assert result["limitations"]


def test_empty_latest_exits_previous_and_zero_values_have_finite_zero_weights():
    result = run_guru_analysis(spec_for(filing(), filing(
        period="2026-06-30", filed_at="2026-08-14", holdings=[],
    )))
    assert result["managers"][0]["total_value_usd"] == "0"
    assert result["managers"][0]["holdings"] == result["popular"] == []
    assert result["changes"][0]["change"] == "exited"
    assert result["changes"][0]["change_shares"] == "-1"
    zero = run_guru_analysis(spec_for(filing(holdings=[holding(value="0", shares="0")])))
    assert zero["managers"][0]["holdings"][0]["weight"] == 0.0
    assert zero["popular"][0]["manager_count"] == 1
    assert json.loads(json.dumps(zero, allow_nan=False)) == zero


def test_exact_arithmetic_independent_of_decimal_context_and_input_preserved():
    source = spec_for(filing(holdings=[
        holding("A", "1000000000000000000", "1e-18"),
        holding("B", ".000000000000000001", "+1.00"),
    ]))
    original = deepcopy(source)
    with localcontext(Context(prec=2)):
        result = run_guru_analysis(source)
    assert source == original
    assert result == run_guru_analysis(GuruSpec.model_validate(source))
    assert result["managers"][0]["total_value_usd"] == "1000000000000000000.000000000000000001"
    for actual, supplied in zip(
        result["managers"][0]["holdings"], source["filings"][0]["holdings"], strict=True,
    ):
        assert {key: actual[key] for key in supplied} == supplied
        assert math.isfinite(actual["weight"]) and 0 <= actual["weight"] <= 1
    assert json.loads(json.dumps(result, allow_nan=False)) == result


def test_deterministic_ordering_and_equal_popularity_tie_break():
    spec = spec_for(filing(manager="Z", holdings=[holding("B"), holding("A")]),
                    filing(manager="A", holdings=[holding("C")]))
    expected = run_guru_analysis(spec)
    assert [row["cusip"] for row in expected["popular"]] == ["A", "B", "C"]
    spec["filings"].reverse()
    for row in spec["filings"]:
        row["holdings"].reverse()
    assert run_guru_analysis(spec) == expected


@pytest.mark.parametrize("url", [
    "http://www.sec.gov/Archives/test", "https://sec.gov/Archives/test",
    "https://www.sec.gov.evil.test/Archives/test", "https://evil.test/www.sec.gov/",
    "https://www.sec.gov@evil.test/", "https://user@www.sec.gov/",
    "https://www.sec.gov:443/Archives/test", "https://www.sec.gov./Archives/test",
    "//www.sec.gov/Archives/test", "https://www.sec.gov", "https://WWW.SEC.GOV/",
    "https://www.sec.gov\\@evil.test/", "https://www.sec.gov/\nArchives/test",
    "https://www.sec.gov/with space", " https://www.sec.gov/Archives/test",
    "https://www.sec.gov\t/Archives/test", "https://www.sec.gov/\x7f",
    "https://www.sec.gov/" + "a" * 2048, "https://[www.sec.gov/", 123, None,
])
def test_invalid_sec_source_urls(url):
    with pytest.raises(ValidationError):
        run_guru_analysis(spec_for(filing(source_url=url)))


@pytest.mark.parametrize("url", [SEC_URL, "https://www.sec.gov/edgar/search/",
                                  "https://www.sec.gov/Archives/test.xml?output=1"])
def test_sec_source_urls_are_preserved_but_not_authenticated(url):
    result = run_guru_analysis(spec_for(filing(source_url=url)))
    assert result["managers"][0]["source_url"] == url
    assert "not authenticated" in " ".join(result["limitations"])


@pytest.mark.parametrize("field", ["value_usd", "shares"])
@pytest.mark.parametrize("value", [
    "-1", "NaN", "Infinity", "-Infinity", "1/2", "", " 1", "1 ", "1\n", "1_000",
    "1e19", "1000000000000000001", "1e-19", "0e1000000", "1e99999999999999999999999",
    "9" * 65, 1, 1.2, True, None, Decimal("1"),
])
def test_invalid_amounts(field, value):
    row = holding()
    row[field] = value
    with pytest.raises(ValidationError):
        run_guru_analysis(spec_for(filing(holdings=[row])))


@pytest.mark.parametrize("field", ["period", "filed_at", "as_of"])
@pytest.mark.parametrize("value", ["2026-02-30", "2026-2-01", "2026-01-01T00:00:00Z",
                                  "0000-01-01", "2026-01-01\n", date(2026, 1, 1), 20260101])
def test_invalid_dates(field, value):
    spec = spec_for(filing())
    (spec if field == "as_of" else spec["filings"][0])[field] = value
    with pytest.raises(ValidationError):
        run_guru_analysis(spec)


def test_period_after_filing_rejected_and_same_day_leap_date_accepted():
    with pytest.raises(ValidationError, match="period must be"):
        run_guru_analysis(spec_for(filing(period="2026-06-30")))
    result = run_guru_analysis(spec_for(filing(period="2024-02-29", filed_at="2024-02-29"),
                                       as_of="2024-02-29"))
    assert len(result["managers"]) == 1


@pytest.mark.parametrize("second", [filing(), filing(filed_at="2026-06-01"),
                                   filing(filed_at="2026-09-12")])
def test_duplicate_or_amended_manager_period_is_always_ambiguous(second):
    with pytest.raises(ValidationError, match="ambiguous manager/period"):
        run_guru_analysis(spec_for(filing(), second))


def test_duplicate_cusip_rejected_but_explicit_import_aggregation_supported():
    with pytest.raises(ValidationError, match="duplicate CUSIP"):
        run_guru_analysis(spec_for(filing(holdings=[holding(), holding(value="20")])))
    result = run_guru_analysis(spec_for(filing(holdings=[holding(value="30", shares="2")])))
    assert result["managers"][0]["total_value_usd"] == "30"
    assert result["popular"][0]["manager_count"] == 1


@pytest.mark.parametrize("level,field,value", [
    ("spec", "extra", True), ("filing", "extra", True), ("holding", "extra", True),
    ("filing", "manager", ""), ("filing", "manager", " "),
    ("filing", "manager", "Test manager "), ("filing", "manager", "a" * 201),
    ("holding", "name", ""), ("holding", "name", "a" * 301),
    ("holding", "cusip", ""), ("holding", "cusip", "a" * 33),
    ("holding", "cusip", " A"), ("holding", "name", "A\nB"),
    ("holding", "cusip", 123), ("spec", "filings", (filing(),)),
    ("filing", "holdings", (holding(),)),
])
def test_strict_bounded_objects(level, field, value):
    spec = spec_for(filing())
    target = {"spec": spec, "filing": spec["filings"][0],
              "holding": spec["filings"][0]["holdings"][0]}[level]
    target[field] = value
    with pytest.raises(ValidationError):
        run_guru_analysis(spec)


def test_collection_bounds_and_json_schema():
    with pytest.raises(ValidationError):
        GuruSpec.model_validate(spec_for(*[filing(manager=str(i)) for i in range(MAX_FILINGS + 1)]))
    rows = [holding(str(i)) for i in range(MAX_HOLDINGS_PER_FILING + 1)]
    with pytest.raises(ValidationError):
        GuruSpec.model_validate(spec_for(filing(holdings=rows)))
    rows.pop()
    count = MAX_TOTAL_HOLDINGS // MAX_HOLDINGS_PER_FILING
    with pytest.raises(ValidationError, match="total holdings"):
        GuruSpec.model_validate(spec_for(
            *[filing(manager=str(i), holdings=rows) for i in range(count)],
            filing(manager="Overflow"),
        ))
    schema = GuruSpec.model_json_schema()
    assert schema["additionalProperties"] is False
    assert schema["properties"]["filings"]["maxItems"] == MAX_FILINGS
    assert schema["$defs"]["GuruFiling"]["additionalProperties"] is False
    assert schema["$defs"]["GuruHolding"]["additionalProperties"] is False


def test_mutated_model_instances_are_revalidated():
    spec = GuruSpec.model_validate(spec_for(filing()))
    spec.filings[0].holdings[0].shares = "-1"
    with pytest.raises(ValidationError):
        run_guru_analysis(spec)


def test_limitations_and_public_output_contract_no_performance_claims():
    result = run_guru_analysis(spec_for(filing()))
    assert set(result) == {"as_of", "managers", "popular", "changes", "limitations"}
    assert set(result["managers"][0]) == {
        "manager", "period", "filed_at", "source_url", "total_value_usd", "holdings",
    }
    assert set(result["managers"][0]["holdings"][0]) == {
        "cusip", "name", "value_usd", "shares", "weight", "change_shares", "change",
    }
    limitations = " ".join(result["limitations"])
    for explanation in ("45 days", "shorts", "cash", "derivatives", "non-US",
                        "realized returns", "not authenticated", "date granularity",
                        "not be consecutive", "not thousands"):
        assert explanation in limitations
    assert not {"performance", "cagr", "mdd", "returns"}.intersection(result)