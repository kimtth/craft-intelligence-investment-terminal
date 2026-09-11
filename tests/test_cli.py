"""New-process public CLI contract tests, separate from user interaction evidence."""

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

from itt import cli
from itt.contracts import ResearchSpec
from itt.data import load_dataset
from itt.research import validate_spec

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "tests/fixtures/p1/valid.json"
SPEC = ROOT / "tests/fixtures/p1/spec.json"


def invoke(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "itt", *args], cwd=ROOT,
        text=True, encoding="utf-8", capture_output=True, check=False,
    )


@pytest.mark.parametrize("args", [
    ("capabilities",), ("schema", "dataset"), ("schema", "spec"),
    ("data", "validate", str(DATA)), ("spec", "validate", str(SPEC), "--data", str(DATA)),
])
def test_commands_return_one_json_success(args: tuple[str, ...]) -> None:
    result = invoke(*args)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["ok"] is True
    assert len(result.stdout.splitlines()) == 1


def test_cli_pit_before_and_after_correction() -> None:
    for cutoff, expected, members in [
        ("2024-01-03T21:00:00Z", "100", ["SYN-A", "SYN-B"]),
        ("2024-01-05T21:05:00Z", "999", ["SYN-B", "SYN-C"]),
    ]:
        result = invoke("data", "at", str(DATA), "--at", cutoff)
        assert result.returncode == 0
        body = json.loads(result.stdout)["result"]
        assert body["universe"] == members
        price = [o["value"] for o in body["observations"] if o["asset_id"] == "SYN-A"
                 and o["field"] == "close" and o["observed_at"] == "2024-01-02T21:00:00Z"]
        assert price == [expected]


@pytest.mark.parametrize("args", [
    (), ("research", "run"), ("unknown-private-input",),
    ("data", "at", str(DATA), "--at", "2024-01-03T21:00:00"),
    ("data", "at", str(DATA), "--at", "private-input"),
])
def test_invalid_arguments_do_not_echo_input(args: tuple[str, ...]) -> None:
    result = invoke(*args)
    assert result.returncode == 2
    assert json.loads(result.stdout)["ok"] is False
    assert "private-input" not in result.stdout + result.stderr


def test_missing_file_is_io_failure() -> None:
    result = invoke("data", "validate", "nonexistent-private-filename.json")
    assert result.returncode == 1
    assert json.loads(result.stdout)["error"] == "io_failure"
    assert "private-filename" not in result.stdout + result.stderr


def test_schema_error_redacts_extra_field_names_and_values(tmp_path: Path) -> None:
    raw = json.loads(DATA.read_text(encoding="utf-8"))
    raw["private-input"] = "private-value"
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    result = invoke("data", "validate", str(path))
    assert result.returncode == 2
    assert json.loads(result.stdout)["error"] == "schema_rejected"
    assert "private-" not in result.stdout + result.stderr


def test_invalid_encoding_does_not_echo_bytes(tmp_path: Path) -> None:
    path = tmp_path / "bad.json"
    path.write_bytes(b"\xffprivate-value")
    result = invoke("data", "validate", str(path))
    assert result.returncode == 2
    assert json.loads(result.stdout)["error"] == "invalid_encoding"
    assert "0xff" not in result.stdout + result.stderr


@pytest.mark.parametrize("changes", [
    {"dataset_id": "other"}, {"universe_id": "other"}, {"start": "2024-01-01"},
    {"end": "2024-01-07"}, {"lookback": 1},
    {"allocation": "fixed", "weights": {"SYN-C": "0.5"}},
])
def test_spec_dataset_cross_validation_rejects_mismatch(changes: dict) -> None:
    raw = json.loads(SPEC.read_text(encoding="utf-8"))
    raw.update(changes)
    with pytest.raises(ValueError):
        validate_spec(ResearchSpec.model_validate(raw), load_dataset(DATA))


def test_fixed_allocation_cash_residual_is_allowed() -> None:
    raw = json.loads(SPEC.read_text(encoding="utf-8"))
    raw.update(allocation="fixed", weights={"SYN-A": "0.4", "SYN-B": "0.4"})
    report = validate_spec(ResearchSpec.model_validate(raw), load_dataset(DATA))
    assert report["status"] == "passed"
    assert report["scope"] == "input_contract_only"


@pytest.mark.parametrize("name,required", [
    ("correlation", {"archive_id", "symbols", "start", "end"}),
    ("trigger", {"archive_id", "symbol", "target_symbol", "start", "end", "condition"}),
    ("guru", {"filings", "as_of"}),
])
def test_analytics_public_schemas(name, required):
    process = invoke("schema", name)
    assert process.returncode == 0, process.stderr
    schema = json.loads(process.stdout)["result"]
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == required


@pytest.mark.parametrize("operation", ["correlation", "trigger", "guru"])
def test_analytics_requires_spec_and_redacts_malformed_inputs(tmp_path, operation):
    process = invoke("market", operation)
    assert process.returncode == 2
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"private-input": "private-value"}), encoding="utf-8")
    process = invoke("market", operation, "--spec", str(path))
    assert process.returncode == 2
    assert json.loads(process.stdout)["error"] == "schema_rejected"
    assert "private-" not in process.stdout + process.stderr


