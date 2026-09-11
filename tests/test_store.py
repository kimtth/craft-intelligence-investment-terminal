"""P3 filesystem contracts; replay determinism is not independent financial audit."""

import json
from copy import deepcopy
from datetime import datetime, timedelta
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from itt import store
from itt.contracts import Dataset, ResearchSpec
from itt.data import load_dataset
from itt.engine import ENGINE_VERSION, run_backtest

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "p2"
BUNDLE_FILES = {"dataset.json", "spec.json", "result.json", "manifest.json"}


def canonical(value) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False,
    ).encode("ascii")


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def contents(path: Path) -> dict:
    return {entry.name: entry.read_bytes() for entry in path.iterdir()}


def rehash(directory: Path, name: str, raw: bytes) -> None:
    """Simulate an attacker updating both an unsigned payload and its manifest hash."""
    (directory / name).write_bytes(raw)
    manifest = read(directory / "manifest.json")
    manifest["files"][name] = sha256(raw).hexdigest()
    (directory / "manifest.json").write_bytes(canonical(manifest))


@pytest.fixture
def inputs():
    dataset = load_dataset(FIXTURES / "normal.json")
    spec = ResearchSpec.model_validate(read(FIXTURES / "spec.json"))
    return dataset, spec, run_backtest(dataset, spec)


@pytest.fixture
def saved(tmp_path, inputs):
    root = tmp_path / "runs"
    return root, store.save_run(root, *inputs)


def test_save_load_replay_normal_fixture(saved, inputs):
    root, run_id = saved
    dataset, spec, result = inputs
    assert str(UUID(run_id)) == run_id
    bundle = store.load_run(root, run_id)
    assert set(bundle) == {"manifest", "dataset", "spec", "result"}
    assert all(isinstance(value, dict) for value in bundle.values())
    assert bundle["dataset"] == dataset.model_dump(mode="json")
    assert bundle["spec"] == spec.model_dump(mode="json")
    assert canonical(bundle["result"]) == canonical(result)
    assert {entry.name for entry in (root / run_id).iterdir()} == BUNDLE_FILES
    manifest = bundle["manifest"]
    assert set(manifest) == {
        "schema_version", "run_id", "created_at", "engine_version", "kind",
        "external_audit", "files", "comparison_contract",
    }
    assert manifest["schema_version"] == "0.1"
    assert manifest["run_id"] == run_id
    assert manifest["engine_version"] == ENGINE_VERSION
    assert manifest["kind"] == "synthetic" and manifest["external_audit"] is False
    assert datetime.fromisoformat(manifest["created_at"]).utcoffset() == timedelta(0)
    assert set(manifest["files"]) == BUNDLE_FILES - {"manifest.json"}
    for name, raw in contents(root / run_id).items():
        assert raw == canonical(json.loads(raw))
        if name != "manifest.json":
            assert manifest["files"][name] == sha256(raw).hexdigest()
    assert manifest["comparison_contract"] == {
        "dataset_sha256": manifest["files"]["dataset.json"], "engine_version": ENGINE_VERSION,
        **{name: bundle["spec"][name] for name in (
            "start", "end", "initial_cash", "fee_rate", "slippage_rate", "quantity_step",
            "benchmark", "execution", "valuation", "lookback",
        )},
    }
    before = contents(root / run_id)
    replay = store.replay_run(root, run_id)
    assert set(replay) == {"status", "id", "result", "metrics"}
    assert replay["status"] == "verified" and replay["id"] == run_id
    assert canonical(replay["result"]) == canonical(result)
    assert replay == store.replay_run(root, run_id)
    oracle = read(FIXTURES / "oracle.json")["normal"]
    for name in ("strategy", "benchmark"):
        assert replay["metrics"][name] == result[name]["metrics"]
        for key, value in oracle[name]["metrics"].items():
            assert abs(Decimal(replay["metrics"][name][key]) - Decimal(value)) <= Decimal("1e-8")
    assert contents(root / run_id) == before
    assert store.list_runs(root) == [{
        "id": run_id, "created_at": manifest["created_at"], "kind": "synthetic",
        "metrics": replay["metrics"],
    }]


