"""Share the ladder crawl through GitHub, so chats without it on disk (Desktop, web and phone sandboxes) can use it.

The Lioneye repo's `crawl-data` branch holds one gzip file per league, refs-<league>.json.gz:
  {"league", "published", "crawl": <the crawl's data: per-skill counts, progress>,
   "builds": {"ladder-0001.json": <reference build>, ...}}
Reference builds keep the account and character names, so a build's current copy can be read from GGG later.
Each publish replaces the branch with a single commit (force-push): old crawls don't pile up in the repo.

publish(league)  bundle the league's crawl and push it (the PC's night task runs it after each window in which
                 the crawl moved on, or when the last push failed: needs_publish)
fetch(league)    download the league's bundle into the cache when this machine has no crawl of its own (a
                 download is refreshed after a day); ensure() does it once per process and never raises (the
                 designer calls it before reading crawl data). The PC's own crawl is never replaced unless forced.
"""
import gzip
import json
import os
import shutil
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

import popularity as P
from net import cache_root

BRANCH = "crawl-data"
RAW = "https://raw.githubusercontent.com/kobayashi-maru-1/lioneye/" + BRANCH + "/{name}"
REPO_URL = "https://github.com/kobayashi-maru-1/lioneye.git"  # when the build lab isn't inside a clone
UA = "lioneye-build-lab/0.1"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_ensured = {}


def bundle_name(league):
    return f"refs-{''.join(c if c.isalnum() else '-' for c in league)}.json.gz"


def _ladder_files(league):
    folder = P.refs_dir(league)
    if not os.path.isdir(folder):
        return []
    return sorted(n for n in os.listdir(folder) if n.startswith("ladder-") and n.endswith(".json"))


def bundle(league):
    """(gzip bytes, number of builds) of the league's crawl and ladder reference builds; (None, 0) without a crawl."""
    data = P.load_crawl(league)
    if not data:
        return None, 0
    builds = {}
    for name in _ladder_files(league):
        try:
            with open(os.path.join(P.refs_dir(league), name), encoding="utf-8") as f:
                builds[name] = json.load(f)
        except (OSError, ValueError):
            continue
    blob = {"league": league, "published": time.time(), "crawl": data, "builds": builds}
    return gzip.compress(json.dumps(blob, separators=(",", ":")).encode("utf-8"), mtime=0), len(builds)


GIT_TIMEOUT = 900  # seconds per git command: a push of ~12 MB on a slow line, never a hang until the task's kill
# The night task can't answer prompts: fail (and log it) instead of opening a sign-in window on a locked screen.
GIT_ENV = {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never", "GIT_ASKPASS": "", "SSH_ASKPASS": ""}


def _git(args, cwd, check=True):
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # pythonw (the night task) has no console to flash
    try:
        r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, creationflags=flags,
                           env={**os.environ, **GIT_ENV}, stdin=subprocess.DEVNULL, timeout=GIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"git {args[0]} took over {GIT_TIMEOUT // 60} min; stopped") from None
    if check and r.returncode:
        raise RuntimeError(f"git {args[0]} failed: {(r.stderr or r.stdout).strip()[-300:]}")
    return r


def _rmtree(path):
    """shutil.rmtree that also removes git's read-only object files (Windows)."""
    def unlock(func, p, _exc):
        os.chmod(p, stat.S_IWRITE)
        func(p)
    if os.path.isdir(path):
        try:
            shutil.rmtree(path, onerror=unlock)
        except OSError:
            pass


def _repo_config(key):
    """A setting of the clone the build lab sits in (None outside a clone; works for worktrees too)."""
    if not os.path.exists(os.path.join(REPO_ROOT, ".git")):
        return None
    try:
        r = _git(["config", "--get", key], REPO_ROOT, check=False)
    except (OSError, RuntimeError):
        return None
    return (r.stdout.strip() or None) if r.returncode == 0 else None


def _state_path(league):
    return os.path.join(cache_root(), f"crawl-published-{''.join(c if c.isalnum() else '-' for c in league)}.json")


def _key(crawl):
    """What identifies a crawl's progress: a new crawl, characters processed (read or skipped), finished."""
    return [crawl.get("started"), crawl.get("next"), bool(crawl.get("done"))]


def needs_publish(league):
    """True when the PC's crawl has moved on since its last successful publish (a failed push is tried again)."""
    crawl = P.load_crawl(league)
    if not crawl or crawl.get("fetched"):
        return False  # nothing to publish, or a downloaded copy
    try:
        with open(_state_path(league), encoding="utf-8") as f:
            return json.load(f).get("key") != _key(crawl)
    except (OSError, ValueError):
        return True


