"""A LIVE build, as another process sees one — for the tests of the run lock and the sweeps.

`hold()` starts a child process that does what a running build_marts does to the data dir:
optionally takes the family's run lock (the flock main() takes), opens the scratch database
read-write through DuckDB (DuckDB's own file lock), commits a table so the scratch has a .wal,
and puts a block in the spill dir. It then waits. On exit the context manager tells it to keep
going — write again, checkpoint, close — and fails the test unless that WORKED: a build whose
scratch was deleted under it cannot. That is the property the 2026-09-22 review broke: a
second, refused run deleting the first one's .building, .wal and spill.

Not a test module (no test_ prefix); imported by them.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap
from contextlib import contextmanager
from pathlib import Path

ETL = Path(__file__).resolve().parents[1]

_CHILD = textwrap.dedent("""
    import fcntl, os, sys
    import duckdb
    data, scratch, lock_name, spill = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    if lock_name:
        fd = os.open(os.path.join(data, lock_name), os.O_RDWR | os.O_CREAT, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX)
        os.ftruncate(fd, 0)
        os.write(fd, b"pid=%d argv=holder" % os.getpid())
    con = duckdb.connect(scratch)
    con.execute("CREATE TABLE IF NOT EXISTS live AS SELECT range AS i FROM range(1000)")
    os.makedirs(spill, exist_ok=True)
    with open(os.path.join(spill, "duckdb_temp_storage-0.tmp"), "wb") as f:
        f.write(b"x" * 4096)
    print("ready", flush=True)
    sys.stdin.readline()
    # Carry on like a build that is still running: write, checkpoint, close.
    con.execute("INSERT INTO live VALUES (-1)")
    con.execute("CHECKPOINT")
    n = con.execute("SELECT count(*) FROM live").fetchone()[0]
    con.close()
    assert os.path.exists(scratch), "the scratch database was deleted under a live build"
    assert os.path.isdir(spill), "the spill dir was deleted under a live build"
    print(f"done {n}", flush=True)
""")


@contextmanager
def hold(data: Path, scratch_name: str, lock_name: str | None):
    """Yield the (scratch, wal, spill) paths of a live child build; see the module docstring.
    `lock_name` None = a holder that takes NO run lock (an older build_marts, a duckdb shell)."""
    scratch = data / scratch_name
    spill = data / f"{scratch_name}.tmp"
    proc = subprocess.Popen(
        [sys.executable, "-c", _CHILD, str(data), str(scratch), lock_name or "", str(spill)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = proc.stdout.readline().strip()
        assert line == "ready", f"holder failed to start: {line!r} {proc.stderr.read()}"
        yield scratch, Path(f"{scratch}.wal"), spill
        out, err = proc.communicate("go\n", timeout=60)
        assert proc.returncode == 0 and out.strip() == "done 1001", (
            f"the live build could not carry on after the other run (rc={proc.returncode}): "
            f"{out!r} {err[-2000:]!r}")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def lock_files() -> set[str]:
    import build_marts as bm
    return {bm.BUILD_LOCK_NAME, bm.RESCORE_LOCK_NAME}


def listing(data: Path) -> list[str]:
    """The data dir's entries, minus the run-lock files every locked run leaves behind (empty,
    permanent by design — see _RunLock)."""
    return sorted(p.name for p in data.iterdir() if p.name not in lock_files())


if str(ETL) not in sys.path:   # so `import build_marts` works from a bare import of this module
    sys.path.insert(0, str(ETL))
