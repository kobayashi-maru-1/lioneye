"""poe.ninja economy prices (the endpoints poe.ninja documents as its supported public surface:
https://poe.ninja/docs/api). Cached on disk for 3 hours with ETag revalidation; poe.ninja refreshes PoE 1 data
about every 15 minutes, so polling faster gains nothing.

    p = Prices()                     # the current challenge league (poe.ninja's first economy league)
    p.divine                         # chaos per divine
    p.unique("Mageblood", base="Heavy Belt")             -> {"chaos", "divine", "variant", "listings"} or None
    p.gem("Spell Echo", level=20, quality=20)            -> same, cheapest qualifying listing
    p.currency_chaos("exalted")                          -> chaos value of a currency id (trade-site ids)

Unique variants (rolls like Mageblood's flask count, links, Foulborn mutations) are priced as the most-listed
variant matching the base and, for linked armour/weapons, the link count; `variants` is how many there are, and
unique_variants() lists them.
"""
import os
import re
import urllib.parse

from net import cache_root, cached_json

BASE = "https://poe.ninja/poe1/api/economy"
MAX_AGE = 3 * 3600
UNIQUE_TYPES = ("UniqueWeapon", "UniqueArmour", "UniqueAccessory", "UniqueFlask", "UniqueJewel", "UniqueRelic",
                "UniqueTincture")
MIN_LISTINGS = 3  # fewer listings than this is a price nobody can rely on


class Prices:
    def __init__(self, league=None, max_age=MAX_AGE):
        self.max_age = max_age
        self.league = league or self.current_league()
        self.folder = os.path.join(cache_root(), "ninja", self.league)
        self._stash = {}
        self._exchange = {}

    # -- fetching --
    def current_league(self):
        leagues, _ = cached_json(f"{BASE}/leagues", "ninja-leagues", self.max_age)
        if not leagues:
            raise RuntimeError("poe.ninja lists no economy leagues")
        return leagues[0]["id"]

    def stash(self, kind):
        if kind not in self._stash:
            q = urllib.parse.urlencode({"league": self.league, "type": kind})
            data, _ = cached_json(f"{BASE}/stash/current/item/overview?{q}", f"stash-{kind}", self.max_age, self.folder)
            self._stash[kind] = data.get("lines") or []
        return self._stash[kind]

    def exchange(self, kind="Currency"):
        if kind not in self._exchange:
            q = urllib.parse.urlencode({"league": self.league, "type": kind})
            data, _ = cached_json(f"{BASE}/exchange/current/overview?{q}", f"exchange-{kind}", self.max_age, self.folder)
            self._exchange[kind] = data
        return self._exchange[kind]

    # -- currency --
    @property
    def divine(self):
        """Chaos per divine. Exchange values are quoted in core.primary, expected to be chaos."""
        data = self.exchange("Currency")
        core = data.get("core") or {}
        if core.get("primary") not in (None, "chaos"):
            raise RuntimeError(f"poe.ninja now quotes currency in {core.get('primary')}, not chaos; update ninja.py")
        for line in data.get("lines") or []:
            if line.get("id") == "divine":
                return float(line["primaryValue"])
        rate = core.get("rates", {}).get("divine")
        if rate:
            return 1.0 / float(rate)
        raise RuntimeError("poe.ninja has no divine price")

    def currency_chaos(self, cid):
        """Chaos value of a currency by its exchange id (the trade site uses the same ids: chaos, divine, ...)."""
        if cid == "chaos":
            return 1.0
        for kind in ("Currency", "Fragment"):
            for line in self.exchange(kind).get("lines") or []:
                if line.get("id") == cid:
                    return float(line["primaryValue"])
        return None

    def to_divine(self, chaos):
        return None if chaos is None else chaos / self.divine

    # -- items --
    @staticmethod
    def _row(line, kind):
        return {"name": line.get("name"), "base": line.get("baseType"), "variant": line.get("variant"),
                "links": line.get("links"), "chaos": line.get("chaosValue"), "divine": line.get("divineValue"),
                "listings": line.get("listingCount") or 0, "kind": kind,
                "level": line.get("gemLevel"), "quality": line.get("gemQuality"), "corrupted": bool(line.get("corrupted"))}

    def unique_variants(self, name, base=None):
        out = []
        for kind in UNIQUE_TYPES:
            for line in self.stash(kind):
                if line.get("name") == name and (base is None or line.get("baseType") == base):
                    out.append(self._row(line, kind))
        return out

    def unique(self, name, base=None, links=None):
        """Typical price of a unique: the most-listed variant (for the given link count when the item has
        links); a variant with fewer than MIN_LISTINGS listings is used only when no other exists. None when
        poe.ninja doesn't list it. Foil uniques (PoB rarity RELIC) are priced as the normal unique, a floor:
        poe.ninja's UniqueRelic type is Sanctum relics, matched only by a relic's own name and base."""
        rows = self.unique_variants(name, base)
        if not rows and base is not None:
            rows = self.unique_variants(name)
        if links is not None and any(r["links"] for r in rows):
            want = links if links >= 5 else None
            rows = [r for r in rows if (r["links"] or None) == want] or rows
        rows = [r for r in rows if r["listings"] >= MIN_LISTINGS] or rows
        if not rows:
            return None
        best = max(rows, key=lambda r: (r["listings"], -(r["chaos"] or 0)))
        return {**best, "variants": len(rows)}

    def gem(self, name, level=1, quality=0, corrupted=False):
        """Cheapest listing of a gem at or above level and quality. Accepts "Spell Echo" or "Spell Echo Support".
        Falls back, in order, to: any quality (quality is cheap to add), then corrupted copies (levels above a
        gem's natural maximum only exist corrupted). The result says which fallback was used ("relaxed")."""
        names = {name, name + " Support", re.sub(r" Support$", "", name)}
        rows = [self._row(line, "SkillGem") for line in self.stash("SkillGem") if line.get("name") in names]

        def pick(q, corr, min_listings):
            ok = [r for r in rows if (r["level"] or 1) >= level and (r["quality"] or 0) >= q
                  and (corr or not r["corrupted"]) and r["listings"] >= min_listings]
            return min(ok, key=lambda r: r["chaos"] or float("inf")) if ok else None

        tries = [(quality, corrupted, None), (0, corrupted, "any quality")]
        if not corrupted:
            tries += [(quality, True, "corrupted"), (0, True, "corrupted, any quality")]
        for q, corr, relaxed in tries:
            for min_listings in (MIN_LISTINGS, 1):
                r = pick(q, corr, min_listings)
                if r:
                    return {**r, **({"relaxed": relaxed} if relaxed else {})}
        return None
