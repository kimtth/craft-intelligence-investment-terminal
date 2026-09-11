"""P1 input/schema/semantic tests. These do not exercise an execution engine."""

import json
from copy import deepcopy
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest
from pydantic import ValidationError

from itt.contracts import CorporateAction, Dataset, Observation, ResearchSpec
from itt.data import load_dataset, validate_dataset

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "p1"


@pytest.fixture
def bundle() -> dict:
    return json.loads((FIXTURES / "valid.json").read_text(encoding="utf-8"))


@pytest.fixture
def spec() -> dict:
    return json.loads((FIXTURES / "spec.json").read_text(encoding="utf-8"))


def test_full_static_fixture_loads_and_reports_internal_checks() -> None:
    dataset = load_dataset(FIXTURES / "valid.json")
    assert len(dataset.sessions) == 5
    assert dataset.observations[0].value == Decimal("100")
    report = validate_dataset(dataset)
    assert report["kind"] == "synthetic"
    assert report["status"] == "passed"
    assert report["external_audit"] is False
    assert "prices_through_holding_horizon" in report["checks"]
    assert "named_evidence_references" in report["checks"]
    assert len(report["checks"]) == len(set(report["checks"]))


def test_static_spec_and_decimal_roundtrip(spec: dict) -> None:
    model = ResearchSpec.model_validate(spec)
    assert model.initial_cash == Decimal("1000")
    assert model.fee_rate == Decimal("0.01")
    assert ResearchSpec.model_validate_json(model.model_dump_json()) == model


@pytest.mark.parametrize("value", ["100", "1e2", Decimal("100")])
def test_accepts_explicit_finite_decimal_values(bundle: dict, value: object) -> None:
    raw = bundle["observations"][0]
    raw["value"] = value
    assert Observation.model_validate(raw).value == Decimal("100")


@pytest.mark.parametrize(
    "value",
    [
        100, 100.0, True, None, "", " ", " 100", "100 ", "one", "1_000", "NaN",
        "Infinity", "-Infinity", "0", "-1", float("nan"), float("inf"),
        Decimal("NaN"), Decimal("Infinity"), Decimal("sNaN"),
    ],
)
def test_rejects_numeric_nonfinite_nonpositive_or_malformed_prices(
    bundle: dict, value: object
) -> None:
    bundle["observations"][0]["value"] = value
    with pytest.raises(ValidationError):
        Dataset.model_validate(bundle)


@pytest.mark.parametrize("field", ["initial_cash", "fee_rate", "slippage_rate", "quantity_step"])
@pytest.mark.parametrize("value", [1, 0.01, True, "NaN", " 1"])
def test_spec_decimal_fields_never_coerce_json_numbers(
    spec: dict, field: str, value: object
) -> None:
    spec[field] = value
    with pytest.raises(ValidationError):
        ResearchSpec.model_validate(spec)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema_version", "99"), ("dataset_id", " "), ("universe_id", ""),
        ("start", "2024-01-09"), ("start", "2024-01-02T00:00:00Z"),
        ("end", "2024-01-01"), ("initial_cash", "0"),
        ("allocation", "momentum"), ("weights", {"SYN-A": "0.5"}),
        ("rebalance_every", 0), ("rebalance_every", True), ("rebalance_every", "1"),
        ("lookback", -1), ("lookback", 0.0), ("lookback", False),
        ("fee_rate", "1"), ("fee_rate", "-0.01"), ("slippage_rate", "1"),
        ("quantity_step", "0.5"), ("benchmark", "future_constituents"),
        ("execution", "same_close"), ("valuation", "last_known_price"),
    ],
)
def test_invalid_research_spec(spec: dict, field: str, value: object) -> None:
    spec[field] = value
    with pytest.raises(ValidationError):
        ResearchSpec.model_validate(spec)


@pytest.mark.parametrize(
    "weights",
    [{}, {"SYN-A": "-0.1"}, {"SYN-A": 1}, {"": "0.5"},
     {"SYN-A": "0.6", "SYN-B": "0.5"},
     {"SYN-A": "1", "SYN-B": "0.00000000000000000000000000001"}],
)
def test_invalid_fixed_weights(spec: dict, weights: dict) -> None:
    spec.update(allocation="fixed", weights=weights)
    with pytest.raises(ValidationError):
        ResearchSpec.model_validate(spec)


