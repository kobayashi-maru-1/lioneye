"""Get the build-lab game database for the PoB version in use, and query it.

  game-db.py path [--pob-version X] [--no-build]   ensure the database is cached; prints {"path", "pobVersion", "source"}
  game-db.py sql "SELECT ..." [--pob-version X]    run a read-only query; prints rows as JSON

Order: cached copy (checked against its manifest), then the db-<version> release on GitHub, then a local build
with build-game-db.py (needs lupa; about 30 s plus first-run PoB download) unless --no-build.
The PoB version is the installed app's (or POB_DIR's) when there is one, otherwise PoB's latest release; offline
with no local PoB, the newest cached database is used.

Cache: %LOCALAPPDATA%\\poe-build-expert\\game-db on Windows, ~/.cache/poe-build-expert/game-db elsewhere
(shared with the poe-build-expert skill's PoB cache). The two newest versions are kept.
"""
import argparse
import gzip
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = "kobayashi-maru-1/lioneye"
RELEASE_URL = "https://github.com/" + REPO + "/releases/download/db-{v}/{name}"
UA = {"User-Agent": "lioneye-build-lab/0.1"}
KEEP_VERSIONS = 2
LOCK_WAIT = 90      # seconds to wait for another process's download or build (under a tool call's timeout)


def load_pob_lib():
    spec = importlib.util.spec_from_file_location("ph", os.path.join(HERE, "..", "pob", "pob-headless.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def cache_dir(ph):
    d = os.path.join(ph.CACHE_DIR, "game-db")
    os.makedirs(d, exist_ok=True)
    return d


def _vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "0"))


def cached_versions(folder):
    vs = [m.group(1) for m in (re.fullmatch(r"game-([\d.]+)\.sqlite", n) for n in os.listdir(folder)) if m]
    return sorted(vs, key=_vtuple, reverse=True)


def _installed_pob(ph):
    """An installed PoB (app or POB_DIR), not a cached GitHub source copy, which pob-headless moves to a newer
    release on its own."""
    local = ph.find_pob(download=False)
    if local and not os.path.exists(os.path.join(local, ".prefetched")):
        return local
    return None


def pob_version(ph, folder):
    """(version, note). The installed PoB's version, else PoB's latest release (what a GitHub-source run uses),
    else the newest cached database."""
    local = _installed_pob(ph)
    v = ph.pob_version(local) if local else None
    if v:
        return v, None
    try:
        return ph.latest_version(), None
    except (OSError, urllib.error.URLError) as e:
        have = [x for x in cached_versions(folder) if cached_ok(folder, x)]
        if have:
            return have[0], f"offline ({e}); using the newest cached database"
        raise RuntimeError(f"can't tell which PoB version to use: no local PoB and offline ({e})") from None


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _replace(tmp, path):
    """os.replace, removing tmp when it fails (e.g. Windows: another process has `path` open)."""
    try:
        os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _write_atomic(path, data):
    tmp = f"{path}.{os.getpid()}.part"
    with open(tmp, "wb") as f:
        f.write(data)
    _replace(tmp, path)


def cached_ok(folder, v):
    """Path of a cached database that matches its manifest, else None. The full hash runs once per file
    change; a stamp records the size, mtime and hash it checked."""
    db, man, stamp = (os.path.join(folder, f"game-{v}{ext}") for ext in (".sqlite", ".json", ".sqlite.verified"))
    try:
        with open(man, encoding="utf-8") as f:
            want = json.load(f)["files"][f"game-{v}.sqlite"]["sha256"]
        st = os.stat(db)
        key = f"{st.st_size}:{st.st_mtime_ns}:{want}"
        try:
            with open(stamp, encoding="utf-8") as f:
                if f.read() == key:
                    return db
        except OSError:
            pass
        if sha256(db) != want:
            return None
    except (OSError, ValueError, KeyError, TypeError):
        return None
    try:
        _write_atomic(stamp, key.encode())
    except OSError:
        pass  # another process has the stamp open (Windows); the database itself checked out
    return db


