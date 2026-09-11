"""PIT publication boundaries; no strategy, order, or NAV assertions before P2."""

import json
from copy import deepcopy
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest

from itt.contracts import Dataset
from itt.data import load_dataset, observations_at, universe_at, validate_dataset

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "p1"


@pytest.fixture
def dataset() -> Dataset:
    return load_dataset(FIXTURES / "valid.json")


def test_delayed_publication_is_absent_until_exact_availability(dataset: Dataset) -> None:
    before = observations_at(dataset, datetime.fromisoformat("2024-01-03T19:59:59Z"))
    after = observations_at(dataset, datetime.fromisoformat("2024-01-03T20:00:00Z"))
    delayed = dataset.observations[3]
    assert delayed not in before
    assert delayed in after
    assert all(row.observed_at <= datetime.fromisoformat("2024-01-03T20:00:00Z") for row in after)


def test_revision_uses_available_version_not_latest_archive_version(dataset: Dataset) -> None:
    oracle = json.loads((FIXTURES / "oracle.json").read_text(encoding="utf-8"))["pit_revision"]
    for cutoff, expected, revision in [
        ("2024-01-03T21:00:00Z", oracle["expected_before"], 1),
        ("2024-01-05T21:04:59Z", oracle["expected_before"], 1),
        (oracle["revision_2_available_at"], oracle["expected_after"], 2),
    ]:
        result = [
            row for row in observations_at(dataset, datetime.fromisoformat(cutoff))
            if row.asset_id == "SYN-A" and row.field == "close"
            and row.observed_at == datetime.fromisoformat(oracle["observed_at"])
        ]
        assert len(result) == 1
        assert result[0].revision == revision
        assert result[0].value == Decimal(expected)


def test_future_members_and_prices_are_not_exposed(dataset: Dataset) -> None:
    oracle = json.loads((FIXTURES / "oracle.json").read_text(encoding="utf-8"))["future_entry"]
    at = datetime.fromisoformat(oracle["cutoff"])
    assert universe_at(dataset, at) == tuple(oracle["expected_members"])
    assert all(row.asset_id != "SYN-C" for row in observations_at(dataset, at))
    assert universe_at(dataset, datetime.fromisoformat("2024-01-05T14:30:00Z")) == (
        "SYN-B", "SYN-C"
    )


def test_advance_announcement_is_not_effective_early(dataset: Dataset) -> None:
    at = datetime.fromisoformat("2024-01-03T23:00:00Z")
    assert universe_at(dataset, at) == ("SYN-A", "SYN-B")
    assert universe_at(dataset, datetime.fromisoformat("2024-01-04T14:30:00Z")) == ("SYN-B",)


def test_late_universe_publication_does_not_leak_effective_membership(dataset: Dataset) -> None:
    raw = dataset.model_dump(mode="json")
    raw["universe_events"][3]["available_at"] = "2024-01-05T20:00:00Z"
    delayed = Dataset.model_validate(raw)
    cutoff = datetime.fromisoformat("2024-01-05T19:59:59Z")
    assert "SYN-C" not in universe_at(delayed, cutoff)
    assert all(row.asset_id != "SYN-C" for row in observations_at(delayed, cutoff))
    published = datetime.fromisoformat("2024-01-05T20:00:00Z")
    assert "SYN-C" in universe_at(delayed, published)
    assert any(row.asset_id == "SYN-C" for row in observations_at(delayed, published))


def test_exited_assets_prices_are_preserved_for_possible_holdings(dataset: Dataset) -> None:
    at = datetime.fromisoformat("2024-01-08T21:00:00Z")
    assert "SYN-A" not in universe_at(dataset, at)
    assert any(
        row.asset_id == "SYN-A" and row.field == "close" and row.observed_at == at
        for row in observations_at(dataset, at)
    )


def test_future_mutations_do_not_change_earlier_pit_results(dataset: Dataset) -> None:
    cutoff = datetime.fromisoformat("2024-01-03T21:00:00Z")
    before_observations = observations_at(dataset, cutoff)
    before_universe = universe_at(dataset, cutoff)
    raw = dataset.model_dump(mode="json")
    for row in raw["observations"]:
        if datetime.fromisoformat(row["available_at"]) > cutoff:
            row["value"] = "77777"
        if row["asset_id"] == "SYN-C":
            row["asset_id"] = "SYN-FUTURE"
    raw["universe_events"][3]["asset_id"] = "SYN-FUTURE"
    raw["corporate_actions"][2]["cash_per_share"] = "0"
    changed = Dataset.model_validate(raw)
    assert validate_dataset(changed)["status"] == "passed"
    assert observations_at(changed, cutoff) == before_observations
    assert universe_at(changed, cutoff) == before_universe
    later = datetime.fromisoformat("2024-01-08T21:00:00Z")
    assert observations_at(changed, later) != observations_at(dataset, later)
    assert universe_at(changed, later) != universe_at(dataset, later)


def test_appending_future_asset_and_prices_cannot_change_past(dataset: Dataset) -> None:
    raw = dataset.model_dump(mode="json")
    event = deepcopy(raw["universe_events"][3])
    event["asset_id"] = "SYN-D"
    raw["universe_events"].append(event)
    extra_prices = []
    for row in raw["observations"]:
        if row["asset_id"] == "SYN-C":
            new_row = dict(row, asset_id="SYN-D", value="333")
            extra_prices.append(new_row)
    raw["observations"].extend(extra_prices)
    changed = Dataset.model_validate(raw)
    cutoff = datetime.fromisoformat("2024-01-03T21:00:00Z")
    assert universe_at(changed, cutoff) == universe_at(dataset, cutoff)
    assert observations_at(changed, cutoff) == observations_at(dataset, cutoff)


def test_archive_record_order_does_not_change_pit_results(dataset: Dataset) -> None:
    raw = dataset.model_dump(mode="json")
    raw["observations"].reverse()
    raw["universe_events"].reverse()
    raw["corporate_actions"].reverse()
    reordered = Dataset.model_validate(raw)
    at = datetime.fromisoformat("2024-01-05T21:05:00Z")
    assert observations_at(reordered, at) == observations_at(dataset, at)
    assert universe_at(reordered, at) == universe_at(dataset, at)


def test_before_first_entry_returns_no_future_information(dataset: Dataset) -> None:
    at = datetime.fromisoformat("2024-01-01T23:00:00Z")
    assert observations_at(dataset, at) == ()
    assert universe_at(dataset, at) == ()


@pytest.mark.parametrize("query", [observations_at, universe_at])
def test_naive_cutoff_is_rejected(dataset: Dataset, query) -> None:
    with pytest.raises(ValueError, match="aware datetime"):
        query(dataset, datetime(2024, 1, 3))


@pytest.mark.parametrize("query", [observations_at, universe_at])
def test_pit_queries_also_block_real_archives(dataset: Dataset, query) -> None:
    raw = dataset.model_dump(mode="json")
    raw["manifest"]["kind"] = "real_archive"
    with pytest.raises(ValueError, match="real_archive is blocked"):
        query(Dataset.model_validate(raw), datetime.fromisoformat("2024-01-03T21:00:00Z"))