def test_fixed_weights_allow_residual_cash(spec: dict) -> None:
    spec.update(allocation="fixed", weights={"SYN-A": "0.4", "SYN-B": "0.3"})
    model = ResearchSpec.model_validate(spec)
    assert sum(model.weights.values()) == Decimal("0.7")


@pytest.mark.parametrize("section", ["manifest", "sessions", "observations", "universe_events",
                                     "corporate_actions"])
def test_all_timestamp_locations_reject_naive_timestamps(bundle: dict, section: str) -> None:
    if section == "manifest":
        bundle[section]["collected_at"] = "2024-01-10T22:00:00"
    else:
        field = {"sessions": "open_at", "observations": "observed_at",
                 "universe_events": "effective_at", "corporate_actions": "available_at"}[section]
        bundle[section][0][field] = "2024-01-02T14:30:00"
    with pytest.raises(ValidationError):
        Dataset.model_validate(bundle)


@pytest.mark.parametrize("value", [1704205800, 1704205800.0, "1704205800", datetime(2024, 1, 2)])
def test_timestamp_rejects_numeric_epoch_and_naive_objects(bundle: dict, value: object) -> None:
    bundle["observations"][0]["observed_at"] = value
    with pytest.raises(ValidationError):
        Dataset.model_validate(bundle)


def test_equivalent_aware_offsets_match_session_instants(bundle: dict) -> None:
    bundle["observations"][0]["observed_at"] = "2024-01-02T09:30:00-05:00"
    bundle["observations"][0]["available_at"] = datetime(2024, 1, 2, 14, 30, tzinfo=UTC)
    assert validate_dataset(Dataset.model_validate(bundle))["status"] == "passed"


@pytest.mark.parametrize("field", ["price_versions", "universe", "corporate_actions",
                                   "delist_settlement"])
@pytest.mark.parametrize("missing", [True, False])
def test_named_evidence_is_mandatory(bundle: dict, field: str, missing: bool) -> None:
    if missing:
        del bundle["manifest"]["evidence"][field]
    else:
        bundle["manifest"]["evidence"][field] = " "
    with pytest.raises(ValidationError):
        Dataset.model_validate(bundle)


def test_an_unnamed_evidence_list_is_not_sufficient(bundle: dict) -> None:
    bundle["manifest"]["evidence"] = ["some reference"]
    with pytest.raises(ValidationError):
        Dataset.model_validate(bundle)


@pytest.mark.parametrize("section", ["universe_events", "corporate_actions"])
def test_events_need_evidence_sources(bundle: dict, section: str) -> None:
    bundle[section][0]["source"] = ""
    with pytest.raises(ValidationError):
        Dataset.model_validate(bundle)


@pytest.mark.parametrize(
    ("field", "value"),
    [("revision", 0), ("revision", 1.0), ("revision", True), ("adjustment", "adjusted"),
     ("available_at", "2024-01-02T14:29:59Z"), ("asset_id", " ")],
)
def test_observation_schema_rejects_invalid_semantics(
    bundle: dict, field: str, value: object
) -> None:
    bundle["observations"][0][field] = value
    with pytest.raises(ValidationError):
        Dataset.model_validate(bundle)


@pytest.mark.parametrize("field", ["cash_per_share", "pay_at"])
@pytest.mark.parametrize("index", [1, 2])
def test_dividend_and_delist_need_explicit_cash_and_payment(
    bundle: dict, field: str, index: int
) -> None:
    del bundle["corporate_actions"][index][field]
    with pytest.raises(ValidationError, match="explicit cash_per_share and pay_at"):
        Dataset.model_validate(bundle)


@pytest.mark.parametrize(
    ("index", "field", "value"),
    [(0, "ratio", None), (0, "ratio", "0"), (0, "ratio", 2),
     (0, "cash_per_share", "1"), (0, "pay_at", "2024-01-08T14:30:00Z"),
     (1, "ratio", "2"), (1, "cash_per_share", "-1"), (2, "cash_per_share", 0),
     (2, "pay_at", "2024-01-05T14:30:00Z"), (2, "pay_at", "2024-01-10T14:30:00")],
)
def test_action_fields_must_match_kind_and_have_valid_values(
    bundle: dict, index: int, field: str, value: object
) -> None:
    bundle["corporate_actions"][index][field] = value
    with pytest.raises(ValidationError):
        Dataset.model_validate(bundle)


