"""RPC process contracts, not a claim of TUI interaction or financial audit.

Subprocesses use sys.executable: run this suite with the repository .venv Python.
Spawn targets are module-level; no worker is launched during module import.
"""

import io
import json
import subprocess
import sys
from functools import partial
from pathlib import Path
from queue import Queue
from threading import Event, Thread, current_thread, main_thread
from time import monotonic
from unittest.mock import Mock
from uuid import UUID, uuid4

import pytest

from itt import research, rpc, store
from itt.contracts import ResearchSpec
from itt.data import load_dataset
from itt.engine import run_backtest

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "tests/fixtures/p2/normal.json"
SPEC = ROOT / "tests/fixtures/p2/spec.json"
PRIVATE = "private-input-secret-sentinel"
WAIT = 20


def envelope(method, params=None, request_id=1):
    return {"id": request_id, "method": method, "params": {} if params is None else params}


def start_params(root):
    return {"data": str(DATA), "spec": str(SPEC), "store": str(root)}


class Client:
    """Read stdout on a thread so a broken protocol fails rather than hangs pytest."""

    def __init__(self):
        self.process = subprocess.Popen(
            [sys.executable, "-m", "itt.rpc"], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.lines = Queue()
        self.stderr = b""
        self.sequence = 0
        self.reader = Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        for line in self.process.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def raw(self, line):
        self.process.stdin.write(line + b"\n")
        self.process.stdin.flush()
        response = self.lines.get(timeout=WAIT)
        assert response is not None, "RPC process exited before responding"
        body = json.loads(response)
        assert "event" not in body
        assert type(body["ok"]) is bool
        assert set(body) == ({"id", "ok", "result"} if body["ok"] else {"id", "ok", "error"})
        if not body["ok"]:
            assert body["error"] == rpc._error(body["error"]["code"])
            assert PRIVATE not in response.decode("utf-8")
        return body

    def send(self, body):
        return self.raw(json.dumps(body, ensure_ascii=True).encode("utf-8"))

    def call(self, method, params=None):
        self.sequence += 1
        response = self.send(envelope(method, params, self.sequence))
        assert response["id"] == self.sequence
        return response

    def result(self, method, params=None):
        response = self.call(method, params)
        assert response["ok"], response
        return response["result"]

    def terminal_status(self):
        deadline = monotonic() + WAIT
        while monotonic() < deadline:
            status = self.result("jobs.status")
            assert set(status) == {"job_id", "status", "phase", "run_id", "error"}
            assert "percent" not in status and "pnl" not in status
            if status["status"] != "running":
                return status
        pytest.fail("Research did not reach a terminal status")

    def close(self):
        if not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=WAIT)
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait(timeout=WAIT)
        self.reader.join(timeout=WAIT)
        assert not self.reader.is_alive()
        self.stderr = self.process.stderr.read()
        self.process.stdout.close()
        self.process.stderr.close()
        assert self.process.returncode == 0
        assert self.stderr == b""
        assert self.lines.get(timeout=WAIT) is None, "Unexpected unsolicited stdout"


@pytest.fixture
def client():
    instance = Client()
    try:
        yield instance
    finally:
        instance.close()


def test_subprocess_capabilities_validation_and_idle(client, tmp_path):
    actual = client.result("capabilities")
    for key, value in research.capabilities().items():
        assert actual[key] == value
    assert actual["rpc"] == {
        "version": "0.1", "transport": "stdio_ndjson", "methods": list(rpc.METHODS),
        "max_active_jobs": 1, "events": "opt_in_correlated_market_progress",
    }
    assert client.result("data.validate", {"path": str(DATA)}) == research.inspect_data(DATA)
    assert client.result("jobs.status") == {
        "job_id": None, "status": "idle", "phase": None, "run_id": None, "error": None,
    }
    root = tmp_path / "missing"
    assert client.result("runs.list", {"store": str(root)}) == []
    assert not root.exists()
    assert client.call("jobs.cancel", {"job_id": str(uuid4())})["error"]["code"] == "job_not_found"
    for request_id in (1, 9999, "ui-1", "a.B_c:9", "x" * 64):
        response = client.send(envelope("capabilities", request_id=request_id))
        assert response["ok"] and response["id"] == request_id


