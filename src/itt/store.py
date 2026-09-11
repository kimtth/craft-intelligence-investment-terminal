"""Local synthetic run bundles; integrity hashes are not signatures or an audit.

Bundles are immutable through this API, not OS write-protected. Only save_run
and add_decision create directories. Readers reject links/reparse points, but
this is not a sandbox against a hostile process concurrently replacing paths.
Publication uses an existence check plus os.rename: Windows refuses any existing
target; POSIX refuses an existing published (nonempty) bundle. The check also
refuses pre-existing empty targets, but is not a POSIX rename-no-replace syscall.
"""

import json
import os
import shutil
import stat
import tempfile
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from uuid import UUID, uuid4

from itt.contracts import Dataset, ResearchSpec
from itt.engine import ENGINE_VERSION, run_backtest
from itt.research import validate_spec

SCHEMA_VERSION = "0.1"
FILES = ("dataset.json", "spec.json", "result.json")
INVENTORY = {*FILES, "manifest.json"}
CONTRACT_FIELDS = (
    "start", "end", "initial_cash", "fee_rate", "slippage_rate", "quantity_step",
    "benchmark", "execution", "valuation", "lookback",
)
MANIFEST_FIELDS = {
    "schema_version", "run_id", "created_at", "engine_version", "kind",
    "external_audit", "files", "comparison_contract",
}
NOTE_FIELDS = {"id", "run_id", "created_at", "text"}
TEMP_PREFIX = ".itt-tmp-"
_ERRORS = (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError)


def _canonical(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False,
    ).encode("ascii")


def _decode(raw: bytes) -> dict:
    value = json.loads(raw.decode("utf-8"))
    # Also rejects duplicate keys, non-finite numbers and noncanonical encodings.
    if not isinstance(value, dict) or _canonical(value) != raw:
        raise ValueError("invalid JSON object")
    return value


def _uuid(value: str) -> str:
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError("invalid identifier")
    return value


def _timestamp(value: str) -> None:
    if not isinstance(value, str) or "T" not in value:
        raise ValueError("invalid timestamp")
    if datetime.fromisoformat(value).utcoffset() != timedelta(0):
        raise ValueError("invalid timestamp")


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _entry(path: Path) -> os.stat_result | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        # FILE_ATTRIBUTE_REPARSE_POINT includes Windows directory junctions.
        raise ValueError("linked entries are unsupported")
    return info


def _directory(path: Path, *, create: bool = False) -> bool:
    info = _entry(path)
    if info is None and create:
        path.mkdir(parents=True, exist_ok=True)
        info = _entry(path)
    if info is not None and not stat.S_ISDIR(info.st_mode):
        raise ValueError("invalid directory")
    return info is not None


def _root(root: Path, *, create: bool = False) -> Path:
    root = Path(root).absolute()
    # Inspect ancestors without resolve(), which would hide symlink traversal.
    for parent in reversed(root.parents):
        _directory(parent)
    _directory(root, create=create)
    return root


def _read(path: Path) -> bytes:
    info = _entry(path)
    if info is None or not stat.S_ISREG(info.st_mode):
        raise ValueError("invalid file")
    return path.read_bytes()


def _write(path: Path, raw: bytes) -> None:
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def _contract(spec: dict, dataset_sha256: str) -> dict:
    return {
        "dataset_sha256": dataset_sha256, "engine_version": ENGINE_VERSION,
        **{name: spec[name] for name in CONTRACT_FIELDS},
    }


def _check_result(spec: dict, result: dict) -> None:
    if (
        not isinstance(result, dict)
        or result.get("schema_version") != SCHEMA_VERSION
        or result.get("engine_version") != ENGINE_VERSION
        or result.get("kind") != "synthetic"
        or result.get("synthetic") is not True
        or result.get("external_audit") is not False
        or _canonical(result.get("spec")) != _canonical(spec)
    ):
        raise ValueError("inconsistent result")
    for name in ("strategy", "benchmark"):
        if not isinstance(result.get(name), dict):
            raise ValueError("invalid result")
        if not isinstance(result[name].get("metrics"), dict):
            raise ValueError("invalid metrics")


