"""The build lab's notebook: what designing builds has taught, kept so later runs start from it.

  notebook.py search [QUERY] [--kind K] [--tag T] [--limit 20] [--no-local] [--offline]
  notebook.py show ID
  notebook.py add --kind KIND --title T --body B [--tags a,b] [--evidence E] [--verdict V] [--numbers JSON]
                  [--spec FILE] [--refs ID,ID] [--build NAME] [--no-push]      (or: add --json ENTRY.json)
  notebook.py check ID --result holds|contradicted [--evidence E] [--no-push]
  notebook.py recheck                       entries not confirmed on the current patch
  notebook.py import FILE|-                 entries handed back from a web or phone chat (JSON lines)
  notebook.py sync                          push entries queued while offline
  notebook.py index                         rebuild the SQLite query index; prints its path
  notebook.py sql "SELECT ..."              read-only query on the index

Kinds:
  public (committed to the Lioneye repo, build-lab/notebook/<kind>s.jsonl, pushed straight away):
    concept      a tried build idea: numbers, cost, verdict (promising | viable | weak | rejected), the spec
    interaction  a mechanic or item interaction found while designing, with evidence
    blind-spot   something PoB gets wrong or leaves out, with evidence
  local (build-lab/notebook/local/, git-ignored; never leaves this PC):
    preference   how Andy likes to play
    feedback     how a build felt in play, for his own characters
  check          a later re-test of an entry: holds or contradicted (public or local, as its entry)

Every entry records the patch (from the passive tree version), the PoB version, the league and the date.

Weight: 1 + (checks that held) - 2 x (checks that contradicted), halved when nothing confirms it on the current
patch (it needs a re-check before it's trusted). Search ranks by weight, then by how well the query matches.

Writing never touches the working tree: a public entry is appended to the file as it is on origin/main, committed
with git plumbing on a private index and pushed to main (retried when main moved). Offline, it waits in
local/pending.jsonl until `sync`. Without a Lioneye clone (a chat sandbox), search reads the public files from
raw.githubusercontent.com and add is refused: hand the entries back for a PC session to `import`.
"""
import argparse
import datetime as dt
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
REL = "build-lab/notebook"
RAW = "https://raw.githubusercontent.com/kobayashi-maru-1/lioneye/main/" + REL + "/"
UA = {"User-Agent": "lioneye-build-lab/0.1"}
REMOTE, BRANCH = "origin", "main"
LOCAL_DIR = os.path.join(HERE, "local")
PUBLIC_KINDS = ("concept", "interaction", "blind-spot")
LOCAL_KINDS = ("preference", "feedback")
KINDS = PUBLIC_KINDS + LOCAL_KINDS
VERDICTS = ("promising", "viable", "weak", "rejected")
RESULTS = ("holds", "contradicted")
ID_PATTERN = re.compile(r"[a-z]{1,2}-[a-z0-9-]{1,100}")
# The only fields a public entry may carry (anything else, e.g. a character name in "build", is refused).
_COMMON = {"id", "kind", "title", "body", "evidence", "tags", "refs", "date", "patch", "pob", "league", "source",
           "doc"}
PUBLIC_FIELDS = {"concept": _COMMON | {"verdict", "numbers", "spec"}, "interaction": _COMMON,
                 "blind-spot": _COMMON,
                 "check": {"id", "kind", "ref", "result", "evidence", "date", "patch", "pob", "league", "source"}}
PREFIX = {"concept": "c","interaction": "i", "blind-spot": "b", "preference": "p", "feedback": "f", "check": "k"}
FETCH_EVERY = 300          # seconds between git fetches for reads
PUSH_TRIES = 4
MAX_TEXT = 4000            # characters in a body
# Personal details that must never reach the public files: GGG account names (Name#1234), character links that
# carry account and character names (poe.ninja's character pages, GGG's profile pages) and email addresses.
PRIVATE = [(re.compile(r"\b[\w-]{3,}#\d{4}\b"), "an account name (Name#1234)"),
           (re.compile(r"poe\.ninja/\S*/character/", re.I), "a poe.ninja character link (account and character names)"),
           (re.compile(r"pathofexile\.com/account/view-profile/", re.I), "a GGG profile link (an account name)"),
           (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "an email address")]