def test_subprocess_invalid_ids_and_envelopes_do_not_echo(client):
    for request_id in (None, True, False, 0, -1, 1.5, [], {}, "", "x" * 65,
                       "한글", f"{PRIVATE}/x", f"{PRIVATE}\n"):
        response = client.send(envelope("capabilities", request_id=request_id))
        assert response == {"id": None, "ok": False, "error": rpc._error("invalid_request")}
    for body in (None, [], {}, {"id": 1, "method": "capabilities"},
                 {**envelope("capabilities"), PRIVATE: PRIVATE},
                 envelope(123), envelope("capabilities", [])):
        response = client.send(body)
        assert response["id"] is None
        assert response["error"]["code"] == "invalid_request"


def test_subprocess_json_errors_and_unknown_methods_are_fixed(client):
    for line in (b"", b"\xffprivate-input-secret-sentinel", b"{private-input-secret-sentinel",
                 b'{"id":1,"id":2,"method":"capabilities","params":{}}',
                 b'{"id":NaN,"method":"capabilities","params":{}}'):
        assert client.raw(line) == {
            "id": None, "ok": False, "error": rpc._error("invalid_json"),
        }
    for method in (PRIVATE, "__dict__", "__import__", "store.save_run", "research.run",
                   "runs.compare", "schema", "dispatch", "close"):
        response = client.call(method)
        assert response["error"]["code"] == "method_not_found"
        assert method not in json.dumps(response["error"])
    assert client.result("capabilities")["rpc"]["events"] == "opt_in_correlated_market_progress"


def test_subprocess_params_are_explicit_and_strict(client, tmp_path):
    root = str(tmp_path / "runs")
    run = {"store": root, "id": str(uuid4())}
    valid_shapes = {
        "capabilities": {}, "jobs.status": {}, "data.validate": {"path": str(DATA)},
        "research.start": start_params(root), "jobs.cancel": {"job_id": str(uuid4())},
        "runs.list": {"store": root}, "runs.show": run, "runs.replay": run,
        "decisions.add": {**run, "text": "note"}, "decisions.list": run,
    }
    for method, params in valid_shapes.items():
        response = client.call(method, {**params, PRIVATE: PRIVATE})
        assert response["error"]["code"] == "invalid_params"
        for key in params:
            missing = {name: value for name, value in params.items() if name != key}
            assert client.call(method, missing)["error"]["code"] == "invalid_params"
    for method, params in (
        ("research.start", {**start_params(root), "data": 1}),
        ("data.validate", {"path": None}),
        ("data.validate", {"path": ""}),
        ("data.validate", {"path": "https://example.invalid/" + PRIVATE}),
        ("data.validate", {"path": "\\\\server\\" + PRIVATE}),
        ("data.validate", {"path": "file:///" + PRIVATE}),
        ("runs.list", {"store": "//server/" + PRIVATE}),
        ("runs.show", {**run, "id": "../" + PRIVATE}),
        ("runs.show", {**run, "id": True}),
        ("jobs.cancel", {"job_id": PRIVATE}),
        ("decisions.add", {**run, "text": " \n "}),
        ("decisions.add", {**run, "text": 123}),
    ):
        assert client.call(method, params)["error"]["code"] == "invalid_params"


def test_subprocess_complete_show_replay_and_decisions_match_shared_engine(client, tmp_path):
    root = tmp_path / "runs"
    started = client.result("research.start", start_params(root))
    assert set(started) == {"job_id", "status"}
    assert str(UUID(started["job_id"])) == started["job_id"]
    assert started["status"] == "running"
    status = client.terminal_status()
    assert status == {
        "job_id": started["job_id"], "status": "completed", "phase": "completed",
        "run_id": status["run_id"], "error": None,
    }
    assert str(UUID(status["run_id"])) == status["run_id"]
    params = {"store": str(root), "id": status["run_id"]}
    expected = run_backtest(load_dataset(DATA), ResearchSpec.model_validate_json(
        SPEC.read_text(encoding="utf-8"),
    ))
    shown = client.result("runs.show", params)
    assert shown == store.load_run(root, status["run_id"])
    assert shown["result"] == expected
    replay = client.result("runs.replay", params)
    assert replay["status"] == "verified" and replay["result"] == expected
    assert client.result("runs.list", {"store": str(root)}) == store.list_runs(root)
    assert client.result("decisions.list", params) == []
    text = "검토 / 再確認 — synthetic only\nKeep original note text."
    decision = client.result("decisions.add", {**params, "text": text})
    assert str(UUID(decision["decision_id"])) == decision["decision_id"]
    notes = client.result("decisions.list", params)
    assert notes == store.list_decisions(root, status["run_id"])
    assert notes[0]["text"] == text
    assert notes[0]["id"] == decision["decision_id"]
    assert client.result("runs.show", params) == shown
    assert client.call("jobs.cancel", {"job_id": started["job_id"]})["error"]["code"] == "too_late"
    replacement = client.result("research.start", start_params(root))
    assert replacement["job_id"] != started["job_id"]
    assert client.terminal_status()["status"] == "completed"
    assert len(client.result("runs.list", {"store": str(root)})) == 2


