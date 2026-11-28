"""Passive tree optimizer.

improve(): keep the point budget and make the tree better under the rules:
  1. Over budget: refund the node whose removal costs least per point.
  2. Spare points: add the best path (node or mastery+effect) per point, until no spare or nothing helps.
  3. Swap: probe every pair (removable node r, addition a) among the best few of each, where a fits in the
     points r frees, plus bundles: several refunds, least loss first, paying for one addition no single refund
     covers (a far notable or keystone). Apply the best swap that beats the current tree. Repeat until none
     helps.
  Every applied change is checked with a real recalc; a change that turns out worse is undone.

build(): start from the class start (tree-reset), spend ascendancy points greedily, grow the main tree greedily
by gain per point (paths up to max_dist, so far notables count), then improve().

Probes come from PoB's calculator (see evaluator.py); paths are PoB's own (node.path).
"""


def _rules_worse(rules, after, base):
    """True when `after` is worse than `base` on the rules alone (the metric aside)."""
    for x, y in zip(rules.score(base), rules.score(after)):
        if y > x + 1e-7:
            return True
        if y < x - 1e-7:
            return False
    return False


def _mastery_options(pool, max_dist, limit=None):
    out = []
    for m in pool.reachable_masteries(max_dist):
        for eff in m["effects"][:limit]:
            out.append({"key": f"m{m['id']}:{eff}", "label": f"{m['name']} (effect {eff})", "id": m["id"],
                        "masteries": {str(m["id"]): eff}, "points": m["dist"]})
    return out


def _additions(pool, max_dist, include_masteries=True):
    adds = [{"key": f"n{n['id']}", "label": n["name"], "id": n["id"], "masteries": None, "points": n["dist"]}
            for n in pool.reachable_nodes(max_dist)]
    if include_masteries:
        adds += _mastery_options(pool, max_dist)
    return adds


def _spec(add):
    s = {"allocate": [add["id"]]}
    if add["masteries"]:
        s["masteries"] = add["masteries"]
    return s


def _op(add):
    op = {"op": "allocate", "nodes": [add["id"]]}
    if add["masteries"]:
        op["masteries"] = add["masteries"]
    return op


def _rank(pool, rules, base, cands, spec_of, cost_of):
    """Probe each candidate; return [(rate, cand, result)] best first (errors dropped)."""
    if not cands:
        return []
    results = pool.probe([spec_of(c) for c in cands])
    rows = [(rules.rate(base, r, cost_of(c, r)), c, r) for c, r in zip(cands, results) if "error" not in r]
    rows.sort(key=lambda t: t[0], reverse=True)
    return rows


def _apply_checked(pool, rules, ops, base, budget, main_skill, protect=()):
    """Apply ops; keep them only if the result beats base, stays within budget and keeps every protected node
    (several refunds in one change can take a node no single probe showed: a loop in the tree). Returns
    (kept, stats)."""
    snapshot = pool.save_xml()
    try:
        after = pool.apply(ops)
    except ValueError:
        return False, base
    kept_all = not protect or set(protect) <= {n["id"] for n in pool.allocated_nodes()}
    if (budget is None or pool.points()["used"] <= budget) and kept_all and rules.better(after, base):
        return True, after
    pool.load(snapshot, main_skill)
    return False, base


def _removals(pool, rules, base, max_frees, keep_keystones=True, protect=()):
    """Refundable nodes. Keystones stay by default: several (Ghost Reaver, Zealot's Oath, ...) give recovery
    PoB's EHP doesn't count, so the numbers alone would refund them. `protect`: node ids never refunded, neither
    themselves nor as a node that depends on a refunded one."""
    rems = [n for n in pool.allocated_nodes() if n["frees"] <= max_frees and n["type"] != "ClassStart"
            and not (keep_keystones and n["type"] == "Keystone") and n["id"] not in protect]
    if protect:
        rems = [n for n in rems if not (set(pool.node_depends(n["id"])) & set(protect))]
    rows = _rank(pool, rules, base, rems, lambda n: {"deallocate": [n["id"]]}, lambda n, r: n["frees"])
    return rows


BUNDLE_ADDS = 12   # additions tried with several refunds at once


class _Bundle(dict):
    """Several refunds that together pay for one addition; shaped like a removal for the swap loop."""


