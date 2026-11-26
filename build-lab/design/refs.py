"""Reference builds: real builds of the same skill to compare a design with.

  refs.py list [--skill GEM] [--league L]                   what's there (ladder / web) per skill
  refs.py add CODE_OR_LINK_OR_FILE --skill GEM [--loadout TITLE] [--title T] [--url U] [--league L]
                                                            a web guide's PoB code, a pobb.in / pastebin link,
                                                            or a file holding a code or a build's XML.
                                                            Guides often hold several loadouts (leveling, endgame):
                                                            name the endgame one (pob-headless.py titles lists them)
  refs.py measure --skill GEM [--config-from BUILD.xml] [--metric M] [--league L]
                                                            every reference of the skill measured in PoB

Sources:
- ladder: the night crawl (market/popularity.py) keeps each counted character's gear and passive tree, with no
  account or character names (refs-<league>/ladder-NNNN.json). They load through PoB's own character import.
- web: guides Claude finds while designing (maxroll, pobb.in, forums), added as PoB codes (web-<hash>.json).

Measuring loads each reference into PoB with the design's own config (the same boss, charges and buffs; a ladder
import has none of its own) and its main skill set, then reads damage (the design's metric), EHP, life / ES,
resists and cost: uniques and gems from poe.ninja, rares by the rare model read back from their mod lines (the
same yardstick the back-test uses). Results are cached per reference, PoB version, config and metric.

compare(design, measured) gives the report's `references` section: how many, the median and the best three,
and where the design ranks.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import statistics
import sys
import time
import urllib.request
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
for _sub in ("eval", "opt", "market", "backtest"):
    sys.path.insert(0, os.path.join(HERE, "..", _sub))

UA = "lioneye-build-lab/0.1"
LIMIT = 40   # references measured per design (a popular skill can have many more)
MEASURED = "measured.json"
PLACEHOLDER_NAME = "Reference"   # PoB's import prints a character name; the real one is never kept


def refs_dir(league):
    import popularity as P
    return P.refs_dir(league)


def decode_code(code):
    """PoB XML from a PoB code (base64url of zlib-deflated XML)."""
    code = re.sub(r"\s+", "", code)
    raw = base64.urlsafe_b64decode(code + "=" * (-len(code) % 4))
    return zlib.decompress(raw).decode("utf-8")


def fetch_code(link):
    """The PoB code behind a pobb.in or pastebin link (or any page whose whole body is a code)."""
    m = re.match(r"https?://pobb\.in/(?:u/[^/]+/)?([A-Za-z0-9_-]+)", link)
    if m:
        link = f"https://pobb.in/{m.group(1)}/raw"
    m = re.match(r"https?://pastebin\.com/(?:raw/)?([A-Za-z0-9]+)", link)
    if m:
        link = f"https://pastebin.com/raw/{m.group(1)}"
    req = urllib.request.Request(link, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace").strip()


def _write(path, data):
    tmp = f"{path}.{os.getpid()}.part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _read(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def add(league, code_or_link, skill=None, title=None, url=None, ev=None, loadout=None):
    """Store a web guide's build. Returns {"file", "skill", "title", "loadout"}. Without `skill`, PoB's main skill
    of the loadout is used (often a guide's leveling or utility skill: give it)."""
    text = code_or_link.strip()
    source_url = url
    if re.match(r"https?://", text):
        source_url = source_url or text
        text = fetch_code(text)
    elif len(text) < 1000 and os.path.isfile(text):  # a saved code or build file (a code is too long for argv)
        with open(text, encoding="utf-8") as f:
            text = f.read().strip()
    xml = text if text.startswith("<") else decode_code(text)
    if not skill:
        import evaluator as E
        ev = ev or E.Evaluator()
        skill = ev.load(xml, loadout=loadout)["mainSkill"]
    folder = refs_dir(league)
    os.makedirs(folder, exist_ok=True)
    name = f"web-{hashlib.sha1((xml + '|' + (loadout or '')).encode()).hexdigest()[:12]}.json"
    path = os.path.join(folder, name)
    _write(path, {"source": "web", "skill": skill, "title": title or "", "url": source_url or "", "xml": xml,
                  "loadout": loadout, "added": time.time()})
    return {"file": name, "skill": skill, "title": title or "", "loadout": loadout}


def listing(league, skill=None):
    """[{file, source, skill, ...}] of the league's references, optionally one skill's."""
    folder = refs_dir(league)
    out = []
    if not os.path.isdir(folder):
        return out
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".json") or name == MEASURED or not name.startswith(("ladder-", "web-")):
            continue
        try:
            ref = _read(os.path.join(folder, name))
        except (OSError, ValueError):
            continue
        if skill and (ref.get("skill") or "").lower() != skill.lower():
            continue
        out.append({"file": name, "source": ref.get("source"), "skill": ref.get("skill"),
                    "class": ref.get("class"), "level": ref.get("level"), "title": ref.get("title"),
                    "url": ref.get("url"), "loadout": ref.get("loadout")})
    return out