def publish(league, remote=None, say=print):
    """Put the league's bundle on the crawl-data branch, keeping other leagues' bundles. Needs git and push rights
    (the clone's origin and its credentials). Returns {"published", "builds", "bytes"} or {"published": False, "note"}."""
    crawl = P.load_crawl(league) or {}
    if crawl.get("fetched"):
        return {"published": False, "note": "the crawl on disk was downloaded, not crawled here"}
    blob, n = bundle(league)
    if not blob:
        return {"published": False, "note": f"no crawl for {league}"}
    remote = remote or _repo_config("remote.origin.url") or REPO_URL
    _rmtree(os.path.join(cache_root(), "crawl-publish"))  # left by an older version
    os.makedirs(cache_root(), exist_ok=True)
    work = tempfile.mkdtemp(prefix="crawl-publish-", dir=cache_root())
    try:
        _git(["init", "-q"], work)
        # ls-remote fails when GitHub can't be reached: stop rather than push a branch missing the other leagues
        head = _git(["ls-remote", "--heads", remote, BRANCH], work).stdout.split()
        seen = head[0] if head else ""  # the push only replaces this commit (a publish at the same time fails)
        if seen:
            _git(["fetch", "-q", "--depth", "1", remote, BRANCH], work)
            _git(["read-tree", "FETCH_HEAD"], work)  # the other leagues' bundles
            _git(["checkout-index", "-a", "-f"], work)
        with open(os.path.join(work, bundle_name(league)), "wb") as f:
            f.write(blob)
        with open(os.path.join(work, "README.md"), "w", encoding="utf-8") as f:
            f.write("# Build lab crawl data\n\nLadder crawl results per league, written by the build lab's night "
                    "crawl (`build-lab/market/crawldata.py`). Replaced on every update; see `main` for the code.\n")
        _git(["add", "-A"], work)
        who = ["-c", f"user.name={_repo_config('user.name') or 'lioneye-build-lab'}",
               "-c", f"user.email={_repo_config('user.email') or 'build-lab@users.noreply.github.com'}"]
        _git(who + ["commit", "-q", "-m", f"Crawl data: {league}, {crawl.get('read', 0)} characters, {n} builds"], work)
        _git(["push", "-q", f"--force-with-lease=refs/heads/{BRANCH}:{seen}", remote, f"HEAD:refs/heads/{BRANCH}"],
             work)
    finally:
        _rmtree(work)
    P._save(_state_path(league), {"key": _key(crawl), "published": time.time(), "builds": n})
    say(f"published {league}: {n} builds, {len(blob) // 1024} KB to the {BRANCH} branch")
    return {"published": True, "builds": n, "bytes": len(blob)}


FETCHED_MARK = ".fetched"  # in the refs folder: its ladder builds came from a download, not this machine's crawl


def _own_crawl(league):
    """True when this machine has a crawl of its own (the PC): a crawl file that wasn't downloaded, even an
    unreadable one, or ladder builds without the download mark. Never replaced by a download."""
    path = P.crawl_path(league)
    if os.path.exists(path):
        crawl = P.load_crawl(league)
        return not (crawl and crawl.get("fetched"))
    folder = P.refs_dir(league)
    if os.path.isdir(folder) and not os.path.exists(os.path.join(folder, FETCHED_MARK)):
        return any(n.startswith("ladder-") for n in os.listdir(folder))
    return False


def unpack(league, blob):
    """Write a bundle into the cache: the ladder builds in place of any on disk, then the crawl data last (so an
    interrupted unpack leaves no crawl file and the next use downloads again)."""
    data = json.loads(gzip.decompress(blob).decode("utf-8"))
    crawl = data.get("crawl") or {}
    crawl["fetched"] = data.get("published") or time.time()
    crawl["fetchedAt"] = time.time()
    try:
        os.remove(P.crawl_path(league))
    except OSError:
        pass
    folder = P.refs_dir(league)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, FETCHED_MARK), "w", encoding="utf-8") as f:
        f.write("downloaded crawl data\n")
    P.clear_references(league)
    for name, ref in (data.get("builds") or {}).items():
        if name.startswith("ladder-") and name.endswith(".json") and os.path.basename(name) == name:
            P._save(os.path.join(folder, name), ref)
    P._save(P.crawl_path(league), crawl)
    return {"fetched": True, "builds": len(data.get("builds") or {}), "read": crawl.get("read"),
            "done": bool(crawl.get("done"))}


REFETCH_AFTER = 24 * 3600  # a downloaded crawl older than this is downloaded again (the PC publishes nightly)


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def fetch(league, force=False, get=None):
    """Download the league's published crawl when this machine has none of its own: no crawl yet, or a downloaded
    one that's unfinished or a day old. Never replaces the PC's own crawl unless forced."""
    if not force:
        if _own_crawl(league):
            return {"fetched": False, "note": "this machine's own crawl is on disk"}
        have = P.load_crawl(league)
        if have and time.time() - (have.get("fetchedAt") or 0) < REFETCH_AFTER:
            return {"fetched": False, "note": "downloaded less than a day ago (--fetch for a fresh copy)"}
    url = RAW.format(name=bundle_name(league))
    try:
        blob = (get or _get)(url)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"fetched": False, "note": f"no published crawl for {league}"}
        return {"fetched": False, "note": f"HTTP {e.code} from {url}"}
    except (OSError, ValueError) as e:
        return {"fetched": False, "note": f"can't reach {url} ({e})"}
    return unpack(league, blob)


def ensure(league, get=None):
    """fetch() once per process; a note instead of an error when there's nothing to fetch. BUILD_LAB_NO_FETCH=1
    turns it off (the offline tests)."""
    if os.environ.get("BUILD_LAB_NO_FETCH"):
        return {"fetched": False, "note": "fetching is off (BUILD_LAB_NO_FETCH)"}
    if league not in _ensured:
        try:
            _ensured[league] = fetch(league, get=get)
        except Exception as e:  # noqa: BLE001 - crawl data is optional for every caller
            _ensured[league] = {"fetched": False, "note": str(e)}
    return _ensured[league]