def test_readers_never_create_missing_roots(tmp_path):
    root = tmp_path / "missing" / "runs"
    run_id = str(uuid4())
    assert store.list_runs(root) == []
    for operation in (store.load_run, store.replay_run, store.list_decisions):
        with pytest.raises(ValueError):
            operation(root, run_id)
    with pytest.raises(ValueError):
        store.compare_runs(root, [run_id, str(uuid4())])
    assert not (tmp_path / "missing").exists()


@pytest.mark.parametrize("name", sorted(BUNDLE_FILES))
@pytest.mark.parametrize("damage", ["missing", "tamper", "directory"])
def test_missing_tampered_or_nonfile_bundle_entries_rejected(saved, name, damage):
    root, run_id = saved
    path = root / run_id / name
    if damage == "tamper":
        path.write_bytes(b"untrusted-content-sentinel")
    else:
        path.unlink()
        if damage == "directory":
            path.mkdir()
    with pytest.raises(ValueError, match="^invalid run bundle$"):
        store.load_run(root, run_id)


@pytest.mark.parametrize("directory", [False, True])
def test_extra_bundle_entry_rejected(saved, directory):
    root, run_id = saved
    extra = root / run_id / "extra"
    if directory:
        extra.mkdir()
    else:
        extra.write_bytes(b"unexpected")
    with pytest.raises(ValueError):
        store.load_run(root, run_id)


@pytest.mark.parametrize("raw", [
    b'{"secret-sentinel":', b"{}", b"[]", b"null", b"\xff", b'{"value":NaN}',
    b'{"value":Infinity}', b'{"value":1e999}', b'{"a":1,"a":2}',
    b'{ "a": 1 }', b'{"value":-Infinity}',
])
@pytest.mark.parametrize("name", ["dataset.json", "spec.json", "result.json"])
def test_even_correctly_hashed_malformed_json_is_rejected(saved, name, raw):
    root, run_id = saved
    rehash(root / run_id, name, raw)
    with pytest.raises(ValueError, match="^invalid run bundle$") as caught:
        store.load_run(root, run_id)
    assert "secret-sentinel" not in str(caught.value)
    assert caught.value.__suppress_context__


@pytest.mark.parametrize("run_id", [
    "../outside", "..\\outside", "/outside", "C:\\outside", "", "not-a-uuid",
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "a" * 32,
    "{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}", "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/..", None, 1,
])
def test_invalid_run_ids_rejected_without_path_traversal(tmp_path, run_id):
    root = tmp_path / "runs"
    for operation in (store.load_run, store.replay_run, store.list_decisions):
        with pytest.raises(ValueError):
            operation(root, run_id)
    with pytest.raises(ValueError):
        store.add_decision(root, run_id, "note")
    assert not root.exists()


@pytest.mark.parametrize("change", [
    {"engine_version": "unknown"}, {"schema_version": "unknown"},
    {"kind": "real_archive"}, {"external_audit": True}, {"run_id": str(uuid4())},
    {"created_at": "2024-01-01T00:00:00"}, {"created_at": "2024-01-01T01:00:00+01:00"},
    {"files": {"../outside.json": "0" * 64}}, {"files": []},
    {"comparison_contract": {}}, {"extra": "untrusted-sentinel"},
])
def test_invalid_manifest_rejected(saved, change):
    root, run_id = saved
    path = root / run_id / "manifest.json"
    manifest = read(path)
    manifest.update(change)
    path.write_bytes(canonical(manifest))
    with pytest.raises(ValueError, match="^invalid run bundle$"):
        store.load_run(root, run_id)
    with pytest.raises(ValueError, match="^unable to verify replay$"):
        store.replay_run(root, run_id)


def test_unknown_version_in_result_rejected_even_after_rehash(saved):
    root, run_id = saved
    result = read(root / run_id / "result.json")
    result["engine_version"] = "future-engine"
    rehash(root / run_id, "result.json", canonical(result))
    with pytest.raises(ValueError):
        store.load_run(root, run_id)


def test_replay_checks_whole_result_not_just_hashes_or_metrics(saved):
    root, run_id = saved
    result = read(root / run_id / "result.json")
    result["strategy"]["orders"][0]["quantity"] += 1
    rehash(root / run_id, "result.json", canonical(result))
    assert store.load_run(root, run_id)["result"] == result
    with pytest.raises(ValueError, match="^unable to verify replay$"):
        store.replay_run(root, run_id)