def test_subprocess_file_schema_encoding_and_worker_errors_redact(client, tmp_path):
    missing = tmp_path / (PRIVATE + ".json")
    assert client.call("data.validate", {"path": str(missing)})["error"]["code"] == "io_failure"
    bad = tmp_path / "bad.json"
    bad.write_bytes(b"\xffprivate-input-secret-sentinel")
    assert client.call("data.validate", {"path": str(bad)})["error"]["code"] == "invalid_encoding"
    raw = json.loads(DATA.read_text(encoding="utf-8"))
    raw[PRIVATE] = PRIVATE
    bad.write_text(json.dumps(raw), encoding="utf-8")
    assert client.call("data.validate", {"path": str(bad)})["error"]["code"] == "schema_rejected"
    for data_path, spec_path, code in (
        (bad, SPEC, "schema_rejected"), (missing, SPEC, "io_failure"),
        (DATA, bad, "schema_rejected"),
    ):
        root = tmp_path / "no-publication"
        started = client.result("research.start", {
            "data": str(data_path), "spec": str(spec_path), "store": str(root),
        })
        status = client.terminal_status()
        assert status == {
            "job_id": started["job_id"], "status": "failed", "phase": "failed",
            "run_id": None, "error": rpc._error(code),
        }
        assert PRIVATE not in json.dumps(status)
        assert not root.exists()
    bad_store = tmp_path / "bad-store"
    bad_store.mkdir()
    (bad_store / str(uuid4())).mkdir()
    response = client.call("runs.list", {"store": str(bad_store)})
    assert response["error"] == rpc._error("input_rejected")


def test_subprocess_engine_error_does_not_echo_private_asset(client, tmp_path):
    raw = json.loads(DATA.read_text(encoding="utf-8"))
    cutoff = raw["sessions"][1]["open_at"]
    for row in raw["observations"] + raw["universe_events"]:
        if row["asset_id"] == "SYN-A":
            row["asset_id"] = PRIVATE
    for row in raw["observations"]:
        if row["asset_id"] == PRIVATE and row["observed_at"] == cutoff:
            row["available_at"] = raw["sessions"][1]["close_at"]
    path = tmp_path / "late.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    # Complete coverage passes validation; next-open execution lacks an available price.
    assert client.result("data.validate", {"path": str(path)})["validation"]["status"] == "passed"
    root = tmp_path / "runs"
    client.result("research.start", {**start_params(root), "data": str(path)})
    status = client.terminal_status()
    assert status["status"] == "failed" and status["run_id"] is None
    assert status["error"] == rpc._error("input_rejected")
    assert PRIVATE not in json.dumps(status)
    assert not root.exists()


def controlled_worker(ready, release, sender, data, spec):
    """Importable spawn target: readiness + release signals, never arbitrary sleeps."""
    try:
        sender.send(("phase", "validating"))
        sender.send(("phase", "calculating"))
        ready.set()
        if release.wait(timeout=WAIT):
            rpc._research_worker(sender, data, spec)
    finally:
        sender.close()


def dead_worker(sender, data, spec):
    sender.close()


def malformed_worker(sender, data, spec):
    sender.send((PRIVATE, PRIVATE))
    sender.close()


@pytest.fixture
def controlled(monkeypatch, tmp_path):
    server = rpc.RPCServer()
    ready, release = server.job.context.Event(), server.job.context.Event()
    monkeypatch.setattr(rpc, "_research_worker", partial(controlled_worker, ready, release))
    root = tmp_path / "runs"
    started = server.handle(json.dumps(envelope("research.start", start_params(root))).encode())
    try:
        assert started["ok"]
        assert ready.wait(timeout=WAIT), "Spawn worker never signalled readiness"
        server.job.advance(Event())
        assert server.job.state["phase"] == "calculating"
        yield server, root, release
    finally:
        server.job.close()