def ref_xml(league, name, ev):
    """The reference as PoB XML: a ladder one through PoB's character import (placeholder name), a web one as is."""
    ref = _read(os.path.join(refs_dir(league), name))
    if ref.get("source") == "web":
        return ref["xml"]
    items = dict(ref["items"])
    items["character"] = {**(items.get("character") or {}), "name": PLACEHOLDER_NAME}
    ev.pob.import_character(json.dumps(items), json.dumps(ref["passives"]))
    return ev.pob.save_xml()


def _config_key(config_xml):
    """A cache key for the config part of a build (the <Config> block), so designs sharing a config share results."""
    if not config_xml:
        return "own"
    m = re.search(r"<Config[ >].*?</Config>", config_xml, re.S)
    picks = re.findall(r'(?:bandit|pantheonMajorGod|pantheonMinorGod)="[^"]*"', config_xml)
    return hashlib.sha1(((m.group(0) if m else config_xml) + "|".join(picks)).encode()).hexdigest()[:12]


def measure_one(league, name, skill, ev, prices=None, config_xml=None, metric=None):
    """One reference's numbers: {value, metric, TotalEHP, Life, EnergyShield, res, cost, ...} or {"error"}."""
    import evaluator as E
    try:
        xml = ref_xml(league, name, ev)
        loadout = _read(os.path.join(refs_dir(league), name)).get("loadout")
        if loadout:  # pick the guide's loadout first: its config set is the one the design's config replaces
            xml = E.ph().select_loadout(xml, loadout)
        if config_xml:
            xml = E.ph().copy_config(xml, config_xml)
        # The design counts its main group in Full DPS; a ladder import counts none, so the same flag here.
        res = ev.load(xml, main_skill=skill, include_in_full_dps=True)
    except Exception as e:  # noqa: BLE001 - lupa's LuaError too: one bad reference mustn't end a design
        return {"error": f"{type(e).__name__}: {str(e)[:200]}"}
    st = res["stats"]
    p = st.get("player") or {}
    m = metric or E.main_metric(st)
    v = E.value(st, m)
    out = {"metric": m, "value": v if isinstance(v, (int, float)) else None, "TotalEHP": p.get("TotalEHP"),
           "Life": p.get("Life"), "EnergyShield": p.get("EnergyShield"),
           "res": {k: p.get(k) for k in ("FireResist", "ColdResist", "LightningResist", "ChaosResist")},
           "warnings": st.get("warnings") or [], "pobVersion": res.get("pobVersion")}
    if prices is not None:
        out["cost"] = cost(ev, prices)
    return out


def cost(pool, prices):
    """{total, uniquesGems, rares, unpriced}: uniques and gems from poe.ninja, rares by the rare model."""
    import backtest as BT
    import buildcost
    try:
        c = buildcost.price_build(pool, prices)
    except (RuntimeError, OSError) as e:
        return {"error": str(e)[:200]}
    rares = BT.guide_rares(pool)
    rare_total = round(sum(r["estimate"] for r in rares), 2)
    return {"total": round(c["total"] + rare_total, 2), "uniquesGems": c["total"], "rares": rare_total,
            "unpriced": len([u for u in c.get("unpriced") or [] if "trade check off" not in u])}