@pytest.mark.parametrize("name", ["dataset.json", "spec.json"])
def test_rehashed_valid_inputs_must_still_match_saved_contract_and_result(saved, name):
    root, run_id = saved
    document = read(root / run_id / name)
    if name == "dataset.json":
        document["observations"][0]["value"] = "101"
    else:
        document["fee_rate"] = "0"
    rehash(root / run_id, name, canonical(document))
    with pytest.raises(ValueError):
        store.load_run(root, run_id)


def test_replay_uses_actual_saved_variant_inputs(tmp_path, inputs, monkeypatch):
    dataset, spec, _ = inputs
    changed_data = dataset.model_dump(mode="json")
    changed_data["observations"][0]["value"] = "101"
    dataset = Dataset.model_validate(changed_data)
    changed_spec = spec.model_dump(mode="json")
    changed_spec.update(allocation="fixed", weights={"SYN-A": "0.3"}, rebalance_every=2)
    spec = ResearchSpec.model_validate(changed_spec)
    result = run_backtest(dataset, spec)
    root = tmp_path / "runs"
    run_id = store.save_run(root, dataset, spec, result)
    calls = []

    def rerun(actual_dataset, actual_spec):
        calls.append((actual_dataset.model_dump(mode="json"), actual_spec.model_dump(mode="json")))
        return run_backtest(actual_dataset, actual_spec)

    monkeypatch.setattr(store, "run_backtest", rerun)
    assert store.replay_run(root, run_id)["result"] == result
    assert calls == [(dataset.model_dump(mode="json"), spec.model_dump(mode="json"))]


def test_incomplete_temporary_and_unrelated_entries_not_listed(tmp_path):
    root = tmp_path / "runs"
    root.mkdir()
    orphan = root / f"{store.TEMP_PREFIX}orphan"
    orphan.mkdir()
    (orphan / "dataset.json").write_bytes(b"unfinished")
    (root / "unrelated").mkdir()
    (root / "readme.txt").write_text("not a run", encoding="utf-8")
    assert store.list_runs(root) == []
    assert orphan.exists()  # Readers never clean or alter someone else's temporary work.


@pytest.mark.parametrize("corruption", ["missing_file", "empty_uuid", "uuid_file"])
def test_list_does_not_silently_skip_corrupt_uuid_entries(saved, corruption):
    root, run_id = saved
    if corruption == "missing_file":
        (root / run_id / "result.json").unlink()
    elif corruption == "empty_uuid":
        (root / str(uuid4())).mkdir()
    else:
        (root / str(uuid4())).write_bytes(b"not a directory")
    with pytest.raises(ValueError, match="^invalid run store$"):
        store.list_runs(root)


@pytest.mark.parametrize("empty", [False, True])
def test_uuid_collision_never_overwrites_existing_directory(tmp_path, inputs, monkeypatch, empty):
    root = tmp_path / "runs"
    fixed = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    monkeypatch.setattr(store, "uuid4", lambda: fixed)
    if empty:
        (root / str(fixed)).mkdir(parents=True)
    else:
        assert store.save_run(root, *inputs) == str(fixed)
    before = contents(root / str(fixed))
    with pytest.raises(ValueError):
        store.save_run(root, *inputs)
    assert contents(root / str(fixed)) == before
    assert {entry.name for entry in root.iterdir()} == {str(fixed)}


@pytest.mark.parametrize("stage", ["write", "rename", "late_collision"])
def test_failed_save_cleans_only_own_temporary_directory(tmp_path, inputs, monkeypatch, stage):
    root = tmp_path / "runs"
    orphan = root / f"{store.TEMP_PREFIX}other-writer"
    orphan.mkdir(parents=True)
    marker = orphan / "keep"
    marker.write_bytes(b"keep")
    fixed = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    monkeypatch.setattr(store, "uuid4", lambda: fixed)
    original_write = store._write

    def write(path, raw):
        original_write(path, raw)
        if path.name == "spec.json" and stage == "write":
            raise OSError("untrusted-path-sentinel")
        if path.name == "manifest.json" and stage == "late_collision":
            (root / str(fixed)).mkdir()

    def rename(source, target):
        assert {entry.name for entry in source.iterdir()} == BUNDLE_FILES
        assert not target.exists()
        raise OSError("untrusted-path-sentinel")

    monkeypatch.setattr(store, "_write", write)
    if stage == "rename":
        monkeypatch.setattr(store.os, "rename", rename)
    with pytest.raises(ValueError, match="^unable to save run$"):
        store.save_run(root, *inputs)
    assert list(root.glob(f"{store.TEMP_PREFIX}*")) == [orphan]
    assert marker.read_bytes() == b"keep"
    assert (root / str(fixed)).exists() is (stage == "late_collision")