def _bundles(adds, rems, anchors, deps, spare, tabu):
    """Swaps where one addition costs more than any single refund frees (a far notable or keystone): refund the
    cheapest nodes, least loss per point first, until the addition fits. Refunds may not overlap, and may not
    take every node the addition's path attaches to. Returns (bundle, addition, probe spec) like the pair swaps."""
    out = []
    single = max((r["frees"] for _, r, _ in rems), default=0)
    for _, a, _ in adds[:BUNDLE_ADDS]:
        need = a["points"] - spare
        if need <= single:
            continue   # a single refund can pay for it: the pair swaps cover it
        chosen, taken, freed = [], set(), 0
        for _, r, _ in rems:
            d = deps[r["id"]] | {r["id"]}
            if d & taken or (anchors[a["key"]] and anchors[a["key"]] <= taken | d):
                continue
            chosen.append(r)
            taken |= d
            freed += r["frees"]
            if freed >= need:
                break
        if freed < need:
            continue
        ids = [r["id"] for r in chosen]
        key = (tuple(sorted(ids)), a["key"])
        if key in tabu:
            continue
        b = _Bundle(id=key[0], name=" + ".join(r["name"] for r in chosen), frees=freed, ids=ids)
        spec = _spec(a)
        spec["deallocate"] = ids
        out.append((b, a, spec))
    return out


def _fill(pool, rules, budget, max_dist, main_skill, log, stage):
    """Spend spare points on the best additions, one at a time."""
    tabu = set()
    while True:
        pts = pool.points()["used"]
        spare = budget - pts
        if spare <= 0:
            return
        base = pool.stats()
        adds = [a for a in _additions(pool, min(max_dist, spare)) if a["points"] <= spare and a["key"] not in tabu]
        rows = _rank(pool, rules, base, adds, _spec, lambda a, r: a["points"])
        rows = [row for row in rows if rules.improves(row[0])]
        if not rows:
            return
        rate, add, _ = rows[0]
        kept, after = _apply_checked(pool, rules, [_op(add)], base, budget, main_skill)
        if kept:
            log.append({"step": stage, "change": f"+ {add['label']} ({add['points']} pts)", "value": rules.value(after)})
        else:
            tabu.add(add["key"])


def _trim(pool, rules, budget, main_skill, log, stage, keep_keystones=True, protect=()):
    """Over budget: refund the cheapest nodes until within it."""
    while pool.points()["used"] > budget:
        base = pool.stats()
        rows = _removals(pool, rules, base, max_frees=pool.points()["used"] - budget + 3,
                         keep_keystones=keep_keystones, protect=protect)
        if not rows:
            raise RuntimeError("over the point budget and no node can be refunded")
        rate, node, _ = rows[0]
        pool.apply([{"op": "deallocate", "nodes": [node["id"]]}])
        log.append({"step": stage, "change": f"- {node['name']} (refund, {node['frees']} pts)",
                    "value": rules.value(pool.stats())})


def improve(pool, rules, budget=None, max_dist=6, k_add=40, k_remove=30, max_frees=6, max_iters=40,
            main_skill=None, log=None, stage="tree", keep_keystones=True, protect=()):
    """Trim to `budget`, fill spare points, then swap refunds for additions while the tree gets better.
    protect: node ids never refunded (a learned start's keystones)."""
    log = log if log is not None else []
    budget = budget if budget is not None else pool.points()["used"]
    _trim(pool, rules, budget, main_skill, log, stage, keep_keystones, protect)
    _fill(pool, rules, budget, max_dist, main_skill, log, stage)
    tabu = set()
    for _ in range(max_iters):
        base = pool.stats()
        spare = budget - pool.points()["used"]
        adds = _rank(pool, rules, base, _additions(pool, max_dist), _spec, lambda a, r: a["points"])[:k_add]
        rems = _removals(pool, rules, base, max_frees, keep_keystones, protect)[:k_remove]
        if not adds or not rems:
            break
        # A path attaches to the tree at its anchors; if removing r takes all of them, the probe would count a
        # floating path, so such pairs are skipped (the real change would need a different path).
        anchors = {a["key"]: set(pool.node_anchors(a["id"])) for _, a, _ in adds}
        deps = {r["id"]: set(pool.node_depends(r["id"])) for _, r, _ in rems}
        pairs = []
        for _, r, _ in rems:
            for _, a, _ in adds:
                if a["points"] > r["frees"] + spare or (r["id"], a["key"]) in tabu:
                    continue
                if anchors[a["key"]] and anchors[a["key"]] <= deps[r["id"]]:
                    continue
                spec = _spec(a)
                spec["deallocate"] = [r["id"]]
                pairs.append((r, a, spec))
        pairs += _bundles(adds, rems, anchors, deps, spare, tabu)
        if not pairs:
            break
        results = pool.probe([p[2] for p in pairs])
        good = [(r, p) for p, r in zip(pairs, results) if "error" not in r and rules.better(r, base)]
        # best first: lower (hard, soft) score, then higher utility (the metric without weighted floors)
        ranked = sorted(good, key=lambda t: (tuple(-x for x in rules.score(t[0])), rules.rank_value(t[0])), reverse=True)
        if not ranked:
            break
        moved = False
        for res, (r, a, _) in ranked[:8]:  # the probe can differ from a real change when paths shift: verify
            kept, after = _apply_checked(pool, rules, [{"op": "deallocate", "nodes": r.get("ids") or [r["id"]]}, _op(a)],
                                         base, budget, main_skill, protect)
            if kept:
                log.append({"step": stage, "change": f"swap - {r['name']} ({r['frees']} pts) + {a['label']} "
                                                     f"({a['points']} pts)", "value": rules.value(after)})
                moved = True
                break
            tabu.add((r["id"], a["key"]))
        if not moved:
            break
        _fill(pool, rules, budget, max_dist, main_skill, log, stage)
    return log


