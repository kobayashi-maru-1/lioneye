"""How popular a build's pieces are, from GGG's public data (poe.ninja's builds API is closed to third parties).

- Ascendancy share: GGG's public ladder, the top `depth` characters (default 3000; 200 per request).
- Main skill and unique shares: a small sample of public characters spread over that ladder, read with GGG's
  public character endpoint (default 80, which stays inside GGG's 90-per-30-minutes rule for that endpoint).
  A character's main skill is the active gem in its largest linked group (weapon swap left out).

Only counts are kept: no account or character names are stored. The result is cached per league for a day
(%LOCALAPPDATA%\\poe-build-expert\\market\\popularity-<league>.json); refreshing it takes a few minutes.

novelty(stats, ascendancy, main_skill, uniques) -> {"novelty": 0..1, parts...}
  archetype share = the sample's share of characters with the same ascendancy and main skill (estimated as
  ascendancy share x skill share when the sample has none); novelty = 1 - min(1, archetype share / 5%), so an
  archetype played by 5% or more of the top ladder scores 0 and one nobody plays scores 1. The parts (ascendancy,
  skill and each unique's share) are reported so the score can be read.
"""
import json
import os
import sys
import time
import urllib.parse

from net import GGG, RateLimited, cache_root

LADDER = "https://www.pathofexile.com/api/ladders/{league}?limit=200&offset={offset}"
ITEMS = "https://www.pathofexile.com/character-window/get-items?"
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


def uniques(items):
    return sorted({it.get("name") for it in items.get("items") or []
                   if it.get("frameType") in UNIQUE_FRAMES and it.get("name") and it.get("inventoryId") not in SKIP})


def refresh(league, depth=3000, sample=80, ggg=None, verbose=True):
    ggg = ggg or GGG(verbose)
    entries = []
    for offset in range(0, depth, 200):
        page = ggg.call(LADDER.format(league=urllib.parse.quote(league), offset=offset)) or {}
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