def _summary(bundle: dict) -> dict:
    manifest, result = bundle["manifest"], bundle["result"]
    return {
        "id": manifest["run_id"], "created_at": manifest["created_at"],
        "kind": manifest["kind"],
        "metrics": {name: result[name]["metrics"] for name in ("strategy", "benchmark")},
    }


def save_run(root: Path, dataset: Dataset, spec: ResearchSpec, result: dict) -> str:
    """Validate inputs/result metadata, snapshot JSON, then publish a new UUID.

    Does not recompute accounting; replay_run is the full-result verification.
    Validation and serialization finish before creating the output root.
    """
    temporary = None
    try:
        dataset = Dataset.model_validate(dataset)
        spec = ResearchSpec.model_validate(spec)
        validate_spec(spec, dataset)
        dataset_json, spec_json = dataset.model_dump(mode="json"), spec.model_dump(mode="json")
        _check_result(spec_json, result)
        payloads = dict(zip(FILES, map(_canonical, (dataset_json, spec_json, result)), strict=True))
        hashes = {name: sha256(raw).hexdigest() for name, raw in payloads.items()}
        run_id = _uuid(str(uuid4()))
        manifest = {
            "schema_version": SCHEMA_VERSION, "run_id": run_id, "created_at": _now(),
            "engine_version": ENGINE_VERSION, "kind": "synthetic", "external_audit": False,
            "files": hashes,
            "comparison_contract": _contract(spec_json, hashes["dataset.json"]),
        }
        payloads["manifest.json"] = _canonical(manifest)
        root = _root(root, create=True)
        target = root / run_id
        if _entry(target) is not None:
            raise ValueError("run already exists")
        temporary = Path(tempfile.mkdtemp(prefix=TEMP_PREFIX, dir=root))
        for name, raw in payloads.items():
            _write(temporary / name, raw)
        # Repeat immediately before publication, including empty directories.
        if _entry(target) is not None:
            raise ValueError("run already exists")
        os.rename(temporary, target)
        temporary = None
        return run_id
    except _ERRORS:
        raise ValueError("unable to save run") from None
    finally:
        if temporary is not None:
            try:
                shutil.rmtree(temporary)
            except OSError:
                raise ValueError("unable to clean temporary run") from None


def load_run(root: Path, run_id: str) -> dict:
    """Return exactly manifest/dataset/spec/result dictionaries after verification."""
    try:
        run_id = _uuid(run_id)
        directory = _root(root) / run_id
        if not _directory(directory) or {p.name for p in directory.iterdir()} != INVENTORY:
            raise ValueError("invalid inventory")
        manifest = _decode(_read(directory / "manifest.json"))
        if (
            set(manifest) != MANIFEST_FIELDS
            or manifest["schema_version"] != SCHEMA_VERSION
            or manifest["run_id"] != run_id
            or manifest["engine_version"] != ENGINE_VERSION
            or manifest["kind"] != "synthetic"
            or manifest["external_audit"] is not False
            or not isinstance(manifest["files"], dict)
            or set(manifest["files"]) != set(FILES)
        ):
            raise ValueError("invalid manifest")
        _timestamp(manifest["created_at"])
        bundle = {"manifest": manifest}
        # Never turn manifest-supplied strings into filesystem paths.
        for name in FILES:
            raw = _read(directory / name)
            if sha256(raw).hexdigest() != manifest["files"][name]:
                raise ValueError("file hash mismatch")
            bundle[name.removesuffix(".json")] = _decode(raw)
        dataset = Dataset.model_validate(bundle["dataset"])
        spec = ResearchSpec.model_validate(bundle["spec"])
        validate_spec(spec, dataset)
        _check_result(spec.model_dump(mode="json"), bundle["result"])
        contract = _contract(bundle["spec"], manifest["files"]["dataset.json"])
        if _canonical(manifest["comparison_contract"]) != _canonical(contract):
            raise ValueError("comparison contract mismatch")
        return bundle
    except _ERRORS:
        raise ValueError("invalid run bundle") from None


