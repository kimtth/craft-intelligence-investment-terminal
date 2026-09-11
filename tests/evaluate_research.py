"""Actual CLI process evaluation against preregistered synthetic answers.

Creates only local .itt/evaluation artifacts and UUID run bundles. No network.
"""

import json
import subprocess
import sys
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    target = ROOT / ".itt" / "evaluation" / str(uuid4())
    target.mkdir(parents=True)
    store = target / "runs"
    normal = ROOT / "tests/fixtures/p2/normal.json"
    base = json.loads((ROOT / "tests/fixtures/p2/spec.json").read_text(encoding="utf-8"))
    records = []

    def call(*args: str, expected_exit: int = 0) -> dict:
        process = subprocess.run(
            [sys.executable, "-m", "itt", *args], cwd=ROOT, capture_output=True,
            text=True, encoding="utf-8", check=False,
        )
        assert process.returncode == expected_exit, (args, process.stdout, process.stderr)
        body = json.loads(process.stdout)
        assert body["ok"] is (expected_exit == 0)
        return body.get("result", body)

    result = call("research", "run", "--data", str(normal), "--spec",
                  str(ROOT / "tests/fixtures/p2/spec.json"), "--store", str(store))
    first_id = result["run_id"]
    metrics = result["result"]["strategy"]["metrics"]
    assert Decimal(metrics["final_nav"]) == Decimal("990")
    assert Decimal(result["result"]["benchmark"]["metrics"]["final_nav"]) == Decimal("991")
    records.append({"case": "normal", "expected_nav": "990", "actual": metrics,
                    "run_id": first_id, "status": "passed"})
    replay = call("runs", "replay", first_id, "--store", str(store))
    assert replay["status"] == "verified" and replay["result"] == result["result"]
    records.append({"case": "separate_process_replay", "status": "passed"})
    rejected = call("research", "run", "--data", str(ROOT / "tests/fixtures/p1/valid.json"),
                    "--spec", str(ROOT / "tests/fixtures/p1/spec.json"), "--no-save", expected_exit=2)
    assert rejected["error"] == "input_rejected"
    records.append({"case": "delayed_required_close", "exit": 2, "status": "rejected_as_expected"})

    variant = dict(base, allocation="fixed", weights={"SYN-A": "0.7", "SYN-B": "0.2"})
    variant_path = target / "fixed-spec.json"
    variant_path.write_text(json.dumps(variant), encoding="utf-8")
    second = call("research", "run", "--data", str(normal), "--spec", str(variant_path),
                  "--store", str(store))
    compared = call("runs", "compare", first_id, second["run_id"], "--store", str(store))
    assert compared["status"] == "compatible"
    records.append({"case": "same_contract_comparison", "status": "passed"})
    note = "합성 회계 검토 / 日本語 note / synthetic only; not investment advice."
    call("decisions", "add", first_id, "--text", note, "--store", str(store))
    notes = call("decisions", "list", first_id, "--store", str(store))
    assert notes[0]["text"] == note
    records.append({"case": "separate_decision_note", "status": "passed"})

    expected = {("0", "0"): "1000", ("0", "0.01"): "990",
                ("0.01", "0"): "990", ("0.01", "0.01"): "979.92"}
    scenarios = []
    for start in ("2024-01-02", "2024-01-03"):
        for fee in ("0", "0.01"):
            for slip in ("0", "0.01"):
                spec = dict(base, start=start, fee_rate=fee, slippage_rate=slip)
                path = target / f"spec-{start}-{fee}-{slip}.json"
                path.write_text(json.dumps(spec), encoding="utf-8")
                actual = call("research", "run", "--data", str(normal), "--spec", str(path),
                              "--store", str(store))
                for name in ("strategy", "benchmark"):
                    assert actual["result"][name]["daily"][0]["date"] == start
                    assert actual["result"][name]["daily"][-1]["date"] == base["end"]
                value = actual["result"]["strategy"]["metrics"]["final_nav"]
                assert Decimal(value) == Decimal(expected[(fee, slip)])
                scenarios.append({"start": start, "end": base["end"], "fee": fee,
                                  "slippage": slip, "expected_nav": expected[(fee, slip)],
                                  "actual_nav": value, "run_id": actual["run_id"]})
    mismatch = call("runs", "compare", first_id, scenarios[0]["run_id"],
                    "--store", str(store), expected_exit=2)
    assert mismatch["error"] == "input_rejected"
    records.append({"case": "different_cost_contract_comparison", "status": "rejected_as_expected"})
    assert len(call("runs", "list", "--store", str(store))) == 10
    report = {"evaluated_at": datetime.now(UTC).isoformat(), "python": sys.executable,
              "engine_version": result["result"]["engine_version"], "synthetic": True,
              "external_audit": False, "cases": records, "sensitivity": scenarios,
              "scope": "actual offline CLI subprocesses; not TUI, Skill, or LLM evaluation"}
    report_path = target / "report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=True), encoding="utf-8")
    print(json.dumps({"report": str(report_path), "cases_passed": len(records),
                      "sensitivity_passed": len(scenarios), "runs_saved": 10}))


if __name__ == "__main__":
    main()