def test_explicit_evidenced_zero_settlement_is_not_unknown(bundle: dict) -> None:
    bundle["corporate_actions"][2]["cash_per_share"] = "0"
    assert validate_dataset(Dataset.model_validate(bundle))["status"] == "passed"


def test_preannounced_actions_and_payment_beyond_horizon_are_valid(bundle: dict) -> None:
    action = CorporateAction.model_validate(bundle["corporate_actions"][2])
    assert action.available_at < action.effective_at
    assert action.pay_at is not None
    assert action.pay_at.date() > Dataset.model_validate(bundle).manifest.coverage_end


@pytest.mark.parametrize("change", ["duplicate", "reverse", "coverage", "wrong_date"])
def test_session_order_dates_and_coverage(bundle: dict, change: str) -> None:
    if change == "duplicate":
        bundle["sessions"].insert(1, deepcopy(bundle["sessions"][0]))
    elif change == "reverse":
        bundle["sessions"][1:3] = reversed(bundle["sessions"][1:3])
    elif change == "coverage":
        bundle["manifest"]["coverage_end"] = "2024-01-09"
    else:
        bundle["sessions"][0]["session_date"] = "2024-01-01"
    with pytest.raises(ValueError):
        validate_dataset(Dataset.model_validate(bundle))


@pytest.mark.parametrize(
    "timestamp", ["2024-01-02T15:00:00Z", "2024-01-06T14:30:00Z"]
)
def test_prices_cannot_invent_session_timestamps(bundle: dict, timestamp: str) -> None:
    bundle["observations"][0].update(observed_at=timestamp, available_at=timestamp)
    with pytest.raises(ValueError, match="session open/close"):
        validate_dataset(Dataset.model_validate(bundle))


@pytest.mark.parametrize("section", ["observations", "corporate_actions"])
def test_unknown_assets_are_rejected(bundle: dict, section: str) -> None:
    bundle[section][0]["asset_id"] = "UNKNOWN"
    with pytest.raises(ValueError, match="unknown asset"):
        validate_dataset(Dataset.model_validate(bundle))


@pytest.mark.parametrize("change", ["duplicate", "same_availability", "reversed_availability"])
def test_duplicate_or_nonmonotonic_revisions_are_rejected(bundle: dict, change: str) -> None:
    if change == "duplicate":
        bundle["observations"].append(deepcopy(bundle["observations"][1]))
    elif change == "same_availability":
        bundle["observations"][-1]["available_at"] = "2024-01-02T21:00:00Z"
    else:
        bundle["observations"][1]["available_at"] = "2024-01-06T21:00:00Z"
    with pytest.raises(ValueError, match="revision|availability"):
        validate_dataset(Dataset.model_validate(bundle))


@pytest.mark.parametrize("change", ["duplicate", "conflict", "double_enter", "exit_first"])
def test_invalid_universe_sequences_are_rejected(bundle: dict, change: str) -> None:
    if change in {"duplicate", "conflict"}:
        event = deepcopy(bundle["universe_events"][0])
        if change == "conflict":
            event["action"] = "exit"
        bundle["universe_events"].append(event)
    elif change == "double_enter":
        bundle["universe_events"][2]["action"] = "enter"
    else:
        bundle["universe_events"][0]["action"] = "exit"
    with pytest.raises(ValueError, match="universe"):
        validate_dataset(Dataset.model_validate(bundle))


def test_publication_cannot_expose_exit_before_entry(bundle: dict) -> None:
    bundle["universe_events"][0]["available_at"] = "2024-01-05T14:30:00Z"
    with pytest.raises(ValueError, match="invalid PIT sequence"):
        validate_dataset(Dataset.model_validate(bundle))


@pytest.mark.parametrize("change", ["same_id", "same_action_new_id"])
def test_duplicate_action_identity_or_content_is_rejected(bundle: dict, change: str) -> None:
    action = deepcopy(bundle["corporate_actions"][0])
    if change == "same_action_new_id":
        action["action_id"] = "different-id"
    bundle["corporate_actions"].append(action)
    with pytest.raises(ValueError, match="action_id|conflicting corporate"):
        validate_dataset(Dataset.model_validate(bundle))


