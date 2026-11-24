"""Fast build evaluation on headless Path of Building: one Evaluator per PoB, or an EvalPool of worker processes.

    from evaluator import EvalPool
    with EvalPool(workers=8) as pool:                  # workers=0: everything in this process
        base = pool.load(xml, main_skill="Ethereal Knives")
        results = pool.probe([{"allocate": [12345]}, {"item": {"slot": "Amulet", "text": item_text}}])
        pool.apply([{"op": "gem", "group": "main", "index": 3, "name": "Spell Echo", "quality": 20}])

Two kinds of call:
- probe(specs): PoB's misc calculator, no state change, ~5-20 ms per spec (more on big minion builds).
  A spec is an object with any of:
    allocate: [node ids]   each with its path from the tree (several allocates union their shortest paths)
    masteries: {id: effectId}  required for every mastery being allocated (directly or on a path); each
                           effect only once on the tree, as in PoB
    deallocate: [node ids] each with the nodes that depend on it
    addNodes / removeNodes: [node ids]  exact node sets
    item: {slot, text}     one item swap (a switched-off flask slot is refused: use apply)
    conditions: [names]    PoB calculator conditions (a list of condition names)
  Result per spec: {player: {...}, minion: {...}?, points} or {error} for that spec alone.
- apply(ops, allow_main_change=False): edits the build in memory like PoB's UI, then recalculates
  (~150-250 ms). All-or-nothing: on a bad op, a calc error, or a different main skill afterwards (unless
  allowed) the build is restored and ValueError raised. Ops:
    allocate {nodes, masteries?}, deallocate {nodes}, equip {slot, text, active?}, unequip {slot},
    gem {group, index?, name, level?, quality?, enabled?} (replace, or append without index),
    gem-remove {group, index}, gem-enable {group, index, enabled}, config {var, value}.
  group is "main" or a 1-based index (see groups()). In a pool every worker applies the same ops.
- support_trials(trials): trials are {index, name, level?, quality?, enabled?}; each puts that support in slot
  `index` of the main group (a support's slot, or one past the end), one recalc each, then restores the group.
  Result per trial: {player, minion?} or {error} (bad gem, not a support slot, calc error, main skill changed).

Workers are separate processes (lupa runtimes aren't thread-safe), ~470 MB and ~3-5 s start-up each. If a
worker dies, a connection breaks, workers stop agreeing, or a failed apply can't restore the build (BuildLost),
the pool closes itself and later calls raise PoolBroken.
"""
import importlib.util
import json
import multiprocessing as mp
import os
from multiprocessing.connection import wait

HERE = os.path.dirname(os.path.abspath(__file__))
POB_LIB = os.path.join(HERE, "..", "pob", "pob-headless.py")
OPS_LUA = os.path.join(HERE, "eval-ops.lua")

_ph = None

EXTRA_KEYS = ("ReqStr", "ReqDex", "ReqInt", "ReqOmni", "Omni", "ChaosResist", "LifeUnreserved", "ManaUnreserved",
              "FireTakenHitMult", "ColdTakenHitMult", "LightningTakenHitMult", "ChaosTakenHitMult",
              "FireEnemyDamage", "ColdEnemyDamage", "LightningEnemyDamage", "ChaosEnemyDamage",
              "FireTakenDamage", "ColdTakenDamage", "LightningTakenDamage", "ChaosTakenDamage",
              "ManaCost", "LifeCost", "ESCost", "RageCost")


def ph():
    """The pob-headless module (file name has a hyphen, so it's loaded by path)."""
    global _ph
    if _ph is None:
        spec = importlib.util.spec_from_file_location("pob_headless", POB_LIB)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _ph = mod
    return _ph


def default_workers():
    return max(1, min(12, (os.cpu_count() or 2) - 2))


def main_metric(stats):
    """FullDPS when the build counts any group in Full DPS, else the player's CombinedDPS, else (a minion main
    skill) the minion's CombinedDPS."""
    p, m = stats.get("player") or {}, stats.get("minion") or {}
    if (p.get("FullDPS") or 0) > 0:
        return "FullDPS"
    if (p.get("CombinedDPS") or 0) > 0 or not (m.get("CombinedDPS") or 0) > 0:
        return "CombinedDPS"
    return "minion.CombinedDPS"


def _norm(res):
    """dkjson writes an empty Lua table as []: make the player/minion blocks dicts again."""
    if isinstance(res, dict):
        for k in ("player", "minion"):
            if isinstance(res.get(k), list):
                res[k] = {}
    return res


class BuildLost(RuntimeError):
    """A failed apply couldn't restore the build; load a build again before using this Evaluator."""