def seed(pool, start, points, asc_points, log=None):
    """Allocate a learned start's nodes (design/learn.py) with the learned mastery effects, while the point
    budgets allow. First, round by round, the learned nodes next to the tree (most common first): the references'
    own routes, so a far notable doesn't pull in PoB's shortest path beside the travel nodes they take. Then the
    rest, most common first, each with its path. A node that doesn't fit, can't be reached or wants a mastery
    effect already taken is skipped. Returns the ids taken."""
    log = log if log is not None else []
    masteries = {str(k): v for k, v in (start.get("masteries") or {}).items()}
    nodes = start.get("nodes") or []
    taken, bad = [], set()

    def op_for(ids):
        op = {"op": "allocate", "nodes": list(ids)}
        mast = {str(i): masteries[str(i)] for i in ids if str(i) in masteries}
        if mast:
            op["masteries"] = mast
        return op

    def near():
        return ({x["id"] for x in pool.reachable_nodes(1)} | {x["id"] for x in pool.reachable_nodes(1, ascendancy=True)}
                | {x["id"] for x in pool.reachable_masteries(1)})

    def adjacent_rounds():
        while True:
            close = near()
            pts = pool.points()
            room, asc_room = points - pts["used"], asc_points - pts["ascendancy"]
            batch = []
            for n in nodes:
                if n["id"] not in close or n["id"] in bad:
                    continue
                if n.get("ascendancy"):
                    if asc_room < 1:
                        continue
                    asc_room -= 1
                else:
                    if room < 1:
                        continue
                    room -= 1
                batch.append(n["id"])
            if not batch:
                return
            try:
                pool.apply([op_for(batch)])
            except ValueError:   # e.g. a mastery effect already taken: one at a time, skipping those that fail
                for i in batch:
                    try:
                        pool.apply([op_for([i])])
                    except ValueError:
                        bad.add(i)
            still = near()   # a node still one step away wasn't allocated: never batch it again
            for i in batch:
                if i in still:
                    bad.add(i)
                elif i not in bad:
                    taken.append(i)

    while True:
        adjacent_rounds()
        # A gap (no learned node next to the tree): the most common learned node that fits, with its path; then
        # back to the adjacent rounds from there.
        moved = False
        for n in nodes:
            if n["id"] in bad:
                continue
            try:
                path = pool.node_path(n["id"])
            except ValueError:   # not on PoB's tree
                bad.add(n["id"])
                continue
            if not path:
                continue  # allocated already (on an earlier path) or unreachable
            pts = pool.points()
            if n.get("ascendancy"):
                if pts["ascendancy"] + len(path) > asc_points:
                    continue
            elif pts["used"] + len(path) > points:
                continue
            op = op_for([n["id"]])
            mast = {str(p): masteries[str(p)] for p in path if str(p) in masteries}
            if mast:
                op["masteries"] = mast
            try:
                pool.apply([op])
            except ValueError:
                bad.add(n["id"])
                continue
            taken.append(n["id"])
            moved = True
            break
        if not moved:
            break
    pts = pool.points()
    log.append({"step": "tree-build", "change": f"learned start: {len(taken)} of {len(start.get('nodes') or [])} "
                                                f"common nodes ({pts['used']} pts, {pts['ascendancy']} ascendancy)",
                "value": None})
    return taken


def learned_keystones(pool, start):
    """The learned start's keystones the tree holds now: the swap search never refunds them."""
    have = {n["id"] for n in pool.allocated_nodes()}
    return tuple(n["id"] for n in (start or {}).get("nodes") or [] if n["type"] == "Keystone" and n["id"] in have)