def test_busy_cancel_reaps_spawn_child_and_never_saves(controlled, monkeypatch):
    server, root, _ = controlled
    job = server.job
    process, receiver = job.process, job.receiver
    assert process.is_alive()
    save = Mock(side_effect=AssertionError("cancelled work must not be saved"))
    monkeypatch.setattr(store, "save_run", save)
    busy = server.handle(json.dumps(envelope("research.start", start_params(root))).encode())
    assert busy["error"] == rpc._error("busy")
    job_id = job.state["job_id"]
    response = server.handle(json.dumps(envelope("jobs.cancel", {"job_id": job_id})).encode())
    assert response["result"] == {"job_id": job_id, "status": "cancelled"}
    assert job.status() == {
        "job_id": job_id, "status": "cancelled", "phase": "cancelled",
        "run_id": None, "error": None,
    }
    assert process._closed and receiver.closed
    assert job.process is None and job.receiver is None
    job.advance(Event())
    save.assert_not_called()
    assert not root.exists()
    with pytest.raises(rpc.RPCError, match=rpc.ERRORS["too_late"]):
        job.cancel(job_id)
    with pytest.raises(rpc.RPCError, match=rpc.ERRORS["job_not_found"]):
        job.cancel(str(uuid4()))


def test_eof_reaps_computing_child_without_publication(controlled, monkeypatch):
    server, root, _ = controlled
    process, receiver = server.job.process, server.job.receiver
    save = Mock()
    monkeypatch.setattr(store, "save_run", save)
    sink = io.StringIO()
    assert rpc.serve(io.BytesIO(b""), sink, server) == 0
    assert process._closed and receiver.closed
    assert sink.getvalue() == ""
    save.assert_not_called()
    assert not root.exists()


def test_eof_discards_even_a_ready_unaccepted_result(tmp_path, monkeypatch):
    job = rpc.ResearchJob()
    job.state.update(job_id=str(uuid4()), status="running", phase="calculating")
    job.store_path = tmp_path / "runs"
    job.process = Mock(pid=123)
    job.process.is_alive.side_effect = [True, False]
    job.receiver = Mock()
    job.receiver.poll.return_value = True
    job.receiver.recv.return_value = ("result", {}, {}, {})
    process, receiver = job.process, job.receiver
    save = Mock()
    monkeypatch.setattr(store, "save_run", save)
    eof = Event()
    eof.set()
    job.advance(eof)
    receiver.recv.assert_not_called()
    job.close()
    process.terminate.assert_called_once()
    process.join.assert_called_once_with(timeout=2)
    process.close.assert_called_once()
    receiver.close.assert_called_once()
    save.assert_not_called()


def test_cancel_wins_over_buffered_result_while_child_is_alive(tmp_path, monkeypatch):
    job = rpc.ResearchJob()
    job_id = str(uuid4())
    job.state.update(job_id=job_id, status="running", phase="calculating")
    job.store_path = tmp_path / "runs"
    job.process = Mock(pid=123)
    job.process.is_alive.side_effect = [True, True, False]
    job.receiver = Mock()
    job.receiver.poll.return_value = True
    job.receiver.recv.return_value = ("result", {}, {}, {})
    receiver = job.receiver
    save = Mock()
    monkeypatch.setattr(store, "save_run", save)
    assert job.cancel(job_id) == {"job_id": job_id, "status": "cancelled"}
    job.advance(Event())
    receiver.recv.assert_not_called()
    receiver.close.assert_called_once()
    save.assert_not_called()


def test_eof_during_receive_discards_payload_before_storing(tmp_path, monkeypatch):
    job = rpc.ResearchJob()
    job.state.update(job_id=str(uuid4()), status="running", phase="calculating")
    job.store_path = tmp_path / "runs"
    job.process = Mock(pid=123)
    job.process.is_alive.return_value = False
    job.receiver = Mock()
    job.receiver.poll.return_value = True
    eof = Event()

    def receive():
        eof.set()
        return ("result", {}, {}, {})

    job.receiver.recv.side_effect = receive
    save = Mock()
    monkeypatch.setattr(store, "save_run", save)
    try:
        job.advance(eof)
        assert job.state["phase"] == "calculating"
        save.assert_not_called()
    finally:
        job.close()