def file_for(kind):
    """Repo-relative file of a public kind (and of public checks)."""
    return f"{REL}/checks.jsonl" if kind == "check" else f"{REL}/{kind}s.jsonl"


def _today():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def slug(s, n=40):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:n].strip("-") or "entry"


# ---------------- git ----------------

class Git:
    def __init__(self, start=HERE, stamp_dir=LOCAL_DIR):
        self.root = None
        self.stamp = os.path.join(stamp_dir, ".fetched")
        if start is None:
            return
        try:
            out = subprocess.run(["git", "-C", start, "rev-parse", "--show-toplevel"], capture_output=True,
                                 text=True, timeout=30)
            if out.returncode == 0 and os.path.isfile(os.path.join(out.stdout.strip(), REL, "notebook.py")):
                self.root = out.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            pass

    def run(self, *args, input=None, env=None, check=True, timeout=120):
        """Run git in the clone. Never prompts (no console under Claude Desktop): stdin is closed and terminal or
        credential-manager prompts are off, so a missing login fails fast instead of hanging. A timeout counts as
        unreachable (ConnectionError)."""
        quiet = {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
        try:
            r = subprocess.run(["git", "-C", self.root, *args], input=input, capture_output=True, timeout=timeout,
                               stdin=None if input is not None else subprocess.DEVNULL,
                               env={**os.environ, **quiet, **(env or {})})
        except subprocess.TimeoutExpired:
            raise ConnectionError(f"git {args[0]} timed out") from None
        if check and r.returncode != 0:
            raise RuntimeError(f"git {args[0]} failed: {r.stderr.decode('utf-8', 'replace').strip()[:400]}")
        return r

    def fetch(self, force=False):
        """Fetch main, at most every FETCH_EVERY seconds unless forced. False when offline."""
        if not force and os.path.exists(self.stamp) and time.time() - os.path.getmtime(self.stamp) < FETCH_EVERY:
            return True
        try:
            r = self.run("fetch", "--quiet", REMOTE, BRANCH, check=False, timeout=60)
        except ConnectionError:
            return False
        if r.returncode != 0:
            return False
        os.makedirs(os.path.dirname(self.stamp), exist_ok=True)
        with open(self.stamp, "w"):
            pass
        return True

    def tip(self):
        """origin/main's commit, or None when the clone has no such ref."""
        r = self.run("rev-parse", "--verify", "--quiet", f"refs/remotes/{REMOTE}/{BRANCH}", check=False)
        return (r.stdout.decode().strip() or None) if r.returncode == 0 else None

    def exists(self, commit, path):
        r = self.run("ls-tree", "--name-only", commit, "--", path)
        return bool(r.stdout.decode("utf-8").strip())

    def show(self, commit, path):
        """A file's text at a commit: "" when the file isn't there; an error when it is but can't be read (a
        silent "" here would rewrite the file with only the new lines)."""
        if not self.exists(commit, path):
            return ""
        return self.run("cat-file", "-p", f"{commit}:{path}").stdout.decode("utf-8")

    def append_and_push(self, changes, message):
        """changes: {repo path: [JSON lines]}. Appends on top of origin/main and pushes.
        Returns (commit or None, ids written). ids already on main are skipped (a retried push that had in fact
        landed adds nothing). Raises ConnectionError when GitHub can't be reached or keeps moving, RuntimeError
        when git fails otherwise; nothing is pushed then."""
        for attempt in range(PUSH_TRIES):
            if not self.fetch(force=True):
                raise ConnectionError("can't reach GitHub")
            base = self.tip()
            if not base:
                raise RuntimeError(f"no {REMOTE}/{BRANCH} in the clone")
            index = os.path.join(tempfile.gettempdir(), f"notebook-index-{os.getpid()}-{secrets.token_hex(4)}")
            env = {"GIT_INDEX_FILE": index}
            written = []
            try:
                self.run("read-tree", base, env=env)
                for path, lines in changes.items():
                    old = self.show(base, path)
                    have = {e.get("id") for e in _parse_lines(old)}
                    new = [l for l in lines if json.loads(l).get("id") not in have]
                    if not new:
                        continue
                    written += [json.loads(l)["id"] for l in new]
                    text = old + ("" if not old or old.endswith("\n") else "\n") + "".join(l + "\n" for l in new)
                    blob = self.run("hash-object", "-w", "--stdin", input=text.encode("utf-8")).stdout.decode().strip()
                    self.run("update-index", "--add", "--cacheinfo", f"100644,{blob},{path}", env=env)
                if not written:
                    return None, []
                tree = self.run("write-tree", env=env).stdout.decode().strip()
            finally:
                try:
                    os.remove(index)
                except OSError:
                    pass  # missing, or held by a scanner: a stray temp file, not a failure
            commit = self.run("commit-tree", tree, "-p", base, "-m", message).stdout.decode().strip()
            r = self.run("push", "--quiet", REMOTE, f"{commit}:refs/heads/{BRANCH}", check=False, timeout=120)
            if r.returncode == 0:
                self.run("update-ref", f"refs/remotes/{REMOTE}/{BRANCH}", commit, check=False)
                return commit, written
            err = r.stderr.decode("utf-8", "replace")
            if not re.search(r"non-fast-forward|fetch first|rejected", err):
                raise ConnectionError(f"push failed: {err.strip()[:300]}")
            time.sleep(1 + attempt)
        raise ConnectionError("main kept moving; try again")


def _parse_lines(text):
    out = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # a damaged line is skipped, not fatal
    return out


def _read_local(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return _parse_lines(f.read())


class _Lock:
    """A lock file next to a local JSONL file: the CLI and the MCP server may write the same files at once."""
    WAIT = 30
    STALE = 60  # seconds: a lock this old was left by a killed process

    def __init__(self, path):
        self.path = path + ".lock"

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        until = time.time() + self.WAIT
        while True:
            try:
                os.close(os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self.path) > self.STALE:
                        os.remove(self.path)
                        continue
                except OSError:
                    pass
                if time.time() > until:
                    raise RuntimeError(f"{self.path} is locked; try again")
                time.sleep(0.1)

    def __exit__(self, *exc):
        try:
            os.remove(self.path)
        except OSError:
            pass


def _write_lines(path, entries, mode):
    with open(path, mode, encoding="utf-8", newline="\n") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False, sort_keys=True) + "\n")