def test_loaded_source_changes_do_not_change_saved_snapshot(tmp_path, inputs):
    _, spec, _ = inputs
    source = tmp_path / "source.json"
    source.write_bytes((FIXTURES / "normal.json").read_bytes())
    spec_source = tmp_path / "source-spec.json"
    spec_source.write_bytes(canonical(spec.model_dump(mode="json")))
    spec = ResearchSpec.model_validate_json(spec_source.read_bytes())
    dataset = load_dataset(source)
    result = run_backtest(dataset, spec)
    root = tmp_path / "runs"
    run_id = store.save_run(root, dataset, spec, result)
    before = store.load_run(root, run_id)
    changed = read(source)
    changed["observations"][0]["value"] = "777"
    source.write_bytes(canonical(changed))
    spec_source.write_bytes(b"{}")
    result["strategy"]["daily"].clear()
    assert store.load_run(root, run_id) == before
    assert store.replay_run(root, run_id)["result"] == before["result"]
    source.unlink()
    assert store.load_run(root, run_id) == before


@pytest.mark.parametrize("change", [
    {"engine_version": "unknown"}, {"kind": "real_archive"}, {"synthetic": False},
    {"external_audit": True}, {"schema_version": "unknown"}, {"spec": {}},
    {"strategy": {}}, {"benchmark": None}, {"nonfinite": float("nan")},
    {"nonfinite": float("inf")},
])
def test_save_rejects_invalid_results_before_creating_root(tmp_path, inputs, change):
    dataset, spec, result = inputs
    result = deepcopy(result)
    result.update(change)
    root = tmp_path / "runs"
    with pytest.raises(ValueError, match="^unable to save run$"):
        store.save_run(root, dataset, spec, result)
    assert not root.exists()


@pytest.mark.parametrize("invalid", ["dataset", "spec", "mismatch"])
def test_save_revalidates_constructed_models_and_cross_contract(tmp_path, inputs, invalid):
    dataset, spec, result = inputs
    if invalid == "dataset":
        dataset = dataset.model_copy(update={
            "manifest": dataset.manifest.model_copy(update={"kind": "real_archive"}),
        })
    elif invalid == "spec":
        spec = spec.model_copy(update={"fee_rate": Decimal("-1")})
    else:
        spec = spec.model_copy(update={"dataset_id": "wrong-id"})
    root = tmp_path / "runs"
    with pytest.raises(ValueError):
        store.save_run(root, dataset, spec, result)
    assert not root.exists()


def test_compare_allows_different_weights_allocation_and_rebalance(saved, inputs):
    root, first = saved
    dataset, spec, _ = inputs
    changed = spec.model_dump(mode="json")
    changed.update(allocation="fixed", weights={"SYN-A": "0.7", "SYN-B": "0.2"}, rebalance_every=2)
    variant = ResearchSpec.model_validate(changed)
    second = store.save_run(root, dataset, variant, run_backtest(dataset, variant))
    compared = store.compare_runs(root, [second, first])
    assert set(compared) == {"status", "comparison_contract", "runs"}
    assert compared["status"] == "compatible"
    manifest = store.load_run(root, first)["manifest"]
    assert compared["comparison_contract"] == manifest["comparison_contract"]
    assert [row["id"] for row in compared["runs"]] == [second, first]
    for row in compared["runs"]:
        assert set(row) == {"id", "created_at", "kind", "metrics"}


