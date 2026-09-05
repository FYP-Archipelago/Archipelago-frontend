"""Getting a run *into* the app.

This platform does not execute searches -- the harness does that, and Volpe
already owns orchestration. What it needs is a way to accept a finished run and
put it somewhere the reader can find, whether that arrives as a zip from a
colleague, a folder from a shared drive, or five loose files.

The only thing that makes a directory a run is the schema 2.0 layout, so that
is the whole of the validation here.
"""

from __future__ import annotations

import io
import json
import shutil
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

#: Without this there is no trajectory to draw.
REQUIRED = ("evaluations.csv",)

#: The rest of the layout. Each missing one costs a specific page, not the run.
OPTIONAL = {
    "run.jsonl": "Run browser, Migration and Convergence will be empty",
    "evaluations.schema.json": "the CSV's column contract is unavailable",
    "resolved_config.yaml": "the resolved configuration will not be shown",
    "summary.json": "no machine-readable outcome",
}

_ALL = tuple(REQUIRED) + tuple(OPTIONAL)


@dataclass
class Inspection:
    """What we found when we looked inside an upload."""

    ok: bool
    present: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    suggested_name: str = ""

    @property
    def summary(self) -> str:
        if not self.ok:
            return "; ".join(self.problems)
        return f"{len(self.present)} of {len(_ALL)} files present"


def _is_safe(name: str) -> bool:
    """Reject absolute paths and anything climbing out of the target directory.

    An uploaded archive is untrusted input; a zip entry named ``../../x`` would
    otherwise write outside ``data/``.
    """
    if not name or name.startswith(("/", "\\")):
        return False
    if ".." in PurePosixPath(name).parts or ".." in name.split("\\"):
        return False
    return ":" not in name


def _run_root(names: list[str]) -> str | None:
    """Find the prefix inside an archive that holds ``evaluations.csv``.

    People zip a run either as the directory or as its contents, and macOS adds
    ``__MACOSX``; all three should work.
    """
    candidates = [
        n
        for n in names
        if PurePosixPath(n).name == "evaluations.csv" and not n.startswith("__MACOSX")
    ]
    if not candidates:
        return None
    # Shallowest wins, so a run nested inside an exports folder still resolves.
    shallowest = min(candidates, key=lambda n: len(PurePosixPath(n).parts))
    parent = str(PurePosixPath(shallowest).parent)
    return "" if parent == "." else parent


def inspect_zip(payload: bytes) -> Inspection:
    """Look inside an uploaded archive without writing anything."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile:
        return Inspection(ok=False, problems=["That file is not a readable zip archive."])

    names = [n for n in archive.namelist() if not n.endswith("/")]
    if any(not _is_safe(n) for n in names):
        return Inspection(
            ok=False,
            problems=["The archive contains unsafe paths (absolute, or climbing above the root)."],
        )

    root = _run_root(names)
    if root is None:
        return Inspection(
            ok=False,
            problems=["No `evaluations.csv` anywhere in the archive, so this is not a run."],
        )

    prefix = f"{root}/" if root else ""
    held = {
        PurePosixPath(n).name
        for n in names
        if n.startswith(prefix) and "/" not in n[len(prefix) :]
    }

    present = [f for f in _ALL if f in held]
    missing = [f for f in _ALL if f not in held]
    return Inspection(
        ok=True,
        present=present,
        missing=missing,
        warnings=[OPTIONAL[f] for f in missing if f in OPTIONAL],
        suggested_name=PurePosixPath(root).name if root else "",
    )


def install_zip(payload: bytes, root: Path, *, name: str = "") -> Path:
    """Extract a validated archive into ``root/<name>/`` and return that path.

    Only the five contract files are written. Anything else in the archive --
    island shards, notes, a stray ``.DS_Store`` -- is ignored rather than
    copied, so what lands in ``data/`` is always exactly a run.
    """
    inspection = inspect_zip(payload)
    if not inspection.ok:
        raise ValueError(inspection.summary)

    archive = zipfile.ZipFile(io.BytesIO(payload))
    names = [n for n in archive.namelist() if not n.endswith("/")]
    prefix = _run_root(names)
    prefix = f"{prefix}/" if prefix else ""

    target = _unique(root, name or inspection.suggested_name or "run")
    target.mkdir(parents=True)
    try:
        for entry in names:
            if not entry.startswith(prefix):
                continue
            leaf = entry[len(prefix) :]
            if "/" in leaf or leaf not in _ALL:
                continue
            (target / leaf).write_bytes(archive.read(entry))
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise
    return target


def install_files(files: dict[str, bytes], root: Path, *, name: str) -> Path:
    """Write loose uploaded files into a new run directory."""
    if not any(f in files for f in REQUIRED):
        raise ValueError("`evaluations.csv` is required — without it there is nothing to draw.")

    target = _unique(root, name or "run")
    target.mkdir(parents=True)
    try:
        for filename, payload in files.items():
            if filename in _ALL:
                (target / filename).write_bytes(payload)
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise
    return target


def inspect_directory(path: Path) -> Inspection:
    """Same check, against a directory already on disk."""
    if not path.is_dir():
        return Inspection(ok=False, problems=[f"`{path}` is not a directory."])
    held = {p.name for p in path.iterdir() if p.is_file()}
    if not set(REQUIRED) <= held:
        return Inspection(ok=False, problems=["No `evaluations.csv`, so this is not a run."])
    missing = [f for f in _ALL if f not in held]
    return Inspection(
        ok=True,
        present=[f for f in _ALL if f in held],
        missing=missing,
        warnings=[OPTIONAL[f] for f in missing if f in OPTIONAL],
        suggested_name=path.name,
    )


def import_directory(source: Path, root: Path, *, name: str = "") -> Path:
    """Copy a run directory already on this machine into ``data/``."""
    inspection = inspect_directory(source)
    if not inspection.ok:
        raise ValueError(inspection.summary)

    target = _unique(root, name or source.name)
    target.mkdir(parents=True)
    for filename in _ALL:
        candidate = source / filename
        if candidate.is_file():
            shutil.copy2(candidate, target / filename)
    return target


def remove_run(path: Path, root: Path) -> None:
    """Delete a run directory, refusing anything that is not inside ``data/``."""
    path, root = path.resolve(), root.resolve()
    if root not in path.parents:
        raise ValueError("Refusing to delete a path outside the data directory.")
    shutil.rmtree(path)


def describe(path: Path) -> dict:
    """Cheap metadata for the library table -- no CSV parse, no full load."""
    info: dict = {"name": path.name, "size": _directory_size(path)}
    summary_file = path / "summary.json"
    if summary_file.is_file():
        try:
            summary = json.loads(summary_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return info
        info.update(
            evaluations=summary.get("total_evaluations"),
            islands=summary.get("islands_completed"),
            migrations=summary.get("total_migration_events"),
            best=summary.get("global_best_fitness"),
            outcome=summary.get("termination_reason"),
            seconds=summary.get("wallclock_seconds"),
        )
    return info


def _directory_size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.iterdir() if p.is_file())


def _unique(root: Path, name: str) -> Path:
    """A path under ``root`` that does not exist yet, suffixing on collision."""
    stem = "".join(c for c in name if c.isalnum() or c in "-_.") or "run"
    candidate = root / stem
    counter = 2
    while candidate.exists():
        candidate = root / f"{stem}-{counter}"
        counter += 1
    return candidate