def cli_market_specs():
    window = {"archive_id": "77777777-7777-4777-8777-777777777777",
              "start": "2026-01-02", "end": "2026-06-30"}
    rule = {"all": [
        {"left": {"indicator": "sma", "period": 21}, "op": "gte", "right": 0},
        {"not": {"left": {"field": "close", "lag": 1}, "op": "lt", "right": "1.0250"}},
    ]}
    common = {**window, "initial_cash": "10000", "fee_bps": "10", "slippage_bps": "5",
              "entry": rule, "exit": {"left": "close", "op": "lt", "right": 0}}
    return {
        "backtest": {**common, "symbol": "AAPL"},
        "portfolio": {**common, "weights": {"AAPL": "0.4", "BRK-B": "0.5"},
                      "rebalance_every": 2, "rebalance_calendar": "monthly",
                      "allocation": {"mode": "momentum", "lookback": 63, "top_n": 2,
                                     "minimum_return": "0.0250"}},
        "correlation": {**window, "symbols": ["AAPL", "BRK-B"], "frequency": "weekly"},
        "trigger": {**window, "symbol": "AAPL", "target_symbol": "BRK-B",
                    "condition": rule, "horizons": [1, 5, 60]},
        "guru": {"as_of": "2026-09-11", "filings": [{
            "manager": "Synthetic CLI fixture", "period": "2026-06-30", "filed_at": "2026-08-14",
            "source_url": "https://www.sec.gov/Archives/fixture-only", "holdings": [
                {"cusip": "000000001", "name": "Fixture", "value_usd": "1000", "shares": "10"}],
        }]},
    }


@pytest.mark.parametrize("operation,model_name,target", [
    ("backtest", "CriteriaSpec", "run_market_backtest"),
    ("portfolio", "PortfolioSpec", "run_market_portfolio"),
    ("correlation", "CorrelationSpec", "run_market_correlation"),
    ("trigger", "TriggerSpec", "run_market_trigger"),
    ("guru", "GuruSpec", "run_guru_analysis"),
])
def test_market_cli_real_parser_and_dispatch_preserve_reviewed_specs(
        tmp_path, monkeypatch, capsys, operation, model_name, target):
    raw = cli_market_specs()[operation]
    spec_path = tmp_path / "reviewed.json"
    spec_path.write_text(json.dumps(raw), encoding="utf-8")
    store_path = tmp_path / "never-created-market"
    model = getattr(cli, model_name)
    expected = model.model_validate(raw)
    calculate = Mock(
        return_value={"operation": operation, "spec": expected.model_dump(mode="json")},
    )
    monkeypatch.setattr(cli, target, calculate)
    # These are traps, not replacement dispatch: the real CLI must select only the requested API.
    from itt import market
    fetch = Mock(side_effect=AssertionError("no market network request authorized"))
    load = Mock(side_effect=AssertionError("calculation mock owns the only read boundary"))
    monkeypatch.setattr(market, "fetch_market", fetch)
    monkeypatch.setattr(market, "load_market", load)
    args = ["market", operation, "--spec", str(spec_path)]
    if operation != "guru":
        args += ["--store", str(store_path)]
    assert cli.main(args) == 0
    output = capsys.readouterr()
    assert output.err == ""
    assert len(output.out.splitlines()) == 1, (
        "public CLI remains a single envelope, never progress NDJSON"
    )
    assert json.loads(output.out) == {"ok": True, "result": calculate.return_value}
    calculate.assert_called_once_with(
        *([expected] if operation == "guru" else [store_path, expected]),
    )
    fetch.assert_not_called()
    load.assert_not_called()
    assert not store_path.exists()
    assert json.loads(spec_path.read_text(encoding="utf-8")) == raw


def test_guru_public_cli_real_offline_calculation_and_no_store_option(tmp_path):
    raw = cli_market_specs()["guru"]
    spec_path = tmp_path / "guru.json"
    spec_path.write_text(json.dumps(raw), encoding="utf-8")
    result = invoke("market", "guru", "--spec", str(spec_path))
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""
    assert len(result.stdout.splitlines()) == 1
    assert json.loads(result.stdout) == {"ok": True, "result": cli.run_guru_analysis(raw)}
    rejected = invoke("market", "guru", "--spec", str(spec_path), "--store", "private-path")
    assert rejected.returncode == 2
    assert json.loads(rejected.stdout)["error"] == "input_rejected"
    assert "private-path" not in rejected.stdout + rejected.stderr
    assert list(tmp_path.iterdir()) == [spec_path]


@pytest.mark.parametrize("operation", ["backtest", "portfolio", "correlation", "trigger", "guru"])
def test_market_cli_invalid_spec_never_calls_calculation(tmp_path, monkeypatch, capsys, operation):
    raw = cli_market_specs()[operation]
    raw["private-field"] = "private-value"
    spec_path = tmp_path / "invalid.json"
    spec_path.write_text(json.dumps(raw), encoding="utf-8")
    target = "run_guru_analysis" if operation == "guru" else f"run_market_{operation}"
    calculate = Mock(side_effect=AssertionError("must validate before dispatch"))
    monkeypatch.setattr(cli, target, calculate)
    assert cli.main(["market", operation, "--spec", str(spec_path)]) == 2
    output = capsys.readouterr()
    assert len(output.out.splitlines()) == 1
    assert json.loads(output.out)["error"] == "schema_rejected"
    assert "private-" not in output.out + output.err
    calculate.assert_not_called()