@pytest.mark.parametrize("field,value", [
    ("fee_rate", "0"), ("slippage_rate", "0.01"), ("initial_cash", "2000"),
    ("start", "2024-01-03"), ("end", "2024-01-05"),
])
def test_compare_blocks_cost_cash_and_date_mismatches(saved, inputs, field, value):
    root, first = saved
    dataset, spec, _ = inputs
    changed = spec.model_dump(mode="json")
    changed[field] = value
    variant = ResearchSpec.model_validate(changed)
    second = store.save_run(root, dataset, variant, run_backtest(dataset, variant))
    with pytest.raises(ValueError, match="^unable to compare runs$"):
        store.compare_runs(root, [first, second])


def test_compare_blocks_different_dataset_contents_even_with_same_id(saved, inputs):
    root, first = saved
    dataset, spec, _ = inputs
    changed = dataset.model_dump(mode="json")
    changed["observations"][0]["value"] = "101"
    variant = Dataset.model_validate(changed)
    second = store.save_run(root, variant, spec, run_backtest(variant, spec))
    assert variant.manifest.dataset_id == dataset.manifest.dataset_id
    with pytest.raises(ValueError):
        store.compare_runs(root, [first, second])


def test_compare_conservatively_blocks_lookback_difference(tmp_path, inputs):
    dataset, spec, _ = inputs
    changed = spec.model_dump(mode="json")
    changed["start"] = "2024-01-03"
    root = tmp_path / "runs"
    ids = []
    for lookback in (0, 1):
        changed["lookback"] = lookback
        variant = ResearchSpec.model_validate(changed)
        ids.append(store.save_run(root, dataset, variant, run_backtest(dataset, variant)))
    with pytest.raises(ValueError):
        store.compare_runs(root, ids)


def test_compare_requires_at_least_two_unique_canonical_ids(saved):
    root, run_id = saved
    for ids in ([], [run_id], [run_id, run_id], [run_id, "../escape"], (run_id, run_id)):
        with pytest.raises(ValueError):
            store.compare_runs(root, ids)


def test_decisions_append_separately_with_exact_text_and_canonical_bytes(saved):
    root, run_id = saved
    before = contents(root / run_id)
    assert store.list_decisions(root, run_id) == []
    assert not (root / "decisions").exists()
    texts = ["  검토: synthetic only.\n", "Revisit fees; 日本語 note."]
    ids = [store.add_decision(root, run_id, text) for text in texts]
    assert len(set(ids)) == 2
    notes = store.list_decisions(root, run_id)
    assert {note["id"]: note["text"] for note in notes} == dict(zip(ids, texts, strict=True))
    for note in notes:
        assert set(note) == {"id", "run_id", "created_at", "text"}
        assert str(UUID(note["id"])) == note["id"]
        assert note["run_id"] == run_id
        assert datetime.fromisoformat(note["created_at"]).utcoffset() == timedelta(0)
        raw = (root / "decisions" / run_id / f"{note['id']}.json").read_bytes()
        assert raw == canonical(note) and raw.isascii()
    assert contents(root / run_id) == before
    assert len(store.list_runs(root)) == 1
    assert store.replay_run(root, run_id)["status"] == "verified"


@pytest.mark.parametrize("text", ["", " \n\t", None, 123, ["note"]])
def test_invalid_note_rejected_without_creating_directories(saved, text):
    root, run_id = saved
    with pytest.raises(ValueError):
        store.add_decision(root, run_id, text)
    assert not (root / "decisions").exists()


def test_note_uuid_collision_preserves_original(saved, monkeypatch):
    root, run_id = saved
    fixed = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    monkeypatch.setattr(store, "uuid4", lambda: fixed)
    decision_id = store.add_decision(root, run_id, "original")
    before = contents(root / "decisions" / run_id)
    with pytest.raises(ValueError):
        store.add_decision(root, run_id, "replacement")
    assert contents(root / "decisions" / run_id) == before
    assert store.list_decisions(root, run_id)[0]["id"] == decision_id


def test_failed_note_write_cleans_partial_note(saved, monkeypatch):
    root, run_id = saved

    def fail_fsync(fd):
        raise OSError("private-path-sentinel")

    monkeypatch.setattr(store.os, "fsync", fail_fsync)
    with pytest.raises(ValueError, match="^unable to save decision$"):
        store.add_decision(root, run_id, "partial")
    assert store.list_decisions(root, run_id) == []