def measure(league, skill, prices=None, config_xml=None, metric=None, ev=None, say=None, limit=None):
    """Every reference of `skill`, measured (cached). [{file, source, title, url, ...numbers}]."""
    import evaluator as E
    say = say or (lambda m: None)
    refs = listing(league, skill)
    refs = [r for r in refs if r["source"] == "web"] + [r for r in refs if r["source"] != "web"]  # guides first
    if limit:
        refs = refs[:limit]
    if not refs:
        return []
    ev = ev or E.Evaluator()
    folder = refs_dir(league)
    cache_path = os.path.join(folder, MEASURED)
    try:
        cache = _read(cache_path)
    except (OSError, ValueError):
        cache = {}
    version = ev.pob.version
    out = []
    for i, r in enumerate(refs):
        # Keyed by the file's content (a new crawl reuses names), and by day when priced (prices move).
        with open(os.path.join(folder, r["file"]), "rb") as f:
            content = hashlib.sha1(f.read()).hexdigest()[:12]
        priced = time.strftime("%Y-%m-%d") if prices else "nocost"
        key = f"{r['file']}|{content}|{version}|{_config_key(config_xml)}|{metric or 'auto'}|{priced}"
        got = cache.get(key)
        if got is None:
            say(f"references: {skill} {i + 1}/{len(refs)}")
            got = measure_one(league, r["file"], skill, ev, prices, config_xml, metric)
            if "error" not in got:  # a failure is tried again next time
                cache[key] = got
                _write(cache_path, cache)
        out.append({**r, "id": content, **got})
    return out


def _median(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return statistics.median(xs) if xs else None


def _rank(value, xs, higher_better=True):
    """Share of references the value beats (0..1), or None."""
    xs = [x for x in xs if isinstance(x, (int, float))]
    if not xs or not isinstance(value, (int, float)):
        return None
    beaten = sum(1 for x in xs if (value > x if higher_better else value < x))
    return round(beaten / len(xs), 2)


def compare(design, measured):
    """The report's `references` section. design: {value, TotalEHP, cost}."""
    ok = [m for m in measured if "error" not in m and isinstance(m.get("value"), (int, float)) and m["value"] > 0]
    out = {"references": len(measured), "measured": len(ok),
           "sources": {s: sum(1 for m in ok if m.get("source") == s) for s in ("ladder", "web")},
           **({"failed": len(measured) - len(ok)} if len(ok) < len(measured) else {})}
    if not ok:
        return out
    vals = [m["value"] for m in ok]
    ehps = [m.get("TotalEHP") for m in ok]
    costs = [(m.get("cost") or {}).get("total") for m in ok]
    out["median"] = {"value": _median(vals), "TotalEHP": _median(ehps), "cost": _median(costs)}
    best = sorted(ok, key=lambda m: -m["value"])[:3]
    out["best"] = [{"source": m.get("source"), "title": m.get("title") or (f"ladder {m.get('class')} "
                                                                           f"level {m.get('level')}"),
                    "url": m.get("url") or None, "value": m["value"], "TotalEHP": m.get("TotalEHP"),
                    "cost": (m.get("cost") or {}).get("total")} for m in best]
    out["design"] = {"value": design.get("value"), "TotalEHP": design.get("TotalEHP"), "cost": design.get("cost"),
                     "beatsOnDamage": _rank(design.get("value"), vals),
                     "beatsOnEHP": _rank(design.get("TotalEHP"), ehps),
                     "cheaperThan": _rank(design.get("cost"), costs, higher_better=False)}
    return out


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description="Reference builds to compare designs with")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list")
    p.add_argument("--skill")
    p.add_argument("--league")
    p = sub.add_parser("add")
    p.add_argument("code")
    p.add_argument("--skill")
    p.add_argument("--loadout")
    p.add_argument("--title")
    p.add_argument("--url")
    p.add_argument("--league")
    p = sub.add_parser("measure")
    p.add_argument("--skill", required=True)
    p.add_argument("--config-from", help="a build whose config set is used for every reference")
    p.add_argument("--metric")
    p.add_argument("--league")
    p.add_argument("--no-cost", action="store_true")
    args = ap.parse_args()
    from ninja import Prices
    prices = Prices(args.league)
    league = prices.league
    if args.cmd == "list":
        refs = listing(league, args.skill)
        by = {}
        for r in refs:
            k = r["skill"] or "?"
            counts = by.setdefault(k, {"ladder": 0, "web": 0})
            counts[r["source"] or "?"] = counts.get(r["source"] or "?", 0) + 1
        out = {"league": league, "skills": dict(sorted(by.items(), key=lambda x: -sum(x[1].values())))}
        if args.skill:
            out["references"] = refs
    elif args.cmd == "add":
        out = add(league, args.code, args.skill, args.title, args.url, loadout=args.loadout)
    else:
        cfg = None
        if args.config_from:
            with open(args.config_from, encoding="utf-8") as f:
                cfg = f.read()
        out = measure(league, args.skill, None if args.no_cost else prices, cfg, args.metric,
                      say=lambda m: print(m, file=sys.stderr, flush=True))
    print(json.dumps(out, indent=1, ensure_ascii=False, default=str))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as e:
        sys.exit(f"error: {e}")