def _need_list(v, what):
    if not isinstance(v, list):
        raise ValueError(f"{what} must be a list")
    return v


def value(result, key):
    """A stat from a result: "FullDPS" (player) or "minion.TotalDPS"."""
    if key.startswith("minion."):
        return (result.get("minion") or {}).get(key[7:])
    return (result.get("player") or {}).get(key)


class Evaluator:
    """One headless PoB with the evaluation ops loaded. Start-up ~3 s; load builds into it repeatedly."""

    def __init__(self, pob_dir=None):
        self.ph = ph()
        self.pob = self.ph.Pob(pob_dir)
        with open(OPS_LUA, "rb") as f:
            self.pob.L.execute(f.read())
        # pob-headless's headline stats, plus what the optimizers' rules read (attribute requirements).
        self.keys = list(self.ph.PLAYER_KEYS) + [k for k in EXTRA_KEYS if k not in self.ph.PLAYER_KEYS]
        self.minion_keys = list(self.ph.MINION_KEYS)

    def _call(self, fn, *args):
        try:
            out = getattr(self.pob.g, fn)(*[json.dumps(a, allow_nan=False).encode() for a in args])
        except self.ph._lj.LuaError as e:
            raise ValueError(str(e)) from None
        return json.loads(out)

    def load(self, xml, main_skill=None, main_group=None, loadout=None, config=None, include_in_full_dps=False):
        if main_group is not None and not main_skill:
            raise ValueError("main_group needs main_skill")
        if loadout:
            xml = self.ph.select_loadout(xml, loadout, config)
        elif config:
            xml = self.ph.select_config(xml, config)
        self.pob.g.ev_reset()  # also clears an error message left by an earlier call
        self.pob.load_xml(xml)
        if main_skill:
            self.pob.set_main_skill(main_skill, group=main_group, include_in_full_dps=include_in_full_dps)
            err = self.pob._prompt_error()  # a calc error while switching the main skill
            if err:
                raise RuntimeError(f"PoB's calculation failed after choosing {main_skill}: {err}")
        self.pob.g.ev_calc = None
        return {"pobVersion": self.pob.version, "mainSkill": self.pob.main_skill(),
                "issues": list(self.pob.issues), "stats": self.stats()}

    def stats(self):
        res = _norm(self._call("ev_stats", self.keys, self.minion_keys))
        res["warnings"] = self.pob.warnings()
        return res

    def probe(self, specs):
        return [_norm(r) for r in self._call("ev_probe", _need_list(specs, "probe specs"), self.keys, self.minion_keys)]

    def apply(self, ops, allow_main_change=False):
        res = self._call("ev_apply", _need_list(ops, "ops"), bool(allow_main_change))
        if res.get("lost"):
            raise BuildLost(f"{res['error']} ({res['lost']}); load the build again")
        if "error" in res:
            raise ValueError(res["error"])
        return self.stats()

    def support_trials(self, trials):
        return [_norm(r) for r in self._call("ev_support_trials", _need_list(trials, "trials"),
                                             self.keys, self.minion_keys)]

    def compatible_supports(self):
        return self._call("ev_compatible_supports")

    def groups(self):
        return self._call("ev_groups")

    def reachable_nodes(self, max_dist=None, ascendancy=False):
        return self._call("ev_reachable_nodes", max_dist, bool(ascendancy))

    def allocated_nodes(self):
        return self._call("ev_allocated_nodes")

    def points(self):
        return self._call("ev_points")

    def slots(self):
        return self._call("ev_slots")

    def affix_pool(self, base, ilvl=84, tier=2, roll=0.5, domain="Explicit", bench=False):
        return self._call("ev_affix_pool", {"base": base, "ilvl": ilvl, "tier": tier, "roll": roll,
                                            "domain": domain, "bench": bool(bench)})

    def compatible_supports_info(self):
        return self._call("ev_compatible_supports_info")

    def reachable_masteries(self, max_dist=None):
        return self._call("ev_reachable_masteries", max_dist)

    def node_path(self, node_id):
        return self._call("ev_node_path", node_id)

    def node_depends(self, node_id):
        return self._call("ev_node_depends", node_id)

    def node_anchors(self, node_id):
        return self._call("ev_node_anchors", node_id)

    def gem_info(self, name):
        return self._call("ev_gem_info", name)

    def unique_text(self, name, base=None):
        """PoB's item text for a unique (its current variant), for an equip op: {name, base, text, variants}."""
        res = self._call("ev_unique_text", {"name": name, **({"base": base} if base else {})})
        if "error" in res:
            raise ValueError(res["error"])
        return res

    def save_xml(self):
        return self.pob.save_xml()

    def main_skill(self):
        return self.pob.main_skill()


