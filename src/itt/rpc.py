"""Dedicated local NDJSON process: ``python -m itt.rpc``.

P3/P5 contract: one current job, spawn-only computation, parent-only publication.
Close stdin to discard unaccepted research work and reap the child. Saved-market
stream methods opt in to correlated processed-session metrics before the result.
No generated-code execution or estimated progress. Ordinary methods remain unary.
Local paths are user-authorized, not a filesystem sandbox (including mounted drives).
"""

import json
import multiprocessing as mp
import re
import sys
from contextlib import redirect_stdout
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess
from pathlib import Path
from queue import Empty, Queue
from threading import Event, Thread
from typing import Annotated, BinaryIO, TextIO
from uuid import UUID, uuid4

from pydantic import AfterValidator, BaseModel, ConfigDict, StrictInt, StrictStr, ValidationError

from itt import research, store
from itt.analytics import CorrelationSpec, TriggerSpec, run_market_correlation, run_market_trigger
from itt.contracts import Dataset, ResearchSpec
from itt.criteria import CriteriaSpec, run_market_backtest
from itt.data import load_dataset
from itt.engine import run_backtest
from itt.guru import GuruSpec, run_guru_analysis
from itt.portfolio import PortfolioSpec, run_market_portfolio

ERRORS = {
    "invalid_json": "Expected one UTF-8 JSON object per line.",
    "invalid_request": "Invalid request envelope.",
    "invalid_params": "Invalid method parameters.",
    "method_not_found": "Method is not supported.",
    "schema_rejected": "Input schema was rejected.",
    "input_rejected": "Input was rejected.",
    "invalid_encoding": "Input file is not valid UTF-8.",
    "io_failure": "Unable to access a required local file.",
    "internal_error": "Operation failed.",
    "worker_failed": "Research worker stopped without a valid result.",
    "storage_failed": "Unable to save the research run.",
    "busy": "A research job is already running.",
    "job_not_found": "No matching current job.",
    "too_late": "The job can no longer be cancelled.",
}


def _error(code: str) -> dict:
    return {"code": code, "message": ERRORS[code]}


class RPCError(Exception):
    def __init__(self, code: str):
        super().__init__(ERRORS[code])
        self.code = code


def _request_id(value: int | str) -> int | str:
    if type(value) is int and value > 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", value):
        return value
    raise ValueError("invalid request identifier")


def _local_path(value: str) -> str:
    normalized = value.replace("\\", "/")
    if not value.strip() or "\x00" in value or normalized.startswith("//"):
        raise ValueError("local path required")
    # Reject URLs, file URIs, UNC/device paths and alternate stream syntax.
    tail = normalized[2:] if re.match(r"^[A-Za-z]:/", normalized) else normalized
    if ":" in tail:
        raise ValueError("local path required")
    return value


def _identifier(value: str) -> str:
    if str(UUID(value)) != value:
        raise ValueError("canonical UUID required")
    return value


def _note(value: str) -> str:
    if not value.strip():
        raise ValueError("nonempty note required")
    return value


RequestId = Annotated[StrictInt | StrictStr, AfterValidator(_request_id)]
LocalPath = Annotated[StrictStr, AfterValidator(_local_path)]
Identifier = Annotated[StrictStr, AfterValidator(_identifier)]


