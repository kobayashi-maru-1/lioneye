"""How popular a build's pieces are, from GGG's public data (poe.ninja's builds API is closed to third parties).

- Ascendancy share: GGG's public ladder, the top `depth` characters (default 3000; 200 per request).
- Main skill and unique shares: a small sample of public characters spread over that ladder, read with GGG's
  public character endpoint (default 80, which stays inside GGG's 90-per-30-minutes rule for that endpoint).
  A character's main skill is the active gem in its largest linked group (weapon swap left out).

This sample keeps counts only, no account or character names. The result is cached per league for a day
(%LOCALAPPDATA%\\poe-build-expert\\market\\popularity-<league>.json); refreshing it takes a few minutes.

Per-skill unique data (crawl, below): about 900 public ladder characters read over about 5 hours, counting per
main skill the uniques worn in each slot. It never runs on its own: the designer asks the user first, every time.
crawl_status(league), crawl(league), candidates(data, skill) -> the uniques 10%+ of the skill's players wear.
Each counted character is also kept as a reference build (gear, passive tree, and the account and character
names the ladder shows, so its current copy can be read later); crawldata.py shares them through GitHub.

novelty(stats, ascendancy, main_skill, uniques) -> {"novelty": 0..1, parts...}
  archetype share = the sample's share of characters with the same ascendancy and main skill (estimated as
  ascendancy share x skill share when the sample has none); novelty = 1 - min(1, archetype share / 5%), so an
  archetype played by 5% or more of the top ladder scores 0 and one nobody plays scores 1. The parts (ascendancy,
  skill and each unique's share) are reported so the score can be read.
"""
import json
import os
import re
import sys
import time
import urllib.parse

from net import GGG, RateLimited, cache_root

LADDER = "https://www.pathofexile.com/api/ladders/{league}?limit=200&offset={offset}"
ITEMS = "https://www.pathofexile.com/character-window/get-items?"
PASSIVES = "https://www.pathofexile.com/character-window/get-passive-skills?"
# What a saved reference build keeps of GGG's character block: enough for PoB's import (the names are kept
# separately, from the ladder entry).
CHARACTER_KEEP = ("class", "classId", "ascendancyClass", "level", "league")
SWAP = ("Weapon2", "Offhand2")
SKIP = ("MainInventory", "ExpandedMainInventory") + SWAP
UNIQUE_FRAMES = (3, 9, 10)  # unique, relic (foil) frames
POPULAR = 0.05


def _path(league):
    return os.path.join(cache_root(), f"popularity-{''.join(c if c.isalnum() else '-' for c in league)}.json")


# Not Movement/Travel: Cyclone, Flicker Strike and the like carry those tags and are main skills. Blink skills
# (Frostblink, Dash, Flame Dash) are the movement utilities.
UTILITY_TAGS = ("Aura", "Herald", "Warcry", "Guard", "Blink", "Banner", "Mark", "Stance", "Curse", "Hex", "Golem")


def _utility(gem):
    """True for aura/herald/warcry/guard/movement-type skills (from the gem's tag line), which make big link
    groups without being the build's main skill."""
    props = gem.get("properties") or []
    tags = props[0].get("name", "") if props else ""
    return any(t in tags.split(", ") for t in UTILITY_TAGS)


def main_skill(items):
    """The active gem in the character's largest linked group, preferring groups whose active gem isn't a
    utility skill (aura, herald, warcry, guard, blink, curse, golem); ties: body armour first. None when there's
    none, or when only utility skills are socketed (the main skill isn't a socketed gem, e.g. item-granted)."""
    best = None
    for it in items.get("items") or []:
        if it.get("inventoryId") in SKIP:
            continue
        sockets = it.get("sockets") or []
        groups = {}
        for g in it.get("socketedItems") or []:
            idx = g.get("socket")
            if idx is None or idx >= len(sockets):
                continue
            groups.setdefault(sockets[idx].get("group"), []).append(g)
        for gems in groups.values():
            actives = [g for g in gems if not g.get("support")]
            if not actives:
                continue
            main = next((g for g in actives if not _utility(g)), None)
            if main is None:
                continue
            key = (len(gems), it.get("inventoryId") == "BodyArmour")
            if best is None or key > best[0]:
                best = (key, main.get("typeLine"))
    return best[1] if best else None


def clean_name(name):
    """An item name as PoB writes it: GGG's API can prefix names with markup like <<set:MS>><<set:M>><<set:S>>."""
    return re.sub(r"<<[^>]*>>", "", name or "").strip()