def finish(job):
    deadline = monotonic() + WAIT
    while job.state["status"] == "running" and monotonic() < deadline:
        if job.receiver is not None:
            try:
                job.receiver.poll(0.05)
            except (OSError, EOFError):
                pass  # The production advance() owns dead-pipe failure handling.
        job.advance(Event())
    assert job.state["status"] != "running"
    return job.status()


@pytest.mark.parametrize("target", [dead_worker, malformed_worker])
def test_dead_or_invalid_worker_fails_instead_of_hanging(target, tmp_path, monkeypatch):
    monkeypatch.setattr(rpc, "_research_worker", target)
    job = rpc.ResearchJob()
    try:
        job.start(str(DATA), str(SPEC), str(tmp_path / "runs"))
        assert finish(job)["error"] == rpc._error("worker_failed")
        assert job.state["run_id"] is None
        assert job.process is None and job.receiver is None
        assert not (tmp_path / "runs").exists()
    finally:
        job.close()


def test_dead_worker_cancellation_is_too_late_before_result_acceptance(tmp_path, monkeypatch):
    monkeypatch.setattr(rpc, "_research_worker", dead_worker)
    job = rpc.ResearchJob()
    try:
        started = job.start(str(DATA), str(SPEC), str(tmp_path / "runs"))
        job.process.join(timeout=WAIT)
        assert not job.process.is_alive()
        with pytest.raises(rpc.RPCError, match=rpc.ERRORS["too_late"]):
            job.cancel(started["job_id"])
        assert finish(job)["status"] == "failed"
    finally:
        job.close()


def test_parent_save_failure_is_fixed_and_storing_cannot_be_cancelled(tmp_path, monkeypatch):
    job = rpc.ResearchJob()
    seen = []

    def fail_save(*args):
        assert current_thread() is main_thread()
        assert job.state["phase"] == "storing"
        with pytest.raises(rpc.RPCError, match=rpc.ERRORS["too_late"]):
            job.cancel(job.state["job_id"])
        seen.append(True)
        raise OSError(PRIVATE)

    monkeypatch.setattr(store, "save_run", fail_save)
    try:
        job.start(str(DATA), str(SPEC), str(tmp_path / "runs"))
        status = finish(job)
        assert seen == [True]
        assert status["status"] == "failed" and status["run_id"] is None
        assert status["error"] == rpc._error("storage_failed")
    finally:
        job.close()


def test_idle_stdin_still_saves_on_parent_main_thread(tmp_path, monkeypatch):
    """A client sends no status request until a save event proves idle progress."""
    incoming, outgoing = Queue(), Queue()
    saved = Event()
    root = tmp_path / "runs"
    save_run = store.save_run
    failures = []

    def save(*args):
        assert current_thread() is main_thread()
        run_id = save_run(*args)
        saved.set()
        return run_id

    class Input:
        def __iter__(self):
            return self

        def __next__(self):
            line = incoming.get(timeout=WAIT)
            if line is None:
                raise StopIteration
            return line

    class Output(io.StringIO):
        def write(self, text):
            outgoing.put(json.loads(text))
            return super().write(text)

    def interact():
        try:
            incoming.put(json.dumps(envelope("research.start", start_params(root))).encode())
            assert outgoing.get(timeout=WAIT)["result"]["status"] == "running"
            assert saved.wait(timeout=WAIT), "Idle stdin prevented parent publication"
            incoming.put(json.dumps(envelope("jobs.status")).encode())
            status = outgoing.get(timeout=WAIT)["result"]
            assert status["status"] == "completed" and status["run_id"] is not None
        except BaseException as exc:
            failures.append(exc)
        finally:
            incoming.put(None)

    monkeypatch.setattr(store, "save_run", save)
    client_thread = Thread(target=interact, daemon=True)
    client_thread.start()
    assert rpc.serve(Input(), Output()) == 0
    client_thread.join(timeout=WAIT)
    assert not client_thread.is_alive()
    assert not failures, failures
    assert len(store.list_runs(root)) == 1