def test_late_action_cannot_silently_reconstruct_valuation(bundle: dict) -> None:
    bundle["corporate_actions"][2]["available_at"] = "2024-01-08T15:00:00Z"
    with pytest.raises(ValueError, match="unsupported valuation policy"):
        validate_dataset(Dataset.model_validate(bundle))


@pytest.mark.parametrize("section", ["universe_events", "corporate_actions"])
def test_intraday_effective_events_are_explicitly_unsupported(bundle: dict, section: str) -> None:
    bundle[section][0]["effective_at"] = "2024-01-04T15:00:00Z"
    with pytest.raises(ValueError, match="intraday"):
        validate_dataset(Dataset.model_validate(bundle))


@pytest.mark.parametrize("index", [0, 5, 9, 19])
def test_missing_open_or_close_is_never_filled_even_after_exit(bundle: dict, index: int) -> None:
    # SYN-A exits on Jan 4: its Jan 4 and Jan 8 prices remain mandatory for possible holdings.
    del bundle["observations"][index]
    with pytest.raises(ValueError, match="missing required raw price"):
        validate_dataset(Dataset.model_validate(bundle))


def test_membership_exit_does_not_replace_delist_evidence(bundle: dict) -> None:
    bundle["corporate_actions"] = bundle["corporate_actions"][:2]
    with pytest.raises(ValueError, match="missing required raw price"):
        validate_dataset(Dataset.model_validate(bundle))


def test_no_price_is_required_after_evidenced_delist(bundle: dict) -> None:
    dataset = Dataset.model_validate(bundle)
    assert not any(
        observation.asset_id == "SYN-B" and observation.observed_at.day == 8
        for observation in dataset.observations
    )
    assert validate_dataset(dataset)["status"] == "passed"


@pytest.mark.parametrize("section", ["observations", "universe_events", "corporate_actions"])
def test_collection_cannot_precede_available_records(bundle: dict, section: str) -> None:
    bundle[section][0]["available_at"] = "2024-02-01T00:00:00Z"
    with pytest.raises(ValueError, match="collected_at"):
        validate_dataset(Dataset.model_validate(bundle))


def test_real_archive_is_blocked_with_safe_fixed_message(bundle: dict, tmp_path: Path) -> None:
    bundle["manifest"]["kind"] = "real_archive"
    path = tmp_path / "archive.json"
    path.write_text(json.dumps(bundle), encoding="utf-8")
    with pytest.raises(ValueError) as error:
        load_dataset(path)
    assert str(error.value) == (
        "real_archive is blocked pending provider adapter and audit approval"
    )


@pytest.mark.parametrize("change", ["numeric_price", "missing_price", "missing_settlement",
                                     "missing_evidence", "duplicate_revision"])
def test_loader_checks_schema_and_all_semantics(
    bundle: dict, tmp_path: Path, change: str
) -> None:
    if change == "numeric_price":
        bundle["observations"][0]["value"] = 100
    elif change == "missing_price":
        del bundle["observations"][19]
    elif change == "missing_settlement":
        del bundle["corporate_actions"][2]["cash_per_share"]
    elif change == "missing_evidence":
        del bundle["manifest"]["evidence"]["universe"]
    else:
        bundle["observations"].append(deepcopy(bundle["observations"][0]))
    path = tmp_path / "invalid.json"
    path.write_text(json.dumps(bundle), encoding="utf-8")
    with pytest.raises(ValueError):
        load_dataset(path)


def test_validate_rechecks_models_copied_without_validation() -> None:
    dataset = load_dataset(FIXTURES / "valid.json")
    bad_observation = dataset.observations[0].model_copy(update={"value": 100})
    bad_dataset = dataset.model_copy(update={"observations": (bad_observation,)})
    with pytest.raises(ValidationError):
        validate_dataset(bad_dataset)


def test_unknown_fields_are_not_silently_ignored(bundle: dict) -> None:
    bundle["fill_missing_prices"] = "last"
    with pytest.raises(ValidationError):
        Dataset.model_validate(bundle)