def list_runs(root: Path) -> list[dict]:
    """Oldest first (UUID tie-break); corrupt canonical UUID entries are errors."""
    try:
        root = _root(root)
        if not _directory(root):
            return []
        runs = []
        for entry in root.iterdir():
            _entry(entry)  # Reject even dangling links, rather than follow or skip them.
            if entry.name.startswith(TEMP_PREFIX) or entry.name == "decisions":
                continue
            try:
                _uuid(entry.name)
            except ValueError:
                continue
            runs.append(_summary(load_run(root, entry.name)))
        return sorted(runs, key=lambda row: (datetime.fromisoformat(row["created_at"]), row["id"]))
    except _ERRORS:
        raise ValueError("invalid run store") from None


def replay_run(root: Path, run_id: str) -> dict:
    """Rerun saved inputs locally; 'verified' means exact canonical result equality."""
    try:
        bundle = load_run(root, run_id)
        actual = run_backtest(
            Dataset.model_validate(bundle["dataset"]), ResearchSpec.model_validate(bundle["spec"]),
        )
        if _canonical(actual) != _canonical(bundle["result"]):
            raise ValueError("replay mismatch")
        return {
            "status": "verified", "id": run_id, "result": actual,
            "metrics": _summary(bundle)["metrics"],
        }
    except _ERRORS:
        raise ValueError("unable to verify replay") from None


def compare_runs(root: Path, ids: list[str]) -> dict:
    """Compare saved metrics in caller order; compatible does not mean replayed."""
    try:
        if not isinstance(ids, list) or len(ids) < 2:
            raise ValueError("at least two distinct runs required")
        for run_id in ids:
            _uuid(run_id)
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate runs")
        bundles = [load_run(root, run_id) for run_id in ids]
        contract = bundles[0]["manifest"]["comparison_contract"]
        if any(
            _canonical(bundle["manifest"]["comparison_contract"]) != _canonical(contract)
            for bundle in bundles[1:]
        ):
            raise ValueError("incompatible comparison contracts")
        return {
            "status": "compatible", "comparison_contract": contract,
            "runs": [_summary(bundle) for bundle in bundles],
        }
    except _ERRORS:
        raise ValueError("unable to compare runs") from None


def add_decision(root: Path, run_id: str, text: str) -> str:
    """Append a separate {id, run_id, created_at, text} JSON note, preserving text."""
    owned = None
    try:
        if not isinstance(text, str) or not text.strip():
            raise ValueError("nonempty text required")
        load_run(root, run_id)
        root = _root(root)
        decision_id = _uuid(str(uuid4()))
        raw = _canonical({
            "id": decision_id, "run_id": run_id, "created_at": _now(), "text": text,
        })
        directory = root / "decisions"
        _directory(directory, create=True)
        directory = directory / run_id
        _directory(directory, create=True)
        path = directory / f"{decision_id}.json"
        # Exclusive create also refuses collisions and dangling symlink targets.
        with path.open("xb") as stream:
            owned = path
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        owned = None
        return decision_id
    except _ERRORS:
        raise ValueError("unable to save decision") from None
    finally:
        if owned is not None:
            try:
                owned.unlink()
            except OSError:
                raise ValueError("unable to clean decision") from None


def list_decisions(root: Path, run_id: str) -> list[dict]:
    """Return notes oldest first (UUID tie-break); malformed notes are errors."""
    try:
        load_run(root, run_id)
        directory = _root(root) / "decisions"
        if not _directory(directory) or not _directory(directory / run_id):
            return []
        notes = []
        for path in (directory / run_id).iterdir():
            if path.suffix != ".json":
                raise ValueError("invalid decision inventory")
            decision_id = _uuid(path.stem)
            note = _decode(_read(path))
            if (
                set(note) != NOTE_FIELDS or note["id"] != decision_id
                or note["run_id"] != run_id or not isinstance(note["text"], str)
                or not note["text"].strip()
            ):
                raise ValueError("invalid decision")
            _timestamp(note["created_at"])
            notes.append(note)
        return sorted(notes, key=lambda row: (datetime.fromisoformat(row["created_at"]), row["id"]))
    except _ERRORS:
        raise ValueError("invalid decisions") from None