def test_subprocess_eof_after_start_discards_unaccepted_work(tmp_path):
    root = tmp_path / "runs"
    result = subprocess.run(
        [sys.executable, "-m", "itt.rpc"], cwd=ROOT,
        input=json.dumps(envelope("research.start", start_params(root))).encode() + b"\n",
        capture_output=True, timeout=WAIT, check=False,
    )
    assert result.returncode == 0 and result.stderr == b""
    lines = result.stdout.splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["result"]["status"] == "running"
    assert not root.exists()


def test_unexpected_shared_api_exception_is_redacted(monkeypatch):
    monkeypatch.setattr(research, "capabilities", Mock(side_effect=RuntimeError(PRIVATE)))
    response = rpc.RPCServer().handle(json.dumps(envelope("capabilities")).encode())
    assert response == {"id": 1, "ok": False, "error": rpc._error("internal_error")}


def market_specs():
    """Declarative transport fixtures, never loaded from or saved to user archives."""
    window = {"archive_id": "77777777-7777-4777-8777-777777777777",
              "start": "2026-01-02", "end": "2026-06-30"}
    condition = {"all": [
        {"left": {"indicator": "sma", "period": 21, "lag": 1},
         "op": "crosses_above", "right": {"indicator": "ema", "period": 63}},
        {"not": {"left": {"operation": "divide", "left": {"field": "close"},
                          "right": {"field": "close", "lag": 5}}, "op": "lte", "right": 1.02}},
    ]}
    common = {**window, "initial_cash": "10000", "fee_bps": "10", "slippage_bps": "5",
              "entry": condition, "exit": {"left": "close", "op": "lt", "right": 0}}
    return {
        "backtest": {**common, "symbol": "AAPL"},
        "portfolio": {**common, "weights": {"AAPL": "0.4", "BRK-B": "0.5"},
                      "rebalance_every": 2, "rebalance_calendar": "quarterly",
                      "allocation": {"mode": "momentum", "lookback": 63,
                                     "top_n": 2, "minimum_return": "0.0250"}},
        "correlation": {**window, "symbols": ["AAPL", "BRK-B"], "frequency": "monthly"},
        "trigger": {**window, "symbol": "AAPL", "target_symbol": "BRK-B",
                    "condition": condition, "horizons": [1, 5, 60]},
        "guru": {"as_of": "2026-09-11", "filings": [{
            "manager": "Synthetic RPC fixture", "period": "2026-06-30", "filed_at": "2026-08-14",
            "source_url": "https://www.sec.gov/Archives/fixture-only",
            "holdings": [{
                "cusip": "000000001", "name": "Fixture", "value_usd": "1000", "shares": "10",
            }],
        }]},
    }


@pytest.mark.parametrize("operation", ["backtest", "portfolio"])
@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("failure", [False, True])
def test_market_ndjson_opt_in_progress_and_single_terminal(
        monkeypatch, tmp_path, operation, streaming, failure):
    """Exercise real serve -> handle -> dispatch and flushed output, mocking only calculation."""
    flushes = []

    class Output(io.StringIO):
        def flush(self):
            flushes.append(self.getvalue())

    sink = Output()
    spec = market_specs()[operation]
    method = f"market.{operation}" + (".stream" if streaming else "")
    params = {"store_path": str(tmp_path / "never-created-market"), "spec": spec}
    expected = rpc.METHODS[method].model_validate(params).model_dump()["spec"]
    request_id = "transport:portfolio-1" if operation == "portfolio" else 42
    points = [{"phase": phase, "completed": 1, "total": 2, "date": spec["start"],
               "nav": "10000", "cagr": None, "max_drawdown": "0"}
              for phase in ("strategy", "benchmark")]
    seen = []

    def calculate(root, reviewed, **options):
        seen.append((root, reviewed))
        assert root == Path(params["store_path"])
        assert reviewed == expected
        assert set(options) == ({"on_progress"} if streaming else set())
        if streaming:
            for index, point in enumerate(points):
                options["on_progress"](point)
                rows = [json.loads(line) for line in sink.getvalue().splitlines()]
                assert rows == [{"id": request_id, "event": "progress", "data": item}
                                for item in points[:index + 1]]
                assert len(flushes) == index + 1, "each event is flushed before calculation returns"
        else:
            assert sink.getvalue() == "", "ordinary methods must not emit progress"
        if failure:
            raise RuntimeError(PRIVATE)
        return {"spec": reviewed, "marker": "calculation-result"}

    monkeypatch.setattr(rpc, f"run_market_{operation}", calculate)
    server = rpc.RPCServer()
    source = io.BytesIO(json.dumps(envelope(method, params, request_id)).encode() + b"\n")
    assert rpc.serve(source, sink, server) == 0
    rows = [json.loads(line) for line in sink.getvalue().splitlines()]
    terminal = ({"id": request_id, "ok": False, "error": rpc._error("internal_error")} if failure
                else {"id": request_id, "ok": True,
                      "result": {"spec": expected, "marker": "calculation-result"}})
    assert rows == ([{"id": request_id, "event": "progress", "data": point} for point in points]
                    if streaming else []) + [terminal]
    assert len(flushes) == len(rows)
    assert PRIVATE not in sink.getvalue()
    assert len(seen) == 1, "no automatic retry"
    assert not Path(params["store_path"]).exists()