class Params(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Request(Params):
    id: RequestId
    method: StrictStr
    params: dict


class DataParams(Params):
    path: LocalPath


class StoreParams(Params):
    store: LocalPath


class MarketParams(StoreParams):
    symbols: list[StrictStr]
    start: StrictStr | None = None
    end: StrictStr | None = None


class MarketBacktestParams(Params):
    store_path: LocalPath
    spec: CriteriaSpec


class MarketPortfolioParams(Params):
    store_path: LocalPath
    spec: PortfolioSpec


class CorrelationParams(Params):
    store_path: LocalPath
    spec: CorrelationSpec


class TriggerParams(Params):
    store_path: LocalPath
    spec: TriggerSpec


class GuruParams(Params):
    spec: GuruSpec


class StartParams(StoreParams):
    data: LocalPath
    spec: LocalPath


class RunParams(StoreParams):
    id: Identifier


class DecisionParams(RunParams):
    text: Annotated[StrictStr, AfterValidator(_note)]


class CancelParams(Params):
    job_id: Identifier


METHODS: dict[str, type[Params]] = {
    "capabilities": Params,
    "market.fetch": MarketParams,
    "market.show": StoreParams,
    "market.backtest": MarketBacktestParams,
    "market.portfolio": MarketPortfolioParams,
    "market.backtest.stream": MarketBacktestParams,
    "market.portfolio.stream": MarketPortfolioParams,
    "market.correlation": CorrelationParams,
    "market.trigger": TriggerParams,
    "market.guru": GuruParams,
    "data.validate": DataParams,
    "research.start": StartParams,
    "jobs.status": Params,
    "jobs.cancel": CancelParams,
    "runs.list": StoreParams,
    "runs.show": RunParams,
    "runs.replay": RunParams,
    "decisions.add": DecisionParams,
    "decisions.list": RunParams,
}


def _exception_code(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "schema_rejected"
    if isinstance(exc, UnicodeError):
        return "invalid_encoding"
    if isinstance(exc, ValueError):
        return "input_rejected"
    if isinstance(exc, OSError):
        return "io_failure"
    return "internal_error"


def _research_worker(sender: Connection, data_path: str, spec_path: str) -> None:
    """Spawn target: never receives a store path and never publishes a run."""
    with redirect_stdout(sys.stderr):
        try:
            sender.send(("phase", "validating"))
            dataset = load_dataset(Path(data_path))
            spec = ResearchSpec.model_validate_json(Path(spec_path).read_text(encoding="utf-8"))
            research.validate_spec(spec, dataset)
            sender.send(("phase", "calculating"))
            result = run_backtest(dataset, spec)
            sender.send(("result", dataset.model_dump(mode="json"),
                         spec.model_dump(mode="json"), result))
        except Exception as exc:
            # Exception text, Pydantic input/ctx and user paths never cross this boundary.
            try:
                sender.send(("error", _exception_code(exc)))
            except (OSError, EOFError):
                pass
        finally:
            sender.close()


class ResearchJob:
    def __init__(self) -> None:
        self.context = mp.get_context("spawn")
        self.process: BaseProcess | None = None
        self.receiver: Connection | None = None
        self.store_path: Path | None = None
        self.state: dict = {
            "job_id": None, "status": "idle", "phase": None, "run_id": None, "error": None,
        }

    def status(self) -> dict:
        return dict(self.state)

    def close(self) -> None:
        """Discard IPC, terminate if necessary, join, then release owned handles."""
        if self.process is not None:
            process = self.process
            if process.pid is not None:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=2)
                if process.is_alive():
                    process.kill()
                    process.join()
            process.close()
            self.process = None
        if self.receiver is not None:
            self.receiver.close()
            self.receiver = None

    def start(self, data: str, spec: str, root: str) -> dict:
        if self.state["status"] == "running":
            raise RPCError("busy")
        self.state = {
            "job_id": str(uuid4()), "status": "running", "phase": "starting",
            "run_id": None, "error": None,
        }
        self.store_path = Path(root)
        sender = None
        try:
            self.receiver, sender = self.context.Pipe(duplex=False)
            self.process = self.context.Process(
                target=_research_worker, args=(sender, data, spec),
            )
            self.process.start()
        except Exception:
            self._fail("worker_failed")
            raise RPCError("worker_failed") from None
        finally:
            if sender is not None:
                sender.close()
        return {"job_id": self.state["job_id"], "status": "running"}

    def _fail(self, code: str) -> None:
        self.close()
        self.state.update(status="failed", phase="failed", run_id=None, error=_error(code))

    def cancel(self, job_id: str) -> dict:
        if self.state["job_id"] != job_id:
            raise RPCError("job_not_found")
        if (self.state["status"] != "running"
                or self.state["phase"] not in {"starting", "validating", "calculating"}
                or self.process is None or not self.process.is_alive()):
            raise RPCError("too_late")
        self.close()
        self.state.update(status="cancelled", phase="cancelled", run_id=None, error=None)
        return {"job_id": job_id, "status": "cancelled"}

    def advance(self, disconnected: Event) -> None:
        """Accept worker messages on the main thread; EOF wins before acceptance."""
        if disconnected.is_set() or self.state["status"] != "running":
            return
        assert self.receiver is not None and self.process is not None
        try:
            while self.receiver.poll():
                message = self.receiver.recv()
                if disconnected.is_set():
                    return
                match message:
                    case ("phase", phase) if phase in {"validating", "calculating"}:
                        self.state["phase"] = phase
                    case ("error", code) if code in ERRORS:
                        self._fail(code)
                        return
                    case ("result", data, spec, result):
                        # This is the acceptance boundary. No more cancellation; only the
                        # main thread owns the store. Use worker snapshots, not reread files.
                        self.state["phase"] = "storing"
                        self.close()
                        try:
                            assert self.store_path is not None
                            run_id = store.save_run(
                                self.store_path, Dataset.model_validate(data),
                                ResearchSpec.model_validate(spec), result,
                            )
                        except Exception:
                            self._fail("storage_failed")
                        else:
                            self.state.update(status="completed", phase="completed", run_id=run_id)
                        return
                    case _:
                        self._fail("worker_failed")
                        return
            if not self.process.is_alive():
                # Recheck after observing death: a final send may race the earlier poll.
                if not self.receiver.poll():
                    self._fail("worker_failed")
        except Exception:
            self._fail("worker_failed")


def _object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _constant(_: str) -> None:
    raise ValueError("nonstandard JSON constant")


class RPCServer:
    def __init__(self) -> None:
        self.job = ResearchJob()

    def handle(self, line: bytes, emit=None) -> dict:
        request_id = None
        try:
            try:
                raw = json.loads(line.decode("utf-8"), object_pairs_hook=_object,
                                 parse_constant=_constant)
            except (ValueError, RecursionError):
                raise RPCError("invalid_json") from None
            try:
                request = Request.model_validate(raw)
            except ValidationError:
                raise RPCError("invalid_request") from None
            request_id = request.id
            schema = METHODS.get(request.method)
            if schema is None:
                raise RPCError("method_not_found")
            try:
                params = schema.model_validate(request.params).model_dump()
            except ValidationError:
                raise RPCError("invalid_params") from None
            with redirect_stdout(sys.stderr):
                progress = (
                    (lambda data: emit({"id": request_id, "event": "progress", "data": data}))
                    if emit else None
                )
                result = self.dispatch(request.method, params, on_progress=progress)
            return {"id": request_id, "ok": True, "result": result}
        except Exception as exc:
            code = exc.code if isinstance(exc, RPCError) else _exception_code(exc)
            return {"id": request_id, "ok": False, "error": _error(code)}

    def dispatch(self, method: str, p: dict, on_progress=None) -> object:
        # Deliberately explicit: no reflection, eval, import or arbitrary attribute dispatch.
        match method:
            case "capabilities":
                return {**research.capabilities(), "rpc": {
                    "version": "0.1", "transport": "stdio_ndjson", "methods": list(METHODS),
                    "max_active_jobs": 1, "events": "opt_in_correlated_market_progress",
                }}
            case "data.validate":
                return research.inspect_data(Path(p["path"]))
            case "market.fetch":
                from itt.market import fetch_market

                return fetch_market(p["symbols"], Path(p["store"]),
                                    start=p["start"], end=p["end"])
            case "market.show":
                from itt.market import load_market

                return load_market(Path(p["store"]))
            case "market.backtest":
                return run_market_backtest(Path(p["store_path"]), p["spec"])
            case "market.portfolio":
                return run_market_portfolio(Path(p["store_path"]), p["spec"])
            case "market.backtest.stream":
                return run_market_backtest(
                    Path(p["store_path"]), p["spec"], on_progress=on_progress,
                )
            case "market.portfolio.stream":
                return run_market_portfolio(
                    Path(p["store_path"]), p["spec"], on_progress=on_progress,
                )
            case "market.correlation":
                return run_market_correlation(Path(p["store_path"]), p["spec"])
            case "market.trigger":
                return run_market_trigger(Path(p["store_path"]), p["spec"])
            case "market.guru":
                return run_guru_analysis(p["spec"])
            case "research.start":
                return self.job.start(p["data"], p["spec"], p["store"])
            case "jobs.status":
                return self.job.status()
            case "jobs.cancel":
                return self.job.cancel(p["job_id"])
            case "runs.list":
                return store.list_runs(Path(p["store"]))
            case "runs.show":
                return store.load_run(Path(p["store"]), p["id"])
            case "runs.replay":
                return store.replay_run(Path(p["store"]), p["id"])
            case "decisions.add":
                return {"decision_id": store.add_decision(Path(p["store"]), p["id"], p["text"])}
            case "decisions.list":
                return store.list_decisions(Path(p["store"]), p["id"])
            case _:
                raise RPCError("method_not_found")


def serve(source: BinaryIO, sink: TextIO, server: RPCServer | None = None) -> int:
    server = server if server is not None else RPCServer()
    requests: Queue[bytes | None] = Queue()
    disconnected = Event()

    def read_input() -> None:
        try:
            for line in source:
                requests.put(line)
        finally:
            disconnected.set()
            requests.put(None)

    # Only this thread reads stdin; it never touches job state, IPC, or the store.
    reader = Thread(target=read_input, daemon=True, name="itt-rpc-stdin")
    reader.start()

    def emit(message):
        sink.write(json.dumps(message, ensure_ascii=True, allow_nan=False) + "\n")
        sink.flush()

    try:
        while True:
            try:
                line = requests.get(timeout=0.05)
            except Empty:
                pass
            else:
                if line is None:
                    return 0
                response = server.handle(line, emit=emit)
                emit(response)
            # Handle each request before accepting results, including cancel. Advance
            # both during idle stdin and busy polling so neither can starve the worker.
            with redirect_stdout(sys.stderr):
                server.job.advance(disconnected)
    except (BrokenPipeError, OSError):
        return 1
    finally:
        server.job.close()
        if disconnected.is_set():
            reader.join()


def main() -> int:
    try:
        return serve(sys.stdin.buffer, sys.stdout)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())