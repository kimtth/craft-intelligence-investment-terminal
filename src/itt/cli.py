"""Noninteractive JSON CLI. 0=success, 2=input rejected, 1=I/O failure."""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from pydantic import ValidationError

from itt.analytics import (
    CorrelationSpec,
    TriggerSpec,
    run_market_correlation,
    run_market_trigger,
)
from itt.contracts import Dataset, ResearchSpec
from itt.criteria import CriteriaSpec, run_market_backtest
from itt.data import load_dataset
from itt.guru import GuruSpec, run_guru_analysis
from itt.portfolio import PortfolioSpec, run_market_portfolio
from itt.research import capabilities, execute_research, inspect_data, validate_spec


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # Do not echo arbitrary input (which could contain credentials) into error output.
        raise ValueError("invalid command arguments; use --help for explicit syntax")


def parser() -> Parser:
    root = Parser(description="Investment research and real market snapshots; no LLM calls")
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("capabilities")
    market = commands.add_parser("market").add_subparsers(dest="operation", required=True)
    for operation in ("fetch", "show"):
        command = market.add_parser(operation)
        command.add_argument("--store", type=Path, default=Path(".itt/market"))
        if operation == "fetch":
            command.add_argument("symbols", nargs="+")
            command.add_argument("--start", help="Inclusive YYYY-MM-DD; requires --end")
            command.add_argument("--end", help="Inclusive YYYY-MM-DD; requires --start")
    for operation in ("backtest", "portfolio", "correlation", "trigger"):
        backtest = market.add_parser(operation)
        backtest.add_argument("--spec", required=True, type=Path)
        backtest.add_argument("--store", type=Path, default=Path(".itt/market"))
    market.add_parser("guru").add_argument("--spec", required=True, type=Path)
    schema = commands.add_parser("schema")
    schema.add_argument("name", choices=["dataset", "spec", "criteria", "portfolio",
                                         "correlation", "trigger", "guru"])
    data = commands.add_parser("data").add_subparsers(dest="operation", required=True)
    data.add_parser("validate").add_argument("path", type=Path)
    at = data.add_parser("at")
    at.add_argument("path", type=Path)
    at.add_argument("--at", required=True)
    spec = commands.add_parser("spec").add_subparsers(dest="operation", required=True)
    validate = spec.add_parser("validate")
    validate.add_argument("path", type=Path)
    validate.add_argument("--data", required=True, type=Path)
    research = commands.add_parser("research").add_subparsers(dest="operation", required=True)
    run = research.add_parser("run")
    run.add_argument("--data", required=True, type=Path)
    run.add_argument("--spec", required=True, type=Path)
    run.add_argument("--store", type=Path, default=Path(".itt/runs"))
    run.add_argument("--no-save", action="store_true")
    runs = commands.add_parser("runs").add_subparsers(dest="operation", required=True)
    for operation in ("list", "show", "replay", "compare"):
        command = runs.add_parser(operation)
        command.add_argument("--store", type=Path, default=Path(".itt/runs"))
        if operation == "compare":
            command.add_argument("ids", nargs="+")
        elif operation != "list":
            command.add_argument("id")
    decisions = commands.add_parser("decisions").add_subparsers(dest="operation", required=True)
    for operation in ("add", "list"):
        command = decisions.add_parser(operation)
        command.add_argument("id")
        command.add_argument("--store", type=Path, default=Path(".itt/runs"))
        if operation == "add":
            command.add_argument("--text", required=True)
    return root


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        if args.command == "capabilities":
            result = capabilities()
        elif args.command == "market":
            from itt.market import fetch_market, load_market

            if args.operation == "guru":
                spec = GuruSpec.model_validate_json(args.spec.read_text(encoding="utf-8"))
                result = run_guru_analysis(spec)
            elif args.operation == "backtest":
                spec = CriteriaSpec.model_validate_json(args.spec.read_text(encoding="utf-8"))
                result = run_market_backtest(args.store, spec)
            elif args.operation == "portfolio":
                spec = PortfolioSpec.model_validate_json(args.spec.read_text(encoding="utf-8"))
                result = run_market_portfolio(args.store, spec)
            elif args.operation == "correlation":
                spec = CorrelationSpec.model_validate_json(args.spec.read_text(encoding="utf-8"))
                result = run_market_correlation(args.store, spec)
            elif args.operation == "trigger":
                spec = TriggerSpec.model_validate_json(args.spec.read_text(encoding="utf-8"))
                result = run_market_trigger(args.store, spec)
            else:
                result = (fetch_market(args.symbols, args.store, start=args.start, end=args.end)
                          if args.operation == "fetch"
                          else load_market(args.store))
        elif args.command == "schema":
            model = {"dataset": Dataset, "spec": ResearchSpec, "criteria": CriteriaSpec,
                     "portfolio": PortfolioSpec, "correlation": CorrelationSpec,
                     "trigger": TriggerSpec, "guru": GuruSpec}[args.name]
            result = model.model_json_schema()
        elif args.command == "data":
            at = None
            if args.operation == "at":
                try:
                    at = datetime.fromisoformat(args.at)
                except ValueError as exc:
                    raise ValueError("--at requires an aware ISO 8601 timestamp") from exc
            result = inspect_data(args.path, at)
        elif args.command == "spec":
            spec = ResearchSpec.model_validate_json(args.path.read_text(encoding="utf-8"))
            result = validate_spec(spec, load_dataset(args.data))
        elif args.command == "research":
            result = execute_research(args.data, args.spec, None if args.no_save else args.store)
        else:
            from itt import store

            if args.command == "decisions":
                if args.operation == "add":
                    result = {"decision_id": store.add_decision(args.store, args.id, args.text)}
                else:
                    result = store.list_decisions(args.store, args.id)
            elif args.operation == "list":
                result = store.list_runs(args.store)
            elif args.operation == "show":
                result = store.load_run(args.store, args.id)
            elif args.operation == "replay":
                result = store.replay_run(args.store, args.id)
            else:
                result = store.compare_runs(args.store, args.ids)
    except ValidationError as exc:
        # Never emit Pydantic's input or ctx fields: they can contain arbitrary user text.
        errors = [{"type": error["type"]} for error in exc.errors()]
        print(json.dumps({"ok": False, "error": "schema_rejected", "details": errors}))
        return 2
    except UnicodeError:
        print(json.dumps({"ok": False, "error": "invalid_encoding"}))
        return 2
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": "input_rejected", "message": str(exc)}))
        return 2
    except OSError:
        print(json.dumps({"ok": False, "error": "io_failure"}))
        print("Unable to read a required local file.", file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())