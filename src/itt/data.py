"""Explicit synthetic dataset validation and point-in-time queries for P1."""

from collections import defaultdict
from datetime import datetime
from pathlib import Path

from itt.contracts import CorporateAction, Dataset, Observation, Session, UniverseEvent


def load_dataset(path: Path) -> Dataset:
    """Load one JSON bundle; reject schema and semantic errors before returning it."""
    dataset = Dataset.model_validate_json(path.read_text(encoding="utf-8"))
    validate_dataset(dataset)
    return dataset


def _effective_session(at: datetime, sessions: tuple[Session, ...]) -> Session:
    for session in sessions:
        if at.astimezone(session.open_at.tzinfo).date() == session.session_date:
            if at > session.open_at:
                raise ValueError("intraday effective events are unsupported by the daily contract")
            return session
    raise ValueError("effective event must fall on an explicit session date within coverage")


def validate_dataset(dataset: Dataset) -> dict:
    """Check the complete bundle, not evidence authenticity or tradability at every cutoff."""
    # Also recheck instances supplied via model_copy/model_construct by a caller.
    dataset = Dataset.model_validate(dataset)
    manifest = dataset.manifest
    if manifest.kind == "real_archive":
        raise ValueError("real_archive is blocked pending provider adapter and audit approval")

    sessions = dataset.sessions
    if (sessions[0].session_date, sessions[-1].session_date) != (
        manifest.coverage_start, manifest.coverage_end
    ):
        raise ValueError("sessions must cover the declared coverage endpoints")
    for previous, current in zip(sessions, sessions[1:], strict=False):
        if previous.session_date >= current.session_date or previous.close_at >= current.open_at:
            raise ValueError("sessions must have unique increasing dates and nonoverlapping times")
    if any(
        not manifest.coverage_start <= session.session_date <= manifest.coverage_end
        for session in sessions
    ):
        raise ValueError("session date is outside coverage")
    if sessions[-1].close_at > manifest.collected_at:
        raise ValueError("collected_at must not precede the covered sessions")

    events: dict[str, list[UniverseEvent]] = defaultdict(list)
    for event in dataset.universe_events:
        _effective_session(event.effective_at, sessions)
        if event.available_at > manifest.collected_at:
            raise ValueError("universe availability must not follow collected_at")
        events[event.asset_id].append(event)
    first_enter: dict[str, datetime] = {}
    for asset_id, asset_events in events.items():
        active = False
        effective_times: set[datetime] = set()
        ordered_events = sorted(asset_events, key=lambda item: item.effective_at)
        for event in ordered_events:
            if event.effective_at in effective_times:
                raise ValueError("duplicate or conflicting universe events at one effective time")
            effective_times.add(event.effective_at)
            if (event.action == "enter") == active:
                raise ValueError("universe events must alternate enter/exit starting with enter")
            if event.action == "enter":
                first_enter.setdefault(asset_id, event.effective_at)
            active = event.action == "enter"
        # Late publication must not expose an exit before its enter, or two enters at a PIT.
        cutoffs = {max(event.effective_at, event.available_at) for event in asset_events}
        for cutoff in sorted(cutoffs):
            visible_active = False
            for event in ordered_events:
                if event.effective_at <= cutoff and event.available_at <= cutoff:
                    if (event.action == "enter") == visible_active:
                        raise ValueError(
                            "universe publication order creates an invalid PIT sequence"
                        )
                    visible_active = event.action == "enter"

    action_ids: set[str] = set()
    action_keys: set[tuple[str, str, datetime]] = set()
    delists: dict[str, CorporateAction] = {}
    for action in dataset.corporate_actions:
        if action.action_id in action_ids:
            raise ValueError("corporate action_id must be unique")
        action_ids.add(action.action_id)
        key = (action.asset_id, action.kind, action.effective_at)
        if key in action_keys:
            raise ValueError("duplicate or conflicting corporate actions")
        action_keys.add(key)
        if action.asset_id not in first_enter:
            raise ValueError("corporate action references an unknown asset")
        _effective_session(action.effective_at, sessions)
        if action.effective_at < first_enter[action.asset_id]:
            raise ValueError("corporate action precedes asset entry")
        if action.available_at > manifest.collected_at:
            raise ValueError("corporate action availability must not follow collected_at")
        if action.available_at > action.effective_at:
            raise ValueError(
                "late corporate action publication needs an unsupported valuation policy"
            )
        if action.kind == "delist":
            if action.asset_id in delists:
                raise ValueError("asset cannot have multiple delist settlements")
            delists[action.asset_id] = action
    for action in dataset.corporate_actions:
        delist = delists.get(action.asset_id)
        if delist is not None and action.kind != "delist":
            if action.effective_at >= delist.effective_at:
                raise ValueError("corporate actions at or after delist are unsupported")
    for asset_id, delist in delists.items():
        if any(
            event.action == "enter" and event.effective_at >= delist.effective_at
            for event in events[asset_id]
        ):
            raise ValueError("asset cannot enter at or after delist")

    observation_times = {
        (field, at)
        for session in sessions
        for field, at in (("open", session.open_at), ("close", session.close_at))
    }
    versions: dict[tuple[str, str, datetime], list[Observation]] = defaultdict(list)
    for observation in dataset.observations:
        if observation.asset_id not in first_enter:
            raise ValueError("observation references an unknown asset")
        if (observation.field, observation.observed_at) not in observation_times:
            raise ValueError("raw price observed_at must match its explicit session open/close")
        if observation.observed_at < first_enter[observation.asset_id]:
            raise ValueError("price observation precedes asset entry")
        if observation.available_at > manifest.collected_at:
            raise ValueError("price availability must not follow collected_at")
        delist = delists.get(observation.asset_id)
        if delist is not None and observation.observed_at >= delist.effective_at:
            raise ValueError(
                "raw prices at or after delist are unsupported; use explicit settlement"
            )
        key = (observation.asset_id, observation.field, observation.observed_at)
        versions[key].append(observation)
    for observations in versions.values():
        ordered = sorted(observations, key=lambda item: item.revision)
        for previous, current in zip(ordered, ordered[1:], strict=False):
            if previous.revision == current.revision:
                raise ValueError("duplicate observation revision")
            if previous.available_at >= current.available_at:
                raise ValueError(
                    "revision and availability must increase together without conflicts"
                )

    for asset_id, entered_at in first_enter.items():
        delist = delists.get(asset_id)
        for session in sessions:
            if session.open_at < entered_at:
                continue
            if delist is not None and session.open_at >= delist.effective_at:
                continue
            # Membership exit does not dispose of a possible holding.
            for field, at in (("open", session.open_at), ("close", session.close_at)):
                if (asset_id, field, at) not in versions:
                    raise ValueError("missing required raw price through holding horizon or delist")

    return {
        "kind": manifest.kind,
        "checks": [
            "schema", "named_evidence_references", "session_order_and_coverage",
            "known_assets", "universe_order_and_pit_consistency", "raw_session_prices",
            "revision_uniqueness_and_availability", "corporate_actions_and_explicit_settlement",
            "prices_through_holding_horizon", "collection_time",
        ],
        "external_audit": False,
        "status": "passed",
    }