# ---------------- pool ----------------

def _worker(conn, pob_dir):
    try:
        ev = Evaluator(pob_dir)
    except Exception as e:  # noqa: BLE001 - report to the parent
        conn.send(("error", ("RuntimeError", f"{type(e).__name__}: {e}")))
        return
    conn.send(("ready", ev.pob.version))
    while True:
        try:
            cmd, args, kwargs = conn.recv()
        except (EOFError, OSError):
            return
        if cmd == "quit":
            return
        try:
            conn.send(("ok", getattr(ev, cmd)(*args, **kwargs)))
        except Exception as e:  # noqa: BLE001 - one failed call shouldn't kill the worker
            kind = "BuildLost" if isinstance(e, BuildLost) else "ValueError" if isinstance(e, ValueError) else "RuntimeError"
            conn.send(("error", (kind, str(e))))


class PoolBroken(RuntimeError):
    """A worker died or a connection broke; the pool closed itself."""


# Stats every worker must agree on after a load or change (same build state everywhere).
_SYNC_KEYS = ("FullDPS", "CombinedDPS", "Life", "EnergyShield", "TotalEHP")


class EvalPool:
    """N worker processes, each with its own PoB holding the same build. workers=0 runs one Evaluator in this
    process (for small jobs, or where processes are a problem). Errors: ValueError for a bad request (the build
    is unchanged), PoolBroken when a worker dies or a connection breaks (the pool closes itself)."""

    def __init__(self, workers=None, pob_dir=None, start_timeout=300):
        self.workers = default_workers() if workers is None else workers
        self.local = None
        self.conns, self.procs = [], []
        self.broken = None
        if self.workers == 0:
            self.local = Evaluator(pob_dir)
            self.version = self.local.pob.version
            return
        ctx = mp.get_context("spawn")
        try:
            for _ in range(self.workers):
                parent, child = ctx.Pipe()
                p = ctx.Process(target=_worker, args=(child, pob_dir), daemon=True)
                p.start()
                child.close()
                self.conns.append(parent)
                self.procs.append(p)
            versions = set()
            for c in self.conns:
                if not c.poll(start_timeout):
                    raise RuntimeError("a PoB worker didn't start in time")
                kind, val = c.recv()
                if kind != "ready":
                    raise RuntimeError(f"a PoB worker failed to start: {val[1] if isinstance(val, tuple) else val}")
                versions.add(val)
            if len(versions) != 1:
                raise RuntimeError(f"workers run different PoB versions: {versions}")
        except BaseException as e:
            self.close()
            if isinstance(e, (EOFError, OSError)):
                raise RuntimeError(f"a PoB worker died while starting ({type(e).__name__})") from None
            raise
        self.version = versions.pop()

    # -- plumbing --
    def _alive(self):
        if self.broken:
            raise PoolBroken(f"the pool is closed: {self.broken}")

    def _break(self, why):
        """A transport failure: workers may be mid-call, so the pool can't be trusted any more."""
        self.broken = why
        self.close(force=True)
        return PoolBroken(f"the pool closed itself: {why}")

    def _send(self, conn, cmd, *args, **kwargs):
        conn.send((cmd, args, kwargs))

    @staticmethod
    def _reply(val):
        kind, payload = val
        if kind == "error":
            etype, msg = payload if isinstance(payload, tuple) else ("RuntimeError", payload)
            return {"ValueError": ValueError, "BuildLost": BuildLost}.get(etype, RuntimeError)(msg)
        return payload

    def _broadcast(self, cmd, *args, **kwargs):
        if self.local:
            return [getattr(self.local, cmd)(*args, **kwargs)]
        self._alive()
        try:
            for c in self.conns:
                self._send(c, cmd, *args, **kwargs)
            replies = [self._reply(c.recv()) for c in self.conns]
        except BaseException as e:
            raise self._break(f"{type(e).__name__} during {cmd}") from None
        errors = [r for r in replies if isinstance(r, Exception)]
        if errors:
            # Every worker holds the same build, so a bad request fails on all of them the same way. Anything
            # else (some succeeded, different errors, a lost build) means they no longer agree.
            if any(isinstance(e, BuildLost) for e in errors) or len(errors) != len(replies) \
                    or len({str(e) for e in errors}) > 1:
                raise self._break(f"workers diverged during {cmd}: {errors[0]}")
            raise errors[0]
        return replies

    def _one(self, cmd, *args, **kwargs):
        if self.local:
            return getattr(self.local, cmd)(*args, **kwargs)
        self._alive()
        try:
            self._send(self.conns[0], cmd, *args, **kwargs)
            r = self._reply(self.conns[0].recv())
        except BaseException as e:
            raise self._break(f"{type(e).__name__} during {cmd}") from None
        if isinstance(r, Exception):
            raise r
        return r

    def _map(self, cmd, items, chunk):
        """Run cmd over items in chunks, each chunk to whichever worker is free; results in input order."""
        if self.local:
            return getattr(self.local, cmd)(items)
        self._alive()
        if not items:
            return []
        chunks = [items[i:i + chunk] for i in range(0, len(items), chunk)]
        results = [None] * len(chunks)
        busy = {}  # conn -> chunk index
        next_chunk = 0
        free = list(self.conns)
        error = None
        try:
            while next_chunk < len(chunks) or busy:
                while free and next_chunk < len(chunks) and error is None:
                    c = free.pop()
                    self._send(c, cmd, chunks[next_chunk])
                    busy[c] = next_chunk
                    next_chunk += 1
                if not busy:
                    break
                for c in wait(list(busy)):
                    i = busy.pop(c)
                    r = self._reply(c.recv())
                    if isinstance(r, Exception):
                        error = error or r
                    else:
                        results[i] = r
                    free.append(c)
        except BaseException as e:
            raise self._break(f"{type(e).__name__} during {cmd}") from None
        if error:
            raise error
        return [r for part in results for r in part]

    def _check_sync(self, stats_list):
        first = stats_list[0].get("player") or {}
        for s in stats_list[1:]:
            p = s.get("player") or {}
            for k in _SYNC_KEYS:
                a, b = first.get(k), p.get(k)
                if a != b and not (isinstance(a, (int, float)) and isinstance(b, (int, float))
                                   and abs(a - b) <= 1e-9 * max(1.0, abs(a))):
                    raise self._break(f"workers disagree on {k}: {a} vs {b}")

    # -- API --
    def load(self, xml, main_skill=None, main_group=None, loadout=None, config=None, include_in_full_dps=False):
        res = self._broadcast("load", xml, main_skill, main_group, loadout, config, include_in_full_dps)
        self._check_sync([r["stats"] for r in res])
        return res[0]

    def apply(self, ops, allow_main_change=False):
        res = self._broadcast("apply", _need_list(ops, "ops"), allow_main_change)
        self._check_sync(res)
        return res[0]

    def probe(self, specs, chunk=None):
        _need_list(specs, "probe specs")
        chunk = chunk or max(1, min(64, len(specs) // (max(1, self.workers) * 4) or 1))
        return self._map("probe", specs, chunk)

    def support_trials(self, trials, chunk=None):
        _need_list(trials, "trials")
        chunk = chunk or max(1, min(8, len(trials) // (max(1, self.workers) * 3) or 1))
        return self._map("support_trials", trials, chunk)

    def stats(self):
        return self._one("stats")

    def groups(self):
        return self._one("groups")

    def compatible_supports(self):
        return self._one("compatible_supports")

    def reachable_nodes(self, max_dist=None, ascendancy=False):
        return self._one("reachable_nodes", max_dist, ascendancy)

    def reachable_masteries(self, max_dist=None):
        return self._one("reachable_masteries", max_dist)

    def points(self):
        return self._one("points")

    def slots(self):
        return self._one("slots")

    def affix_pool(self, base, ilvl=84, tier=2, roll=0.5, domain="Explicit", bench=False):
        return self._one("affix_pool", base, ilvl, tier, roll, domain, bench)

    def compatible_supports_info(self):
        return self._one("compatible_supports_info")

    def allocated_nodes(self):
        return self._one("allocated_nodes")

    def node_path(self, node_id):
        return self._one("node_path", node_id)

    def node_depends(self, node_id):
        return self._one("node_depends", node_id)

    def node_anchors(self, node_id):
        return self._one("node_anchors", node_id)

    def gem_info(self, name):
        return self._one("gem_info", name)

    def unique_text(self, name, base=None):
        return self._one("unique_text", name, base)

    def main_skill(self):
        return self._one("main_skill")

    def save_xml(self):
        return self._one("save_xml")

    def close(self, force=False):
        if self.workers and not self.broken:
            self.broken = "closed"
        for c in self.conns:
            if not force:
                try:
                    c.send(("quit", (), {}))
                except (OSError, EOFError, ValueError):
                    pass
            try:
                c.close()
            except OSError:
                pass
        for p in self.procs:
            if force:
                p.terminate()
            p.join(timeout=5)
            if p.is_alive():
                p.terminate()
        self.conns, self.procs = [], []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