@pytest.mark.parametrize("damage", ["malformed", "wrong_run", "wrong_id", "empty", "extra"])
def test_corrupt_notes_are_not_silently_skipped(saved, damage):
    root, run_id = saved
    decision_id = store.add_decision(root, run_id, "original")
    path = root / "decisions" / run_id / f"{decision_id}.json"
    if damage == "malformed":
        path.write_bytes(b"{")
    elif damage == "extra":
        (path.parent / "unexpected.txt").write_bytes(b"unexpected")
    else:
        note = read(path)
        note[{"wrong_run": "run_id", "wrong_id": "id", "empty": "text"}[damage]] = ""
        path.write_bytes(canonical(note))
    with pytest.raises(ValueError, match="^invalid decisions$"):
        store.list_decisions(root, run_id)
    assert store.load_run(root, run_id)["manifest"]["run_id"] == run_id


def symlink(link: Path, target: Path, *, directory: bool = False) -> None:
    try:
        link.symlink_to(target, target_is_directory=directory)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation requires platform support/Windows privileges")


@pytest.mark.parametrize("location", ["root", "ancestor", "run", "file", "dangling"])
def test_symlink_paths_rejected_without_reading_outside_store(saved, inputs, location):
    root, run_id = saved
    outside = root.parent / "outside.json"
    outside.write_bytes(b"outside-sentinel")
    if location in ("root", "ancestor"):
        link = root.parent / "linked-root"
        symlink(link, root, directory=True)
        configured = link if location == "root" else link / "new-runs"
        with pytest.raises(ValueError):
            store.list_runs(configured)
        with pytest.raises(ValueError):
            store.save_run(configured, *inputs)
        assert not (root / "new-runs").exists()
    elif location == "run":
        alias = str(uuid4())
        symlink(root / alias, root / run_id, directory=True)
        with pytest.raises(ValueError):
            store.load_run(root, alias)
        with pytest.raises(ValueError):
            store.list_runs(root)
    else:
        path = root / run_id / "result.json"
        path.unlink()
        symlink(path, outside if location == "file" else root.parent / "nonexistent")
        with pytest.raises(ValueError):
            store.load_run(root, run_id)
    assert outside.read_bytes() == b"outside-sentinel"


@pytest.mark.parametrize("location", ["decisions", "run", "note"])
def test_decision_links_cannot_read_or_write_outside_store(saved, location):
    root, run_id = saved
    decision_id = store.add_decision(root, run_id, "inside")
    outside = root.parent / "outside-notes"
    outside.mkdir()
    sentinel = outside / f"{decision_id}.json"
    sentinel.write_bytes(b"outside-sentinel")
    notes = root / "decisions" / run_id
    note = notes / f"{decision_id}.json"
    note.unlink()
    if location == "note":
        symlink(note, sentinel)
    else:
        notes.rmdir()
        link = notes
        if location == "decisions":
            notes.parent.rmdir()
            link = notes.parent
        symlink(link, outside, directory=True)
        with pytest.raises(ValueError):
            store.add_decision(root, run_id, "must not escape")
    with pytest.raises(ValueError):
        store.list_decisions(root, run_id)
    assert contents(outside) == {sentinel.name: b"outside-sentinel"}


def test_reparse_point_is_rejected_without_following_it(tmp_path, monkeypatch):
    class ReparseInfo:
        st_mode = 0o040755
        st_file_attributes = 0x400

    monkeypatch.setattr(Path, "lstat", lambda self: ReparseInfo())
    with pytest.raises(ValueError, match="^invalid run store$"):
        store.list_runs(tmp_path)


def test_lists_have_stable_timestamp_then_uuid_order(saved, inputs, monkeypatch):
    root, first = saved
    second = store.save_run(root, *inputs)
    for run_id in (first, second):
        path = root / run_id / "manifest.json"
        manifest = read(path)
        manifest["created_at"] = "2024-01-01T00:00:00Z"
        path.write_bytes(canonical(manifest))
    assert [row["id"] for row in store.list_runs(root)] == sorted([first, second])
    monkeypatch.setattr(store, "_now", lambda: "2024-01-01T00:00:00Z")
    ids = [store.add_decision(root, first, text) for text in ("one", "two")]
    assert [row["id"] for row in store.list_decisions(root, first)] == sorted(ids)