def _check_cutoff(at: datetime) -> None:
    if not isinstance(at, datetime) or at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("PIT cutoff must be an aware datetime")


def observations_at(dataset: Dataset, at: datetime) -> tuple[Observation, ...]:
    """Return available historical versions, retaining exited assets but hiding future entrants."""
    _check_cutoff(at)
    validate_dataset(dataset)
    known = {
        event.asset_id for event in dataset.universe_events
        if event.action == "enter" and event.effective_at <= at and event.available_at <= at
    }
    latest: dict[tuple[str, str, datetime], Observation] = {}
    for observation in dataset.observations:
        if observation.asset_id not in known:
            continue
        if observation.observed_at > at or observation.available_at > at:
            continue
        key = (observation.asset_id, observation.field, observation.observed_at)
        previous = latest.get(key)
        if previous is None or observation.available_at > previous.available_at:
            latest[key] = observation
    return tuple(latest[key] for key in sorted(latest))


def universe_at(dataset: Dataset, at: datetime) -> tuple[str, ...]:
    """Apply visible events in effective order; membership is not holdings or tradability."""
    _check_cutoff(at)
    validate_dataset(dataset)
    active: set[str] = set()
    ordered = sorted(dataset.universe_events, key=lambda item: (item.effective_at, item.asset_id))
    for event in ordered:
        if event.effective_at <= at and event.available_at <= at:
            if event.action == "enter":
                active.add(event.asset_id)
            else:
                active.remove(event.asset_id)
    return tuple(sorted(active))