@pytest.mark.parametrize("operation,target", [
    ("correlation", "run_market_correlation"), ("trigger", "run_market_trigger"),
    ("guru", "run_guru_analysis"),
])
def test_new_rpc_methods_use_real_dispatch_and_validated_exact_params(
    monkeypatch, tmp_path, operation, target,
):
    spec = market_specs()[operation]
    method = f"market.{operation}"
    params = {"spec": spec}
    if operation != "guru":
        params["store_path"] = str(tmp_path / "never-created")
    expected = rpc.METHODS[method].model_validate(params).model_dump()["spec"]
    calculate = Mock(return_value={"marker": operation})
    monkeypatch.setattr(rpc, target, calculate)
    emitted = []
    response = rpc.RPCServer().handle(
        json.dumps(envelope(method, params, "dispatch-1")).encode(), emit=emitted.append,
    )
    assert response == {"id": "dispatch-1", "ok": True, "result": {"marker": operation}}
    calculate.assert_called_once_with(*([expected] if operation == "guru"
                                      else [Path(params["store_path"]), expected]))
    assert emitted == []
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("operation", [
    "backtest", "portfolio", "backtest.stream", "portfolio.stream",
    "correlation", "trigger", "guru",
])
def test_new_rpc_params_reject_unknown_fields_paths_and_bool_rules_before_dispatch(
    monkeypatch, tmp_path, operation,
):
    base = operation.split(".")[0]
    spec = market_specs()[base]
    params = {"spec": spec}
    if base != "guru":
        params["store_path"] = str(tmp_path / "never-created")
    server = rpc.RPCServer()
    dispatch = Mock(side_effect=AssertionError("invalid params must not dispatch"))
    monkeypatch.setattr(server, "dispatch", dispatch)
    bad = [{**params, "unknown": PRIVATE}, {**params, "store": PRIVATE},
           {**params, "spec_path": PRIVATE}, {**params, "spec": PRIVATE},
           {**params, "spec": {**spec, "path": PRIVATE}}]
    if base == "guru":
        bad.append({**params, "store_path": PRIVATE})
        bad.append({"spec": {**spec, "filings": [{**spec["filings"][0], "path": PRIVATE}]}})
    else:
        bad.extend(
            {**params, "store_path": value} for value in
            ["https://example.invalid/" + PRIVATE, "file:///" + PRIVATE, "//server/" + PRIVATE]
        )
        if base == "correlation":
            bad.append({**params, "spec": {**spec, "symbols": ["AAPL", "../QQQ"]}})
        else:
            key = "condition" if base == "trigger" else "entry"
            bad.append({
                **params, "spec": {**spec, key: {"left": "close", "op": "gt", "right": True}},
            })
            if base != "portfolio":
                bad.append({**params, "spec": {**spec, "symbol": "../AAPL"}})
    for invalid in bad:
        events = []
        response = server.handle(
            json.dumps(envelope(f"market.{operation}", invalid, "invalid-1")).encode(),
            emit=events.append,
        )
        assert response == {"id": "invalid-1", "ok": False, "error": rpc._error("invalid_params")}
        assert events == []
        assert PRIVATE not in json.dumps(response)
    dispatch.assert_not_called()
    assert list(tmp_path.iterdir()) == []


def test_subprocess_guru_computes_offline_and_emits_one_envelope(client):
    spec = market_specs()["guru"]
    # Real offline calculation through the subprocess protocol, no archive dependency.
    actual = client.result("market.guru", {"spec": spec})
    assert actual == rpc.run_guru_analysis(spec)