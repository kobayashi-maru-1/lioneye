"""Write (or check) build-lab/manifest.txt: the engine files a chat sandbox downloads from
raw.githubusercontent.com (the poe-build-expert skill's scripts/build-lab-fetch.py reads it).

  python make-manifest.py            rewrite it from the files git tracks
  python make-manifest.py --check    exit 1 when it's out of date (run before committing build-lab changes)

Only files git tracks are listed (stage new files first): an untracked file would 404 on GitHub.
Left out: benchmarks, tests, the notebook's data and MCP server (the notebook reads its data itself), the CI-only
wiki snapshot and docs.
"""
import fnmatch
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "manifest.txt")
INCLUDE = ("*.py", "*.lua", "*.sql", "db/mechanic-rules.json", "db/requirements-ci.txt")
EXCLUDE = ("bench/*", "*test-*", "notebook-mcp/*", "make-manifest.py")


def wanted():
    out = subprocess.run(["git", "-C", HERE, "ls-files", "--cached", "."],
                         capture_output=True, text=True, check=True).stdout.split()
    files = []
    for f in out:
        rel = f.replace("\\", "/")
        if any(fnmatch.fnmatch(rel, p) for p in EXCLUDE):
            continue
        if any(fnmatch.fnmatch(rel, p) for p in INCLUDE) and os.path.isfile(os.path.join(HERE, rel)):
            files.append(rel)
    return sorted(files)


def text():
    return "# build-lab files for scripts/build-lab-fetch.py (written by make-manifest.py)\n" + \
        "".join(f + "\n" for f in wanted())


def main():
    new = text()
    if "--check" in sys.argv:
        old = open(MANIFEST, encoding="utf-8").read() if os.path.exists(MANIFEST) else ""
        if old != new:
            sys.exit("manifest.txt is out of date: run make-manifest.py")
        print("manifest.txt is current")
        return
    with open(MANIFEST, "w", encoding="utf-8", newline="\n") as f:
        f.write(new)
    print(f"{len(new.splitlines()) - 1} files")


if __name__ == "__main__":
    main()