def _append_local(path, entries):
    """Append the entries whose id isn't in the file yet; returns the ids written."""
    with _Lock(path):
        have = {e.get("id") for e in _read_local(path)}
        new = [e for e in entries if e["id"] not in have]
        _write_lines(path, new, "a")
    return [e["id"] for e in new]


def _remove_local(path, ids):
    """Drop entries by id (the pending queue after a push); entries queued meanwhile stay."""
    ids = set(ids)
    with _Lock(path):
        keep = [e for e in _read_local(path) if e.get("id") not in ids]
        if keep:
            _write_lines(path, keep, "w")
        elif os.path.exists(path):
            os.remove(path)


# ---------------- context: patch and PoB version ----------------

_ctx = None


def context():
    """{patch, pob, tree} from the build-lab game database for the PoB in use; empty values when it's not there."""
    global _ctx
    if _ctx is None:
        _ctx = {"patch": None, "pob": None, "tree": None}
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location("game_db", os.path.join(LAB, "db", "game-db.py"))
            gdb = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(gdb)
            info = gdb.ensure(allow_build=False)
            con = sqlite3.connect(f"file:{info['path']}?mode=ro", uri=True)
            meta = dict(con.execute("SELECT key, value FROM meta"))
            con.close()
            tree = meta.get("tree_version")
            _ctx = {"patch": tree.replace("_", ".") if tree else None, "pob": meta.get("pob_version"), "tree": tree}
        except Exception:  # noqa: BLE001 - no database: entries still work, without a patch
            pass
    return _ctx


def _league():
    try:
        sys.path.insert(0, os.path.join(LAB, "market"))
        from ninja import Prices
        return Prices().league
    except Exception:  # noqa: BLE001
        return None


# ---------------- the notebook ----------------

