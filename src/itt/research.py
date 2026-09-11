"""Shared research entry points; accounting belongs exclusively to the engine."""

from datetime import datetime
from pathlib import Path

from itt import __version__
from itt.contracts import Dataset, ResearchSpec
from itt.data import load_dataset, observations_at, universe_at, validate_dataset


def capabilities() -> dict:
    from itt.engine import ENGINE_VERSION

    return {
        "version": __version__,
        "contract_version": "0.1",
        "commands": [
            "capabilities", "schema", "data validate", "data at", "spec validate",
            "research run", "runs list", "runs show", "runs replay", "runs compare",
            "decisions add", "decisions list", "market fetch", "market show",
            "market backtest", "market portfolio", "market correlation", "market trigger",
            "market guru",
        ],
        "schemas": ["dataset", "spec", "criteria", "portfolio", "correlation", "trigger", "guru"],
        "data_kinds": ["real_market_snapshot", "synthetic"],
        "market_data": {
            "kind": "real_market_snapshot", "provider": "Yahoo Finance",
            "mode": "saved_archive_criteria_and_portfolio_backtest", "pit_verified": False,
            "historical_universe_verified": False, "backtest_supported": True,
            "backtests": ["criteria-v1", "portfolio-v1"],
            "allocation": "explicit_weights_or_causal_momentum",
            "rebalance": "saved_sessions_or_monthly_or_quarterly",
            "criteria": "bounded_recursive_declarative_expressions",
            "progress": "opt_in_rpc_stream; processed_sessions_cagr_mdd",
            "analytics": ["pearson_price_returns", "retrospective_trigger_outcomes"],
            "guru": (
                "user_imported_sec_holdings; filed_at_filter; no_authenticated_feed_or_performance"
            ),
        },
        "engine": f"synthetic_daily_{ENGINE_VERSION}",
        "engine_scope": "synthetic_compatibility_only; market_backtests_use_saved_archive",
        "providers": {"github_copilot": "node_sdk_status_required; not_probed_by_python"},
        "provider_scope": "github_copilot_only",
        "usage": {"status": "reported_by_node_copilot_service", "estimated_cost": None},
        "orders": "not_supported",
    }


def inspect_data(path: Path, at: datetime | None = None) -> dict:
    dataset = load_dataset(path)
    report = validate_dataset(dataset)
    result = {"dataset_id": dataset.manifest.dataset_id, "validation": report}
    if at is not None:
        result.update({
            "at": at.isoformat(),
            "universe": universe_at(dataset, at),
            "observations": [o.model_dump(mode="json") for o in observations_at(dataset, at)],
        })
    return result


def validate_spec(spec: ResearchSpec, dataset: Dataset) -> dict:
    validate_dataset(dataset)
    spec = ResearchSpec.model_validate(spec)
    if (spec.dataset_id, spec.universe_id) != (
        dataset.manifest.dataset_id, dataset.manifest.universe_id
    ):
        raise ValueError("spec dataset/universe identifiers do not match the dataset")
    dates = [session.session_date for session in dataset.sessions]
    if spec.start not in dates or spec.end not in dates:
        raise ValueError("spec endpoints must be explicit dataset sessions")
    start_index = dates.index(spec.start)
    if start_index < spec.lookback:
        raise ValueError("insufficient warmup; performance start is not shifted")
    known = universe_at(dataset, dataset.sessions[start_index].close_at)
    if not known:
        raise ValueError("no known universe at the first decision")
    if not set(spec.weights).issubset(known):
        raise ValueError("fixed weights reference assets outside the initial known universe")
    return {
        "status": "passed", "scope": "input_contract_only", "execution_readiness": "not_checked",
        "spec": spec.model_dump(mode="json"), "external_audit": False,
    }


def execute_research(data_path: Path, spec_path: Path, store: Path | None = None) -> dict:
    from itt.engine import run_backtest
    from itt.store import save_run

    dataset = load_dataset(data_path)
    spec = ResearchSpec.model_validate_json(spec_path.read_text(encoding="utf-8"))
    result = run_backtest(dataset, spec)
    run_id = save_run(store, dataset, spec, result) if store is not None else None
    return {"run_id": run_id, "result": result}