def download(folder, v):
    """True when the release had a good database; False when it has none for this version (404)."""
    try:
        manifest = _get(RELEASE_URL.format(v=v, name=f"game-{v}.json"), timeout=30)
        files = json.loads(manifest)["files"]
        want_gz, want_db = files[f"game-{v}.sqlite.gz"]["sha256"], files[f"game-{v}.sqlite"]["sha256"]
        gz = _get(RELEASE_URL.format(v=v, name=f"game-{v}.sqlite.gz"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise
    except (ValueError, KeyError, TypeError) as e:
        raise RuntimeError(f"release db-{v} has a malformed manifest ({e})") from None
    if hashlib.sha256(gz).hexdigest() != want_gz:
        raise RuntimeError("downloaded database doesn't match its manifest checksum; run again")
    db = os.path.join(folder, f"game-{v}.sqlite")
    tmp = f"{db}.{os.getpid()}.part"
    with gzip.open(io.BytesIO(gz)) as src, open(tmp, "wb") as dst:
        shutil.copyfileobj(src, dst)
    if sha256(tmp) != want_db:
        os.remove(tmp)
        raise RuntimeError("unpacked database doesn't match its manifest checksum")
    _replace(tmp, db)
    _write_atomic(os.path.join(folder, f"game-{v}.json"), manifest)
    return True


def _get(url, timeout=120):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def build(folder, v, ph):
    """Build version v locally in a temp folder, then move it into the cache. Refuses when the PoB the
    builder would run isn't v (an installed PoB of another version, or a newer PoB release)."""
    local = _installed_pob(ph)
    env = dict(os.environ)
    if local:
        have = ph.pob_version(local)
        env["POB_DIR"] = local  # the builder runs exactly this PoB
    else:
        have = ph.latest_version()  # the builder fetches PoB's latest release from GitHub
    if have != v:
        raise RuntimeError(f"no database release for PoB {v}, and a local build would use PoB {have}")
    py = sys.executable
    if ph._lj is None and os.path.exists(getattr(ph, "VENV_PY", "")):
        py = ph.VENV_PY
    with tempfile.TemporaryDirectory(dir=folder, prefix="build-") as tmp:
        r = subprocess.run([py, os.path.join(HERE, "build-game-db.py"), "--out", tmp],
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=env)
        if r.returncode != 0:
            raise RuntimeError("local build failed: " + r.stderr.strip()[-600:])
        built = os.path.join(tmp, f"game-{v}.sqlite")
        if not os.path.exists(built):
            raise RuntimeError(f"local build produced no database for PoB {v}")
        _replace(built, os.path.join(folder, f"game-{v}.sqlite"))
        _replace(os.path.join(tmp, f"game-{v}.json"), os.path.join(folder, f"game-{v}.json"))


class _Lock:
    """One process at a time downloads or builds into the cache (parallel tool calls share it). An OS lock on
    a file that's never deleted: it's released when the process exits, even when it's killed."""

    def __init__(self, folder):
        self.path = os.path.join(folder, ".lock")
        self.f = None

    def _try(self):
        if os.name == "nt":
            import msvcrt
            self.f.seek(0)
            msvcrt.locking(self.f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def __enter__(self):
        self.f = open(self.path, "a+b")
        start = time.time()
        while True:
            try:
                self._try()
                return self
            except OSError:
                if time.time() - start > LOCK_WAIT:
                    self.f.close()
                    raise RuntimeError("another process is downloading or building the game database; "
                                       "run again in a minute") from None
                time.sleep(0.5)

    def __exit__(self, *exc):
        try:
            if os.name == "nt":
                import msvcrt
                self.f.seek(0)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        self.f.close()


def prune(folder, keep):
    """Keep the newest versions; also remove temp folders and .part files a killed run left (we hold the lock,
    so nothing else is writing them)."""
    for name in os.listdir(folder):
        p = os.path.join(folder, name)
        if name.startswith("build-") and os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        elif name.endswith(".part"):
            try:
                os.remove(p)
            except OSError:
                pass
    for v in cached_versions(folder)[KEEP_VERSIONS:]:
        if v == keep:
            continue
        for ext in (".sqlite", ".json", ".sqlite.verified"):
            try:
                os.remove(os.path.join(folder, f"game-{v}{ext}"))
            except OSError:
                pass


def ensure(v=None, allow_build=True):
    ph = load_pob_lib()
    folder = cache_dir(ph)
    note = None
    if not v:
        v, note = pob_version(ph, folder)
    path = cached_ok(folder, v)
    if path:
        return {"path": path, "pobVersion": v, "source": "cached", **({"note": note} if note else {})}
    with _Lock(folder):
        path = cached_ok(folder, v)  # another process may have finished it while we waited
        if path:
            return {"path": path, "pobVersion": v, "source": "cached"}
        try:
            got = download(folder, v)
        except (urllib.error.URLError, OSError) as e:
            if not allow_build:
                raise RuntimeError(f"couldn't download the database for PoB {v} ({e})") from None
            got = False  # offline or GitHub unreachable: build it here instead
        if got:
            source = "downloaded"
        elif not allow_build:
            raise RuntimeError(f"no database release for PoB {v} yet (db-{v}); run without --no-build to build one")
        else:
            build(folder, v, ph)
            source = "built"
        path = cached_ok(folder, v)
        if not path:
            raise RuntimeError(f"the {source} database for PoB {v} doesn't match its manifest")
        prune(folder, v)
    return {"path": path, "pobVersion": v, "source": source}


def main():
    ap = argparse.ArgumentParser(description="build-lab game database")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("path")
    p.add_argument("--pob-version")
    p.add_argument("--no-build", action="store_true")
    p = sub.add_parser("sql")
    p.add_argument("query")
    p.add_argument("--pob-version")
    p.add_argument("--limit", type=int, default=200)
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    if args.cmd == "path":
        print(json.dumps(ensure(args.pob_version, not args.no_build)))
        return
    info = ensure(args.pob_version)
    db = sqlite3.connect(f"file:{info['path']}?mode=ro", uri=True)
    cur = db.execute(args.query)
    cols = [c[0] for c in cur.description or []]
    rows = cur.fetchmany(args.limit + 1)
    print(json.dumps({"pobVersion": info["pobVersion"], "columns": cols, "rows": rows[:args.limit],
                      "truncated": len(rows) > args.limit}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, sqlite3.Error, urllib.error.URLError) as e:
        sys.exit(f"error: {e}")