def uniques(items):
    return sorted({clean_name(it.get("name")) for it in items.get("items") or []
                   if it.get("frameType") in UNIQUE_FRAMES and it.get("name") and it.get("inventoryId") not in SKIP})


def refresh(league, depth=3000, sample=80, ggg=None, verbose=True):
    ggg = ggg or GGG(verbose)
    entries = []
    for offset in range(0, depth, 200):
        if not time_left():
            if data:
                data["paused"] = True
                data["updated"] = time.time()
                _save(path, data)
            return data or {"league": league, "paused": True, "done": False, "skills": {}}
        try:
            page = ggg.call(LADDER.format(league=urllib.parse.quote(league), offset=offset)) or {}
        except RateLimited:
            if until is None:
                raise
            return data or {"league": league, "paused": True, "done": False, "skills": {}}
        got = page.get("entries") or []
        entries.extend(got)
        if len(got) < 200:
            break
    if not entries:
        raise RuntimeError(f"GGG's ladder for {league} is empty")
    asc = {}
    for e in entries:
        c = (e.get("character") or {}).get("class")
        if c:
            asc[c] = asc.get(c, 0) + 1
    public = [e for e in entries if e.get("public")]
    step = max(1, len(public) // max(1, sample))
    picked = public[::step][:sample]
    skills, uniq, combos, read, failed = {}, {}, {}, 0, 0
    for i, e in enumerate(picked):
        params = {"accountName": e["account"]["name"], "character": e["character"]["name"], "realm": "pc"}
        try:
            items = ggg.call(ITEMS + urllib.parse.urlencode(params))
        except RateLimited:
            raise
        except RuntimeError:
            failed += 1  # one character's error (e.g. a 5xx) shouldn't lose the whole refresh
            continue
        if not isinstance(items, dict) or not items.get("items"):
            continue  # went private or was deleted since the ladder was read
        read += 1
        skill = main_skill(items)
        if skill:
            skills[skill] = skills.get(skill, 0) + 1
            key = f"{e['character'].get('class')}|{skill}"
            combos[key] = combos.get(key, 0) + 1
        for u in uniques(items):
            uniq[u] = uniq.get(u, 0) + 1
        if verbose and (i + 1) % 20 == 0:
            print(f"popularity: {i + 1}/{len(picked)} characters read", file=sys.stderr, flush=True)
    data = {"league": league, "fetched": time.time(), "ladderDepth": len(entries), "ascendancy": asc,
            "sample": read, "failed": failed, "skills": skills, "uniques": uniq, "archetypes": combos}
    path = _path(league)
    tmp = f"{path}.{os.getpid()}.part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)
    return data


def load(league, max_age=24 * 3600, refresh_if_stale=True, **kw):
    """The cached popularity data; refreshed when older than max_age (if allowed). None when there is none."""
    try:
        with open(_path(league), encoding="utf-8") as f:
            data = json.load(f)
        if time.time() - data.get("fetched", 0) < max_age or not refresh_if_stale:
            return data
    except (OSError, ValueError):
        data = None
    if not refresh_if_stale:
        return data
    try:
        return refresh(league, **kw)
    except RuntimeError:
        if data:
            return data
        raise


def _share(counts, key, total):
    return (counts.get(key, 0) / total) if total else None


def novelty(data, ascendancy, skill, uniques_used=()):
    n, depth = data.get("sample") or 0, data.get("ladderDepth") or 0
    if not n or ascendancy not in (data.get("ascendancy") or {}):
        why = "no sample" if not n else f"'{ascendancy}' isn't an ascendancy on the ladder (unascended or renamed)"
        return {"novelty": None, "note": why, "ascendancy": ascendancy, "skill": skill}
    asc_share = _share(data.get("ascendancy", {}), ascendancy, depth)
    skill_share = _share(data.get("skills", {}), skill, n)
    arch = _share(data.get("archetypes", {}), f"{ascendancy}|{skill}", n)
    if not arch and asc_share is not None and skill_share is not None:
        arch = asc_share * skill_share
    score = None if arch is None else round(1 - min(1.0, arch / POPULAR), 3)
    return {"novelty": score, "archetypeShare": None if arch is None else round(arch, 4),
            "ascendancy": ascendancy, "ascendancyShare": None if asc_share is None else round(asc_share, 4),
            "skill": skill, "skillShare": None if skill_share is None else round(skill_share, 4),
            "uniques": {u: round(_share(data.get("uniques", {}), u, n) or 0.0, 4) for u in uniques_used},
            "basis": f"top {depth} ladder characters; skills and uniques from {n} public ones",
            "fetched": time.strftime("%Y-%m-%d %H:%M", time.localtime(data.get("fetched", 0)))}


# -- per-skill unique counts: the crawl ------------------------------------------------------------------------
# poe.ninja's builds API is closed to outside tools (poe.ninja/docs/api), so which uniques a skill's players use
# comes from reading GGG's public ladder characters. GGG allows about 90 character reads per 30 minutes, so a
# 900-character crawl takes about 5 hours. It never starts on its own: the designer reports the data's age and
# asks the user before running it. Only counts are kept; progress is saved by ladder rank, never by name.

CRAWL_DEPTH = 15000                 # the whole public ladder GGG lists
CRAWL_SAMPLE = 900
CRAWL_MAX_AGE = 7 * 24 * 3600       # older than a week: the designer says so and offers a refresh
CRAWL_SLEEP = 31 * 60               # wait out a whole character-read window instead of stopping
CRAWL_SAVE_EVERY = 10
SLOT_OF = {"Weapon": "Weapon 1", "Offhand": "Weapon 2", "Helm": "Helmet", "BodyArmour": "Body Armour",
           "Gloves": "Gloves", "Boots": "Boots", "Belt": "Belt", "Amulet": "Amulet", "Ring": "Ring", "Ring2": "Ring",
           "Flask": "Flask"}       # both rings count as "Ring": a unique ring can go in either
CANDIDATE_SHARE = 0.10
CANDIDATE_MIN_CHARS = 5
CRAWL_MARGIN = 60                   # seconds: stop this long before the window ends, so no request lands after it
CRAWL_MAX_FAILS = 5                 # this many characters in a row failing with HTTP errors: an outage
CRAWL_RETRY = 120                   # seconds: in a night window, wait this long after an outage and try again


def crawl_path(league):
    return os.path.join(cache_root(), f"popularity-crawl-{''.join(c if c.isalnum() else '-' for c in league)}.json")


def slot_uniques(items):
    """{(slot, unique name)} a character wears, slots as SLOT_OF names (weapon swap and inventory left out)."""
    out = set()
    for it in items.get("items") or []:
        slot = SLOT_OF.get(it.get("inventoryId"))
        if slot and it.get("frameType") in UNIQUE_FRAMES and clean_name(it.get("name")):
            out.add((slot, clean_name(it["name"])))
    return out


def add_character(data, items, ascendancy):
    """Count one character into the crawl data. False when it has no main skill to count it under."""
    skill = main_skill(items)
    if not skill:
        return False
    s = data["skills"].setdefault(skill, {"n": 0, "asc": {}, "uniques": {}})
    s["n"] += 1
    if ascendancy:
        s["asc"][ascendancy] = s["asc"].get(ascendancy, 0) + 1
    for slot, name in slot_uniques(items):
        u = s["uniques"].setdefault(slot, {})
        u[name] = u.get(name, 0) + 1
    return True


def _save(path, data):
    tmp = f"{path}.{os.getpid()}.part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def load_crawl(league):
    try:
        with open(crawl_path(league), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def crawl_status(league, now=None):
    """What the designer tells the user before asking to crawl: exists, done, read/target, age, stale."""
    data = load_crawl(league)
    if not data:
        return {"league": league, "exists": False, "stale": True,
                "note": f"no per-skill unique data for {league}: a crawl reads about {CRAWL_SAMPLE} ladder characters "
                        f"(about {CRAWL_SAMPLE // 180 + 1} hours)"}
    age = (now or time.time()) - (data.get("updated") or 0)
    return {"league": league, "exists": True, "done": bool(data.get("done")), "paused": bool(data.get("paused")),
            "next": data.get("next", 0), "read": data.get("read", 0), "builds": data.get("builds", 0),
            "target": data.get("target"), "ageDays": round(age / 86400, 1),
            "stale": not data.get("done") or age > CRAWL_MAX_AGE}


def refs_dir(league):
    """Where the crawl keeps reference builds (one JSON per ladder character: gear, passive tree, account and character names)."""
    return os.path.join(cache_root(), f"refs-{''.join(c if c.isalnum() else '-' for c in league)}")


def _neutral_ids(items, prefix):
    """Items with GGG's item ids (which public stash data also shows) replaced by local ones. PoB's import
    matches items by id, so each keeps a distinct one."""
    out = []
    for i, it in enumerate(items):
        it = dict(it)
        if "id" in it:
            it["id"] = f"{prefix}-{i}"
        if it.get("socketedItems"):
            it["socketedItems"] = _neutral_ids(it["socketedItems"], f"{prefix}-{i}s")
        out.append(it)
    return out


def clear_references(league):
    """Remove the ladder reference builds of an earlier crawl (a new crawl numbers its own from 1)."""
    folder = refs_dir(league)
    if os.path.isdir(folder):
        for name in os.listdir(folder):
            if name.startswith("ladder-") and name.endswith(".json"):
                os.remove(os.path.join(folder, name))


def save_reference(league, n, items, passives, entry=None):
    """Keep a ladder character as a reference build: its main skill, class and level, gear and passives, and its
    ladder entry's account and character names and rank, so its current copy can be read from GGG later (the
    ladder shows these names publicly). Returns the file path."""
    char = {k: v for k, v in (items.get("character") or {}).items() if k in CHARACTER_KEEP}
    gear = {"character": char, "items": _neutral_ids(items.get("items") or [], f"r{n}")}
    if items.get("guardian"):  # Animate Guardian's gear, which PoB's import also reads
        gear["guardian"] = _neutral_ids(items["guardian"], f"r{n}g")
    entry = entry or {}
    ref = {"source": "ladder", "skill": main_skill(items), "class": char.get("class"), "level": char.get("level"),
           "account": (entry.get("account") or {}).get("name"), "character": (entry.get("character") or {}).get("name"),
           "rank": entry.get("rank"), "read": time.time(),
           "items": gear,
           "passives": {k: (_neutral_ids(v, f"r{n}j") if k == "items" and isinstance(v, list) else v)
                        for k, v in (passives or {}).items() if k not in ("character", "account")}}
    folder = refs_dir(league)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"ladder-{n:04d}.json")
    _save(path, ref)
    return path


def crawl(league, sample=CRAWL_SAMPLE, depth=CRAWL_DEPTH, fresh=False, ggg=None, verbose=True, until=None,
          clock=time.time, builds=True, sleep=time.sleep):
    """Read `sample` public ladder characters spread over the top `depth` and count, per main skill, the uniques
    they wear by slot. Resumes an unfinished crawl of the same league unless fresh. Only run it after the user
    agreed: it takes hours. until: a time (epoch seconds) to pause at; the data comes back with "paused" set and
    the next run resumes it. No rate-limit wait runs past it. An outage (no connection, or GGG failing character
    after character) inside the window waits CRAWL_RETRY and tries the same read again, until the window ends;
    without a window it stops the crawl. builds: also read each counted character's passive tree (a second read)
    and keep gear + tree as a reference build (save_reference, with the names the ladder shows)."""
    ggg = ggg or GGG(verbose, max_sleep=CRAWL_SLEEP)

    def time_left():
        """False when the window is over (or would be over before a request finishes); caps GGG's waits to it."""
        if until is None:
            return True
        left = until - clock() - CRAWL_MARGIN
        if left <= 0:
            return False
        if hasattr(ggg, "max_sleep"):
            ggg.max_sleep = min(CRAWL_SLEEP, left)
        return True

    def outage_wait(err):
        """In a window with time to spare: wait CRAWL_RETRY so the same read can be tried again (True)."""
        if until is None or until - clock() - CRAWL_MARGIN <= CRAWL_RETRY:
            return False
        if verbose:
            print(f"crawl: {err}; trying again in {CRAWL_RETRY // 60} min", file=sys.stderr, flush=True)
        sleep(CRAWL_RETRY)
        return True

    def is_outage(err):
        """No connection, or GGG's servers failing (HTTP 5xx): not one character's problem."""
        text = str(err)
        return not text.startswith("HTTP ") or text.startswith("HTTP 5")

    def pause_now():
        if data:
            data["paused"] = True
            data["updated"] = time.time()
            _save(path, data)
        return data or {"league": league, "paused": True, "done": False, "skills": {}}

    path = crawl_path(league)
    data = None if fresh else load_crawl(league)
    if data and data.get("done"):
        data = None  # a finished crawl is replaced, not extended
    entries = []
    offset = 0
    while offset < depth:
        if not time_left():
            return pause_now()
        try:
            page = ggg.call(LADDER.format(league=urllib.parse.quote(league), offset=offset)) or {}
        except RateLimited:
            if until is None:
                raise
            return pause_now()
        except RuntimeError as err:
            if is_outage(err) and outage_wait(err):
                continue  # the same ladder page again
            if is_outage(err) and until is not None:
                return pause_now()
            raise
        got = page.get("entries") or []
        entries.extend(got)
        if len(got) < 200:
            break
        offset += 200
    if not entries:
        raise RuntimeError(f"GGG's ladder for {league} is empty")
    by_rank = {e.get("rank"): e for e in entries if e.get("public") and e.get("rank") is not None}
    if data is None:
        if builds:
            clear_references(league)
        ranks = sorted(by_rank)
        step = max(1, len(ranks) // max(1, sample))
        data = {"league": league, "started": time.time(), "updated": time.time(), "done": False,
                "ladderDepth": len(entries), "target": min(sample, len(ranks)), "ranks": ranks[::step][:sample],
                "next": 0, "read": 0, "failed": 0, "skipped": 0, "skills": {}}
    ranks = data["ranks"]
    data.pop("paused", None)
    fails = 0
    try:
        while data["next"] < len(ranks):
            if not time_left():
                data["paused"] = True
                break
            e = by_rank.get(ranks[data["next"]])
            items = None
            if e:
                params = {"accountName": e["account"]["name"], "character": e["character"]["name"], "realm": "pc"}
                try:
                    items = ggg.call(ITEMS + urllib.parse.urlencode(params))
                except RateLimited:
                    if until is not None:
                        data["paused"] = True  # the wait would run past the window: stop for tonight
                        break
                    raise  # "next" still points here, so a resume reads this character
                except RuntimeError as err:
                    # One character's HTTP 4xx is skipped. No connection, a 5xx or GGG failing character after
                    # character is an outage: in a window, wait and read this character again; otherwise stop
                    # here, so a resume picks it up.
                    fails += 0 if is_outage(err) else 1
                    if is_outage(err) or fails >= CRAWL_MAX_FAILS:
                        if outage_wait(err):
                            fails = min(fails, CRAWL_MAX_FAILS - 1)  # still failing after the wait: wait again
                            continue
                        if until is not None:
                            data["paused"] = True  # the window ends before a retry: resume next night
                            break
                        raise RuntimeError(f"crawl stopped at {data['next']}/{len(ranks)} ({err}); run it again "
                                           "later to resume") from None
                    data["failed"] += 1
                    e = None
                else:
                    fails = 0
                passives = None
                if builds and isinstance(items, dict) and items.get("items") and main_skill(items):
                    if not time_left():
                        data["paused"] = True  # read again next night, tree and all
                        break
                    try:
                        passives = ggg.call(PASSIVES + urllib.parse.urlencode(params))
                    except RateLimited:
                        if until is not None:
                            data["paused"] = True
                            break
                        raise
                    except RuntimeError as err:
                        if is_outage(err) and outage_wait(err):
                            continue  # this character again, gear and tree
                        if is_outage(err) and until is not None:
                            data["paused"] = True
                            break
                        passives = None  # the counts still go in; no reference build for this one
            else:
                data["skipped"] += 1  # dropped off the ladder or went private since the crawl started
            data["next"] += 1
            if not e:
                continue
            if not isinstance(items, dict) or not items.get("items"):
                data["skipped"] += 1  # private or empty now
                continue
            data["read"] += 1
            add_character(data, items, (e.get("character") or {}).get("class"))
            if passives:
                save_reference(league, data["read"], items, passives, entry=e)
                data["builds"] = data.get("builds", 0) + 1
            if data["next"] % CRAWL_SAVE_EVERY == 0:
                data["updated"] = time.time()
                _save(path, data)
                if verbose:
                    print(f"crawl: {data['next']}/{len(ranks)} ladder characters ({data['read']} read)",
                          file=sys.stderr, flush=True)
        else:
            data["done"] = True
            data.pop("paused", None)
    finally:
        data["updated"] = time.time()
        _save(path, data)
    return data


def candidates(data, skill, share=CANDIDATE_SHARE, min_chars=CANDIDATE_MIN_CHARS):
    """{"skill", "characters", "thin", "slots": {slot: [(unique, share), ...]}}: the uniques at least `share` of the
    skill's sampled characters wear, by slot (most used first). thin: fewer than min_chars characters, so no
    candidates (the report says so)."""
    s = ((data or {}).get("skills") or {}).get(skill) or {}
    n = s.get("n", 0)
    out = {"skill": skill, "characters": n, "thin": n < min_chars, "slots": {}}
    if out["thin"]:
        return out
    for slot, counts in (s.get("uniques") or {}).items():
        picks = sorted(((u, c / n) for u, c in counts.items() if c / n >= share - 1e-9), key=lambda x: (-x[1], x[0]))
        if picks:
            out["slots"][slot] = [(u, round(x, 3)) for u, x in picks]
    return out