class Notebook:
    def __init__(self, offline=False, include_local=True, repo=HERE, local_dir=LOCAL_DIR):
        """repo: a folder inside the Lioneye clone (None: no clone, read from GitHub). local_dir: where the
        private kinds, local checks and the offline queue live."""
        self.local = local_dir
        self.git = Git(repo, local_dir)
        self.offline = offline
        self.include_local = include_local

    def _local(self, name):
        return os.path.join(self.local, name)

    # -- reading --
    def _public_text(self, path):
        if self.git.root:
            if not self.offline:
                self.git.fetch()
            tip = self.git.tip()
            if tip:
                return self.git.show(tip, path)
            local = os.path.join(self.git.root, path)  # no origin/main in the clone: its working copy, if any
            if not os.path.exists(local):
                return ""
            with open(local, encoding="utf-8") as f:
                return f.read()
        if self.offline:
            return ""
        url = RAW + os.path.basename(path)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return ""
            raise

    def entries(self):
        """Every entry and check: public ones (as on origin/main), local ones, and queued ones."""
        out = []
        for kind in PUBLIC_KINDS + ("check",):
            out += _parse_lines(self._public_text(file_for(kind)))
        if self.include_local:
            for kind in LOCAL_KINDS:
                out += _read_local(self._local(f"{kind}s.jsonl"))
            out += _read_local(self._local("checks.jsonl"))
            seen = {e.get("id") for e in out}
            out += [e for e in _read_local(self._local("pending.jsonl")) if e.get("id") not in seen]
        return out

    def scored(self):
        """Entries (not checks) with weight, check counts and whether they need a re-check."""
        all_ = self.entries()
        checks = [e for e in all_ if e.get("kind") == "check"]
        patch = context()["patch"]
        out = []
        for e in all_:
            if e.get("kind") == "check":
                continue
            mine = [c for c in checks if c.get("ref") == e.get("id")]
            held = sum(c.get("result") == "holds" for c in mine)
            contra = sum(c.get("result") == "contradicted" for c in mine)
            weight = 1 + held - 2 * contra
            current = patch is None or e.get("patch") == patch or any(
                c.get("patch") == patch and c.get("result") == "holds" for c in mine)
            if not current:
                weight *= 0.5
            out.append({**e, "weight": weight, "held": held, "contradicted": contra,
                        **({} if current else {"recheck": f"from patch {e.get('patch')}; current is {patch}"}),
                        "checks": mine})
        return out

    def search(self, query=None, kind=None, tag=None, limit=20):
        words = [w for w in re.findall(r"[a-z0-9']+", (query or "").lower()) if len(w) > 1]
        hits = []
        for e in self.scored():
            if kind and e.get("kind") != kind:
                continue
            if tag and tag.lower() not in [t.lower() for t in e.get("tags") or []]:
                continue
            text = " ".join(str(e.get(k) or "") for k in ("title", "body", "evidence", "verdict", "build")).lower()
            text += " " + " ".join(e.get("tags") or []).lower()
            match = sum(text.count(w) for w in words) if words else 0
            if words and not match:
                continue
            hits.append((e["weight"], match, e.get("date") or "", e))
        hits.sort(key=lambda h: (h[0], h[1], h[2]), reverse=True)
        return [h[3] for h in hits[:limit]]

    def show(self, entry_id):
        for e in self.scored():
            if e.get("id") == entry_id:
                return e
        raise ValueError(f"no entry '{entry_id}'")

    def recheck(self):
        return [e for e in self.scored() if e.get("recheck")]

    # -- writing --
    def _stamp(self, e):
        ctx = context()
        e.setdefault("date", _today())
        e.setdefault("patch", ctx["patch"])
        e.setdefault("pob", ctx["pob"])
        if e.get("kind") == "concept" or e.get("kind") == "check":
            e.setdefault("league", _league())
        if not e.get("id"):
            # A check's id never carries its entry's title: that entry may be a private one.
            name = slug(e.get("title")) if e["kind"] != "check" else e.get("result")
            e["id"] = f"{PREFIX[e['kind']]}-{e['date'].replace('-', '')}-{name}-{secrets.token_hex(4)}"
        return {k: v for k, v in e.items() if v not in (None, "", [], {})}

    def validate(self, e):
        kind = e.get("kind")
        if kind not in KINDS + ("check",):
            raise ValueError(f"kind must be one of {', '.join(KINDS + ('check',))}")
        if e.get("id") is not None and not (isinstance(e["id"], str) and ID_PATTERN.fullmatch(e["id"])):
            raise ValueError(f"bad id {e['id']!r}: lowercase letters, digits and hyphens, like c-20261124-name-1a2b")
        for k in ("title", "body", "evidence", "verdict", "result", "ref", "build", "doc"):
            if e.get(k) is not None and not isinstance(e[k], str):
                raise ValueError(f"{k} must be text")
        if e.get("refs") is not None and not (isinstance(e["refs"], list) and all(isinstance(r, str) for r in e["refs"])):
            raise ValueError("refs must be a list of entry ids")
        if kind == "check":
            if not e.get("ref"):
                raise ValueError("a check needs 'ref' (the entry it re-tests)")
            if e.get("result") not in RESULTS:
                raise ValueError(f"result must be {' or '.join(RESULTS)}")
        else:
            if not (e.get("title") or "").strip():
                raise ValueError("an entry needs a title")
            if not (e.get("body") or "").strip():
                raise ValueError("an entry needs a body")
        if kind in ("interaction", "blind-spot") and not (e.get("evidence") or "").strip():
            raise ValueError(f"a {kind} needs evidence: the PoB numbers, test or source that shows it")
        if kind == "concept" and e.get("verdict") not in VERDICTS:
            raise ValueError(f"a concept needs a verdict: {', '.join(VERDICTS)}")
        for k in ("title", "body", "evidence"):
            if len(e.get(k) or "") > MAX_TEXT:
                raise ValueError(f"{k} is over {MAX_TEXT} characters: put long lessons in a markdown file")
        if e.get("tags") is not None and not (isinstance(e["tags"], list) and all(isinstance(t, str) for t in e["tags"])):
            raise ValueError("tags must be a list of strings")
        for k in ("numbers", "spec"):
            if e.get(k) is not None and not isinstance(e[k], dict):
                raise ValueError(f"{k} must be an object")

    def _check_public(self, e, known):
        """A public entry may carry only its kind's fields, may point only at public entries, and may not carry
        an account name or email address."""
        extra = set(e) - PUBLIC_FIELDS[e["kind"]]
        if extra:
            raise ValueError(f"'{e.get('title') or e['id']}': public entries can't carry {', '.join(sorted(extra))} "
                             "(details about a character belong in a feedback entry)")
        for r in e.get("refs") or []:
            if known.get(r) not in PUBLIC_KINDS + ("check",):
                raise ValueError(f"'{e.get('title') or e['id']}' refers to {r}, which isn't a public entry")
        text = json.dumps(e, ensure_ascii=False)
        for pattern, what in PRIVATE:
            if pattern.search(text):
                raise ValueError(f"'{e.get('title') or e['id']}' contains {what}; public entries can't carry "
                                 "personal details (use kind feedback or preference for those)")

    def add(self, entries, push=True, source=None):
        """Validate, stamp and store entries: all of them or none (every entry is checked before anything is
        written). Public entries go into the pending queue first and leave it only once pushed, so a failed push
        loses nothing. Returns {"added": ids written or queued, "skipped": ids already there, "public", "local",
        "commit"?, "queued"?}."""
        ready = []
        known = {x.get("id"): x.get("kind") for x in self.entries()}
        for raw in entries:
            if not isinstance(raw, dict):
                raise ValueError("each entry must be an object")
            e = dict(raw)
            for k in ("weight", "held", "contradicted", "recheck", "checks"):
                e.pop(k, None)   # computed fields, never stored
            if source and not e.get("source"):
                e["source"] = source
            self.validate(e)
            e = self._stamp(e)
            if e["kind"] == "check":
                if e["ref"] not in known:
                    raise ValueError(f"no entry '{e['ref']}' to check")
                public = known[e["ref"]] in PUBLIC_KINDS
            else:
                public = e["kind"] in PUBLIC_KINDS
            if public:
                self._check_public(e, known)
            known[e["id"]] = e["kind"] if e["kind"] != "check" or public else "local-check"
            ready.append((e, public))
        pub = [e for e, public in ready if public]
        if pub and not self.git.root:
            raise RuntimeError("no Lioneye clone here: hand these entries back as JSON lines for a PC session to "
                               "`notebook.py import`")
        out = {"added": [], "skipped": [], "public": 0, "local": 0}
        pending = self._local("pending.jsonl")
        queued = _append_local(pending, pub) if pub else []
        for e, public in ready:
            if not public:
                path = self._local("checks.jsonl" if e["kind"] == "check" else f"{e['kind']}s.jsonl")
                wrote = _append_local(path, [e])
                out["added" if wrote else "skipped"].append(e["id"])
                out["local"] += len(wrote)
        if pub:
            if not push:
                out["queued"] = "queued for `notebook.py sync`"
                out["added"] += queued
                out["public"] = len(queued)
            else:
                try:
                    commit, written = self._push(pub)
                except (ConnectionError, RuntimeError, OSError) as e:
                    out["queued"] = f"not pushed ({e}); queued for `notebook.py sync`"
                    out["added"] += queued
                    out["public"] = len(queued)
                else:
                    _remove_local(pending, [e["id"] for e in pub])
                    out["added"] += written
                    out["skipped"] += [e["id"] for e in pub if e["id"] not in written]
                    out["public"] = len(written)
                    if commit:
                        out["commit"] = commit
        if not out["skipped"]:
            del out["skipped"]
        return out

    def _push(self, entries):
        changes = {}
        for e in entries:
            changes.setdefault(file_for(e["kind"]), []).append(json.dumps(e, ensure_ascii=False, sort_keys=True))
        if len(entries) == 1:
            e = entries[0]
            what = e.get("title") or f"{e.get('result')} {e.get('ref')}"
            msg = f"Notebook: {e['kind']} {what}"[:72]
        else:
            msg = f"Notebook: {len(entries)} entries"
        return self.git.append_and_push(changes, msg + "\n\nWritten by the build lab (build-lab/notebook).")

    def sync(self):
        path = self._local("pending.jsonl")
        pending = _read_local(path)
        if not pending:
            return {"pushed": 0}
        if not self.git.root:
            raise RuntimeError("no Lioneye clone here")
        commit, written = self._push(pending)
        _remove_local(path, [e["id"] for e in pending])  # pushed, or already on main; later arrivals stay
        return {"pushed": len(written), **({"commit": commit} if commit else {})}

    # -- index --
    def index(self):
        folder = _cache_dir()
        path = os.path.join(folder, "notebook-index.sqlite")
        tmp = path + f".{os.getpid()}.tmp"
        con = sqlite3.connect(tmp)
        con.execute("CREATE TABLE entries (id TEXT PRIMARY KEY, kind TEXT, title TEXT, body TEXT, evidence TEXT, "
                    "verdict TEXT, tags TEXT, date TEXT, patch TEXT, pob TEXT, league TEXT, weight REAL, held INT, "
                    "contradicted INT, recheck TEXT, json TEXT)")
        con.execute("CREATE TABLE checks (id TEXT PRIMARY KEY, ref TEXT, result TEXT, evidence TEXT, date TEXT, "
                    "patch TEXT, pob TEXT)")
        for e in self.scored():
            con.execute("INSERT OR REPLACE INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (e["id"], e.get("kind"), e.get("title"), e.get("body"), e.get("evidence"), e.get("verdict"),
                         ",".join(e.get("tags") or []), e.get("date"), e.get("patch"), e.get("pob"),
                         e.get("league"), e["weight"], e["held"], e["contradicted"], e.get("recheck"),
                         json.dumps({k: v for k, v in e.items() if k != "checks"}, ensure_ascii=False)))
            for c in e["checks"]:
                con.execute("INSERT OR REPLACE INTO checks VALUES (?,?,?,?,?,?,?)",
                            (c["id"], c.get("ref"), c.get("result"), c.get("evidence"), c.get("date"),
                             c.get("patch"), c.get("pob")))
        con.commit()
        con.close()
        os.replace(tmp, path)
        return path


