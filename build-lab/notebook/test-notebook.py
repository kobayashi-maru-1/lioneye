"""Notebook checks against a throwaway git remote: nothing here touches GitHub or the Lioneye clone.

  python test-notebook.py

Sets up a bare repo as "origin" and two clones (two PCs or sessions), then checks:
  - a public entry lands on origin/main without touching the clone's working tree, index or branch;
  - a second writer whose clone is behind still pushes (fetch, append on the new tip);
  - both entries survive, each once, and re-adding an entry with the same id adds nothing;
  - local kinds (preference, feedback) and checks on them never reach the remote;
  - validation: missing evidence, bad verdict, account names and emails in public entries are refused;
  - weight: a holding check raises it, a contradiction lowers it; an older patch is halved and flagged;
  - offline: a push to an unreachable remote queues the entry; sync pushes it later;
  - import of JSON lines and the SQLite index.
Exit code 1 when any check fails.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import notebook as N  # noqa: E402

RESULTS = []


def add(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def git(cwd, *args):
    r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr}")
    return r.stdout.strip()


def refused(fn):
    try:
        fn()
    except ValueError:
        return True
    return False


def main():
    tmp = tempfile.mkdtemp(prefix="notebook-test-")
    try:
        run(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    sys.exit(1 if failed else 0)


def make_clone(tmp, origin, name):
    path = os.path.join(tmp, name)
    git(tmp, "clone", "--quiet", origin, path)
    git(path, "config", "user.name", "test")
    git(path, "config", "user.email", "test@invalid")
    return path


def run(tmp):
    origin = os.path.join(tmp, "origin.git")
    git(tmp, "init", "--quiet", "--bare", "-b", "main", origin)
    seed = make_clone(tmp, origin, "seed")
    os.makedirs(os.path.join(seed, "build-lab", "notebook"))
    shutil.copy(os.path.join(HERE, "notebook.py"), os.path.join(seed, "build-lab", "notebook", "notebook.py"))
    with open(os.path.join(seed, "build-lab", "notebook", "concepts.jsonl"), "w", newline="\n") as f:
        f.write(json.dumps({"id": "c-old", "kind": "concept", "title": "Old idea", "body": "Tried before.",
                            "verdict": "weak", "patch": "0.1", "date": "2020-01-01"}) + "\n")
    with open(os.path.join(seed, "README.md"), "w") as f:
        f.write("seed\n")
    git(seed, "add", ".")
    git(seed, "commit", "--quiet", "-m", "seed")
    git(seed, "branch", "-M", "main")
    git(seed, "push", "--quiet", "origin", "main")

    a = make_clone(tmp, origin, "a")
    b = make_clone(tmp, origin, "b")
    N._ctx = {"patch": "9.9", "pob": "test", "tree": "9_9"}   # no game database needed
    N._league = lambda: "Test league"
    nb_a = N.Notebook(repo=os.path.join(a, "build-lab", "notebook"), local_dir=os.path.join(tmp, "local-a"))
    nb_b = N.Notebook(repo=os.path.join(b, "build-lab", "notebook"), local_dir=os.path.join(tmp, "local-b"))
    # A dirty working tree must stay as it is.
    with open(os.path.join(a, "README.md"), "a") as f:
        f.write("uncommitted work\n")
    head_a = git(a, "rev-parse", "HEAD")

    r1 = nb_a.add([{"kind": "interaction", "title": "Shaper's Touch with ES stacking", "body": "Gloves add",
                    "evidence": "PoB 2.68: +12% damage", "tags": ["es"]}])
    add("public entry pushed", r1.get("commit") and r1["public"] == 1, json.dumps(r1))
    add("working tree untouched", "uncommitted work" in open(os.path.join(a, "README.md")).read()
        and git(a, "status", "--porcelain") == "M README.md", git(a, "status", "--porcelain"))
    add("branch untouched", git(a, "rev-parse", "HEAD") == head_a)
    git(seed, "fetch", "--quiet", "origin")
    add("origin has it", "Shaper's Touch" in git(seed, "show", f"{r1['commit']}:build-lab/notebook/interactions.jsonl"))

    # b is behind (never fetched since a's push): it still pushes on top.
    r2 = nb_b.add([{"kind": "blind-spot", "title": "Cast when Stunned is always triggered",
                    "body": "PoB takes the stun as constant", "evidence": "gem optimizer picked it: +1300% DPS"}])
    add("behind writer pushes", r2.get("commit"), json.dumps(r2))
    tip = git(b, "rev-parse", "refs/remotes/origin/main")
    add("tip is b's commit", tip == r2["commit"])
    add("both entries on main", git(b, "show", f"{tip}:build-lab/notebook/interactions.jsonl").count("Shaper") == 1
        and "Cast when Stunned" in git(b, "show", f"{tip}:build-lab/notebook/blind-spots.jsonl"))

    again = nb_a.add([{"id": r1["added"][0], "kind": "interaction", "title": "dup", "body": "dup", "evidence": "x"}])
    git(b, "fetch", "--quiet", "origin")
    on_main = git(b, "show", "refs/remotes/origin/main:build-lab/notebook/interactions.jsonl")
    add("same id adds nothing", again.get("commit") is None and '"dup"' not in on_main, json.dumps(again))

    # Local kinds never reach the remote.
    before = git(b, "ls-remote", origin, "refs/heads/main").split()[0]
    r3 = nb_a.add([{"kind": "preference", "title": "Hates totems", "body": "No totem builds"},
                   {"kind": "feedback", "title": "Coven felt slow", "body": "Clear speed poor", "build": "Covenant#1234"}])
    add("local kinds stay local", r3["local"] == 2 and r3["public"] == 0
        and git(b, "ls-remote", origin, "refs/heads/main").split()[0] == before, json.dumps(r3))
    pref = r3["added"][0]
    r4 = nb_a.add([{"kind": "check", "ref": pref, "result": "holds", "evidence": "said again"}])
    add("check on a local entry stays local", r4["local"] == 1 and r4["public"] == 0)

    # Validation.
    add("blind-spot needs evidence", refused(lambda: nb_a.add([{"kind": "blind-spot", "title": "t", "body": "b"}])))
    add("concept needs a verdict", refused(lambda: nb_a.add([{"kind": "concept", "title": "t", "body": "b"}])))
    add("account name refused in public", refused(lambda: nb_a.add(
        [{"kind": "interaction", "title": "seen on Someone#1234", "body": "b", "evidence": "e"}])))
    add("email refused in public", refused(lambda: nb_a.add(
        [{"kind": "concept", "title": "t", "body": "mail me a@b.com", "verdict": "weak"}])))
    add("check needs a known entry", refused(lambda: nb_a.add([{"kind": "check", "ref": "nope", "result": "holds"}])))

    # Weight and re-checks.
    ia = r1["added"][0]
    nb_b.add([{"kind": "check", "ref": ia, "result": "holds", "evidence": "re-ran"}])
    nb_a.add([{"kind": "check", "ref": r2["added"][0], "result": "contradicted", "evidence": "fixed in PoB"}])
    nb_a.git.fetch(force=True)
    s = {e["id"]: e for e in nb_a.scored()}
    add("holding check raises weight", s[ia]["weight"] == 2, s[ia]["weight"])
    add("contradiction lowers weight", s[r2["added"][0]]["weight"] == -1, s[r2["added"][0]]["weight"])
    add("older patch halved and flagged", s["c-old"]["weight"] == 0.5 and s["c-old"].get("recheck"))
    add("recheck lists it", "c-old" in [e["id"] for e in nb_a.recheck()])
    hits = nb_a.search("shaper")
    add("search finds it", hits and hits[0]["id"] == ia)
    add("search ranks by weight", [e["id"] for e in nb_a.search(kind=None)][0] == ia)
    add("local entries searchable", any(e["id"] == pref for e in nb_a.search("totem")))
    add("other PC doesn't see local", not any(e["id"] == pref for e in nb_b.search("totem")))

    # Offline: queue, then sync.
    git(a, "remote", "set-url", "origin", os.path.join(tmp, "missing.git"))
    r5 = nb_a.add([{"kind": "interaction", "title": "Offline find", "body": "b", "evidence": "e"}])
    add("offline queues", r5.get("queued") and not r5.get("commit"), json.dumps(r5))
    add("queued entry readable", any(e["id"] == r5["added"][0] for e in nb_a.search("offline")))
    git(a, "remote", "set-url", "origin", origin)
    r6 = nb_a.sync()
    add("sync pushes the queue", r6.get("pushed") == 1 and r6.get("commit"), json.dumps(r6))
    add("queue emptied", not os.path.exists(os.path.join(tmp, "local-a", "pending.jsonl")))

    # Import from a chat, then the index.
    lines = "\n".join(json.dumps(e) for e in [
        {"kind": "concept", "title": "Chat concept", "body": "from the phone", "verdict": "promising"},
        {"kind": "preference", "title": "Likes minions", "body": "minions are fun"}])
    r7 = nb_b.add(N._parse_lines(lines), source="chat")
    add("import splits public and local", r7["public"] == 1 and r7["local"] == 1 and r7.get("commit"))
    old_cache = N._cache_dir
    N._cache_dir = lambda: tmp
    try:
        path = nb_b.index()
        q = N.sql("SELECT kind, count(*) FROM entries GROUP BY kind ORDER BY kind")
        add("index builds", os.path.exists(path) and dict(q["rows"]).get("concept") == 2, q)
    finally:
        N._cache_dir = old_cache

    # Review fixes: privacy fields, refs, ids, failures that aren't "offline", the sync race, unreadable files.
    add("extra field refused on a public entry", refused(lambda: nb_a.add(
        [{"kind": "interaction", "title": "t", "body": "b", "evidence": "e", "build": "MyChar"}])))
    add("ref to a local entry refused", refused(lambda: nb_a.add(
        [{"kind": "interaction", "title": "t", "body": "b", "evidence": "e", "refs": [pref]}])))
    add("bad id refused", refused(lambda: nb_a.add(
        [{"id": "../x", "kind": "interaction", "title": "t", "body": "b", "evidence": "e"}])))
    add("non-text title refused", refused(lambda: nb_a.add(
        [{"kind": "interaction", "title": 5, "body": "b", "evidence": "e"}])))
    add("check id hides a private title", "totem" not in r4["added"][0] and "hates" not in r4["added"][0], r4)
    before = git(b, "ls-remote", origin, "refs/heads/main").split()[0]
    add("a refused batch writes nothing", refused(lambda: nb_a.add(
        [{"kind": "preference", "title": "Likes bows", "body": "b"},
         {"kind": "blind-spot", "title": "t", "body": "b"}]))
        and not any(e.get("title") == "Likes bows" for e in nb_a.search("bows"))
        and git(b, "ls-remote", origin, "refs/heads/main").split()[0] == before)

    real_push = nb_a.git.append_and_push

    def broken(*a, **k):
        raise RuntimeError("git commit-tree failed: simulated")
    nb_a.git.append_and_push = broken
    r8 = nb_a.add([{"kind": "interaction", "title": "Survives a git failure", "body": "b", "evidence": "e"}])
    nb_a.git.append_and_push = real_push
    add("a git failure queues instead of dropping", r8.get("queued") and r8["added"], json.dumps(r8))

    def push_and_queue_more(changes, message):
        out = real_push(changes, message)
        N._append_local(os.path.join(tmp, "local-a", "pending.jsonl"),
                        [{"id": "i-20261124-arrived-meanwhile-0001", "kind": "interaction", "title": "Meanwhile",
                          "body": "b", "evidence": "e"}])
        return out
    nb_a.git.append_and_push = push_and_queue_more
    r9 = nb_a.sync()
    nb_a.git.append_and_push = real_push
    left = N._read_local(os.path.join(tmp, "local-a", "pending.jsonl"))
    add("sync keeps entries queued during the push", r9.get("pushed") == 1
        and [e["id"] for e in left] == ["i-20261124-arrived-meanwhile-0001"], (r9, left))
    nb_a.sync()

    real_run = nb_a.git.run

    def run_failing_cat(*args, **kw):
        if args and args[0] == "cat-file":   # the file is on main but its blob can't be read
            raise RuntimeError("git cat-file failed: simulated")
        return real_run(*args, **kw)

    def push_with_unreadable_base(changes, message):
        nb_a.git.run = run_failing_cat
        try:
            return real_push(changes, message)
        finally:
            nb_a.git.run = real_run
    nb_a.git.append_and_push = push_with_unreadable_base
    tip_before = git(b, "ls-remote", origin, "refs/heads/main").split()[0]
    r10 = nb_a.add([{"kind": "interaction", "title": "Unreadable base", "body": "b", "evidence": "e"}])
    nb_a.git.append_and_push = real_push
    add("an unreadable file is never overwritten", r10.get("queued")
        and git(b, "ls-remote", origin, "refs/heads/main").split()[0] == tip_before, json.dumps(r10))
    nb_a.sync()
    git(b, "fetch", "--quiet", "origin")
    on_main = git(b, "show", "refs/remotes/origin/main:build-lab/notebook/interactions.jsonl")
    add("nothing lost after the failures", all(t in on_main for t in
        ("Shaper", "Survives a git failure", "Meanwhile", "Unreadable base", "Offline find")))

    # No clone: reading works from files, writing a public entry is refused with a hand-back message.
    nb_none = N.Notebook(repo=None, local_dir=os.path.join(tmp, "local-c"), offline=True)
    try:
        nb_none.add([{"kind": "interaction", "title": "t", "body": "b", "evidence": "e"}])
        add("no clone refuses public writes", False)
    except RuntimeError as e:
        add("no clone refuses public writes", "import" in str(e))


if __name__ == "__main__":
    main()