def build(pool, rules, cls, ascendancy=None, points=123, asc_points=8, max_dist=10, main_skill=None, log=None,
          improve_iters=40, start=None):
    """Grow a tree from the class start with `points` main and `asc_points` ascendancy points (opt.py passes the
    loaded build's counts). The build's gear, gems and config stay as they are. start: a learned start
    (design/learn.py common()): its nodes are taken first, then the greedy fill and the swap search try to beat
    them; its keystones are never refunded."""
    log = log if log is not None else []
    pool.apply([{"op": "tree-reset", "class": cls, **({"ascendancy": ascendancy} if ascendancy else {})}],
               allow_main_change=True)
    log.append({"step": "tree-build", "change": f"reset to {cls}" + (f" / {ascendancy}" if ascendancy else ""),
                "value": rules.value(pool.stats())})
    protect = ()
    if start and start.get("nodes"):
        seed(pool, start, points, asc_points, log)
        log[-1]["value"] = rules.value(pool.stats())
        protect = learned_keystones(pool, start)
    # ascendancy points
    tabu = set()
    while pool.points()["ascendancy"] < asc_points:
        spare = asc_points - pool.points()["ascendancy"]
        base = pool.stats()
        cands = [n for n in pool.reachable_nodes(spare, ascendancy=True) if n["id"] not in tabu]
        rows = _rank(pool, rules, base, cands, lambda n: {"allocate": [n["id"]]}, lambda n, r: n["dist"])
        rows = [row for row in rows if row[0][0] >= 1]
        if not rows:
            break
        rate, node, _ = rows[0]
        snapshot = pool.save_xml()
        try:
            after = pool.apply([{"op": "allocate", "nodes": [node["id"]]}])
        except ValueError:
            tabu.add(node["id"])
            continue
        if pool.points()["ascendancy"] > asc_points or _rules_worse(rules, after, base):
            pool.load(snapshot, main_skill)
            tabu.add(node["id"])
            continue
        log.append({"step": "tree-build", "change": f"+ {node['name']} (ascendancy, {node['dist']} pts)",
                    "value": rules.value(pool.stats())})
    # Points left because no node passed the rules (e.g. every one costs a little mana the bare tree lacks): an
    # unspent ascendancy is never right, so take the best of the rest; later steps repair the rules.
    tabu = set()
    while pool.points()["ascendancy"] < asc_points:
        spare = asc_points - pool.points()["ascendancy"]
        base = pool.stats()
        cands = [n for n in pool.reachable_nodes(spare, ascendancy=True) if n["id"] not in tabu]
        rows = _rank(pool, rules, base, cands, lambda n: {"allocate": [n["id"]]}, lambda n, r: n["dist"])
        if not rows:
            break
        node = rows[0][1]
        snapshot = pool.save_xml()
        try:
            pool.apply([{"op": "allocate", "nodes": [node["id"]]}])
        except ValueError:
            tabu.add(node["id"])
            continue
        if pool.points()["ascendancy"] > asc_points:
            pool.load(snapshot, main_skill)
            tabu.add(node["id"])
            continue
        log.append({"step": "tree-build", "change": f"+ {node['name']} (ascendancy, {node['dist']} pts; no node "
                                                    f"passed the rules, best of the rest)",
                    "value": rules.value(pool.stats())})
    # main tree: greedy by rate per point; when nothing improves the metric, take the best EHP-per-point path
    # so travel through empty areas still happens
    tabu = set()
    while pool.points()["used"] < points:
        spare = points - pool.points()["used"]
        base = pool.stats()
        adds = [a for a in _additions(pool, min(max_dist, spare)) if a["points"] <= spare and a["key"] not in tabu]
        rows = _rank(pool, rules, base, adds, _spec, lambda a, r: a["points"])
        rows = [row for row in rows if row[0][0] >= 1]
        if not rows:
            break
        rate, add, _ = rows[0]
        snapshot = pool.save_xml()
        try:
            after = pool.apply([_op(add)])
        except ValueError:
            tabu.add(add["key"])
            continue
        # probes can differ from the real change (e.g. a socket holding a radius jewel): undo if the rules got worse
        if pool.points()["used"] > points or _rules_worse(rules, after, base):
            pool.load(snapshot, main_skill)
            tabu.add(add["key"])
            continue
        log.append({"step": "tree-build", "change": f"+ {add['label']} ({add['points']} pts)",
                    "value": rules.value(pool.stats())})
    # A grown tree has no keystones the player chose, so the swap search may refund any (but a learned start's).
    improve(pool, rules, budget=points, main_skill=main_skill, log=log, stage="tree-build", max_iters=improve_iters,
            keep_keystones=False, protect=protect)
    return log
