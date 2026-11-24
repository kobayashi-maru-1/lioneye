"""HTTP for the market tools: a small on-disk cache with conditional requests (poe.ninja), and a GGG client that
honours GGG's rate-limit headers (trade site, ladder, character window).

Cache: %LOCALAPPDATA%\\poe-build-expert\\market (or ~/.cache/poe-build-expert/market), shared with the skill's
cache folder. User-Agent: "lioneye-build-lab/0.1", no contact (Andy's choice).
"""
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.request

UA = "lioneye-build-lab/0.1"


def cache_root():
    base = (os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "poe-build-expert") if os.name == "nt"
            else os.path.join(os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "poe-build-expert"))
    d = os.path.join(base, "market")
    os.makedirs(d, exist_ok=True)
    return d


def _safe(name):
    return "".join(c if c.isalnum() or c in "-_." else "-" for c in name)


def _write_atomic(path, data):
    tmp = f"{path}.{os.getpid()}.part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def cached_json(url, key, max_age, folder=None, timeout=60):
    """GET url as JSON, cached under `key` for max_age seconds. Past that, a conditional request (ETag) refreshes
    it; offline, the stale copy is used. Returns (data, age_seconds)."""
    folder = folder or cache_root()
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, _safe(key) + ".json")
    cached = None
    try:
        with open(path, encoding="utf-8") as f:
            cached = json.load(f)
    except (OSError, ValueError):
        cached = None
    if cached and time.time() - cached.get("fetched", 0) < max_age:
        return cached["data"], time.time() - cached["fetched"]
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if cached and cached.get("etag"):
        headers["If-None-Match"] = cached["etag"]
    def save(entry):
        try:
            _write_atomic(path, entry)
        except OSError:
            pass  # another process holds the file (Windows); the data is still good for this run

    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as r:
            data = json.load(r)
            etag = r.headers.get("ETag")
        save({"url": url, "fetched": time.time(), "etag": etag, "data": data})
        return data, 0.0
    except urllib.error.HTTPError as e:
        if e.code == 304 and cached:
            cached["fetched"] = time.time()
            save(cached)
            return cached["data"], 0.0
        if cached:
            print(f"warning: {url} answered HTTP {e.code}; using a copy {int(time.time() - cached['fetched'])} s old",
                  file=sys.stderr)
            return cached["data"], time.time() - cached["fetched"]
        raise RuntimeError(f"HTTP {e.code} from {url}") from None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError, http.client.HTTPException) as e:
        if cached:
            print(f"warning: can't reach {url} ({getattr(e, 'reason', e)}); using a copy "
                  f"{int(time.time() - cached['fetched'])} s old", file=sys.stderr)
            return cached["data"], time.time() - cached["fetched"]
        raise RuntimeError(f"can't reach {url} ({getattr(e, 'reason', e)})") from None


MARGIN = 2        # stop this many calls short of any rule (the IP may be shared with a browser or another run)
MAX_SLEEP = 330   # wait out windows up to ~5 minutes; for longer ones stop with an error instead of risking a ban


class RateLimited(RuntimeError):
    """GGG's limits need a longer pause than this run will sleep."""


def needed_wait(headers, margin=MARGIN):
    """Seconds to wait before the next call, from GGG's rate-limit headers: every rule of every policy the
    endpoint lists in X-Rate-Limit-Rules (rule "max:period:penalty", state "hits:period:restricted"). A rule in
    its restricted state waits that long; a rule within `margin` of its max waits its whole period."""
    names = [n.strip() for n in (headers.get("X-Rate-Limit-Rules") or "Ip,Account").split(",") if n.strip()]
    wait = 0
    for name in names:
        rules, state = headers.get(f"X-Rate-Limit-{name}"), headers.get(f"X-Rate-Limit-{name}-State")
        if not rules or not state:
            continue
        for rule, st in zip(rules.split(","), state.split(",")):
            try:
                mx, period, _ = (int(x) for x in rule.split(":"))
                hits, _, restricted = (int(x) for x in st.split(":"))
            except ValueError:
                continue
            if restricted > 0:
                wait = max(wait, restricted + 1)
            elif hits >= mx - margin:
                wait = max(wait, period + 1)
    return wait


class GGG:
    """pathofexile.com JSON calls, paced by GGG's X-Rate-Limit-* headers (see needed_wait), waiting out 429s.
    A pause longer than MAX_SLEEP raises RateLimited instead of sleeping (or risking a 30-60 minute ban)."""

    def __init__(self, verbose=True):
        self.verbose = verbose

    def _say(self, msg):
        if self.verbose:
            print(msg, file=sys.stderr)

    def _pause(self, wait, why):
        if wait > MAX_SLEEP:
            raise RateLimited(f"GGG's rate limit needs a {wait // 60 + 1} minute pause ({why}); try again later")
        self._say(f"GGG rate limit near ({why}), waiting {wait}s")
        time.sleep(wait)

    def _throttle(self, headers):
        wait = needed_wait(headers)
        if wait:
            self._pause(wait, headers.get("X-Rate-Limit-Policy") or "limit")

    def call(self, url, body=None, tries=5):
        """JSON from GGG; returns None for 403/404 (private or missing), raises RuntimeError otherwise."""
        headers = {"User-Agent": UA}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        for _ in range(tries):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, data, headers), timeout=30) as r:
                    out = json.load(r)
                    self._throttle(r.headers)
                    return out
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait = max(int(e.headers.get("Retry-After", "60")) + 2, needed_wait(e.headers))
                    self._pause(wait, "429 Too Many Requests")
                    continue
                if e.code in (403, 404):
                    return None
                raise RuntimeError(f"HTTP {e.code} from GGG ({url.split('?')[0]})") from None
            except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as e:
                raise RuntimeError(f"can't reach pathofexile.com ({getattr(e, 'reason', e)})") from None
            except ValueError:
                raise RuntimeError("GGG answered with a non-JSON page (maintenance or a bot check)") from None
        raise RuntimeError("GGG kept rate-limiting; try again in a few minutes")