def _cache_dir():
    if os.name == "nt":
        base = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "poe-build-expert")
    else:
        base = os.path.join(os.path.expanduser("~"), ".cache", "poe-build-expert")
    os.makedirs(base, exist_ok=True)
    return base


def sql(query):
    path = os.path.join(_cache_dir(), "notebook-index.sqlite")
    if not os.path.exists(path):
        raise RuntimeError("no index yet: run `notebook.py index`")
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    cur = con.execute(query)
    cols = [d[0] for d in cur.description or []]
    return {"columns": cols, "rows": cur.fetchmany(500)}


def _brief(e):
    """An entry as search shows it: no check list, shorter body."""
    out = {k: v for k, v in e.items() if k not in ("checks", "spec")}
    if len(out.get("body") or "") > 400:
        out["body"] = out["body"][:400] + "..."
    return out


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description="The build lab's notebook")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("search")
    p.add_argument("query", nargs="?")
    p.add_argument("--kind", choices=KINDS)
    p.add_argument("--tag")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--no-local", action="store_true")
    p.add_argument("--offline", action="store_true")
    p = sub.add_parser("show")
    p.add_argument("id")
    p = sub.add_parser("add")
    p.add_argument("--json", help="a file with one entry (object) or several (list)")
    p.add_argument("--kind", choices=KINDS)
    p.add_argument("--title")
    p.add_argument("--body")
    p.add_argument("--tags")
    p.add_argument("--evidence")
    p.add_argument("--verdict", choices=VERDICTS)
    p.add_argument("--numbers", help="JSON object")
    p.add_argument("--spec", help="a concept spec file")
    p.add_argument("--refs")
    p.add_argument("--build", help="the build or character it's about (local kinds)")
    p.add_argument("--no-push", action="store_true")
    p = sub.add_parser("check")
    p.add_argument("id")
    p.add_argument("--result", required=True, choices=RESULTS)
    p.add_argument("--evidence")
    p.add_argument("--no-push", action="store_true")
    sub.add_parser("recheck")
    p = sub.add_parser("import")
    p.add_argument("file")
    sub.add_parser("sync")
    sub.add_parser("index")
    p = sub.add_parser("sql")
    p.add_argument("query")
    args = ap.parse_args()

    if args.cmd == "search":
        nb = Notebook(offline=args.offline, include_local=not args.no_local)
        out = [_brief(e) for e in nb.search(args.query, args.kind, args.tag, args.limit)]
    elif args.cmd == "show":
        out = Notebook().show(args.id)
    elif args.cmd == "add":
        if args.json:
            with open(args.json, encoding="utf-8") as f:
                data = json.load(f)
            entries = data if isinstance(data, list) else [data]
        else:
            if not args.kind:
                raise ValueError("add needs --kind (or --json)")
            e = {"kind": args.kind, "title": args.title, "body": args.body, "evidence": args.evidence,
                 "verdict": args.verdict, "build": args.build,
                 "tags": [t.strip() for t in args.tags.split(",") if t.strip()] if args.tags else None,
                 "refs": [r.strip() for r in args.refs.split(",") if r.strip()] if args.refs else None,
                 "numbers": json.loads(args.numbers) if args.numbers else None}
            if args.spec:
                with open(args.spec, encoding="utf-8") as f:
                    e["spec"] = json.load(f)
            entries = [e]
        out = Notebook().add(entries, push=not args.no_push, source="code")
    elif args.cmd == "check":
        out = Notebook().add([{"kind": "check", "ref": args.id, "result": args.result, "evidence": args.evidence}],
                             push=not args.no_push, source="code")
    elif args.cmd == "recheck":
        out = [_brief(e) for e in Notebook().recheck()]
    elif args.cmd == "import":
        text = sys.stdin.read() if args.file == "-" else open(args.file, encoding="utf-8").read()
        entries = _parse_lines(text)
        if not entries:
            raise ValueError("no JSON lines to import")
        out = Notebook().add(entries, source="chat")
    elif args.cmd == "sync":
        out = Notebook().sync()
    elif args.cmd == "index":
        out = {"path": Notebook().index()}
    else:
        out = sql(args.query)
    print(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, sqlite3.Error, json.JSONDecodeError) as e:
        sys.exit(f"error: {e}")
