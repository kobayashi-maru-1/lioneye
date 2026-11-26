"""Price a rare on the official trade site: listings with the same base and the item's explicit mods at least
~85% as good; the price is the median of the cheapest few. Used to check the gear optimizer's final picks
(rarecost.py only estimates) and, with market.py cost --trade-check, a build's rares. Bench crafts are left out of
the search (a buyer can craft them) and added at rarecost.BENCH each.

    t = Trade(prices)                                    # prices: ninja.Prices (league and currency rates)
    t.price(base, explicit_lines, crafted_lines=(), local=())
        -> {"divine", "listings", "url", "matched", "unmatched", "need", "floor", "thin", "reason"}

"thin" is set when fewer than ninja.MIN_LISTINGS (3) listings match: one seller's asking price (a 700-divine
mirror listing, say) says nothing about what the item costs, so callers keep it out of totals.

One search (plus one fetch) per item: all mods required for items with three or fewer, otherwise all but one
(so the cheapest listings are close relatives, not exact copies; "floor" is then set). Mod lines are matched to
trade stat ids by their text with numbers replaced by "#" (GGG's /api/trade/data/stats, cached a day); local[i]
says line i is local to the item (weapon and armour defences), which prefers the "(Local)" stat. Lines for the
same stat are summed. Negative values (downsides) are matched without a minimum. When fewer than half the lines
match, or none do, there's no price (divine None, with a reason) rather than a price for some other item.
Calls are paced by net.GGG; keep checks to a handful per run.
"""
import re
import statistics
import urllib.parse

import rarecost
from net import GGG, cached_json
from ninja import MIN_LISTINGS

API = "https://www.pathofexile.com/api/trade/"
NUM = re.compile(r"[+-]?\d+(?:\.\d+)?")
MIN_SHARE = 0.85
CHEAPEST = 5
MIN_MATCHED = 0.5


def _norm(line):
    """'+107 to maximum Life' -> '+# to maximum Life' (trade-site template form)."""
    return re.sub(r"(?<![\w.])(\d+(?:\.\d+)?)", "#", line.strip())


def _value(line):
    nums = [float(n) for n in NUM.findall(line)]
    if not nums:
        return None
    if re.search(r"\bAdds \S+ to \S+", line) and len(nums) >= 2:
        return (abs(nums[0]) + abs(nums[1])) / 2  # the trade site filters "Adds # to #" on the average
    return nums[0]


class Trade:
    def __init__(self, prices, ggg=None):
        self.prices = prices
        self.league = prices.league
        self.ggg = ggg or GGG()
        self._index = None

    def _stats(self):
        if self._index is None:
            data, _ = cached_json(API + "data/stats", "trade-stats", 24 * 3600)
            idx = {}
            for grp in data.get("result", []):
                for e in grp.get("entries", []):
                    if e.get("type") in ("explicit", "crafted"):
                        idx.setdefault((e["type"], e["text"]), e["id"])
            self._index = idx
        return self._index

    def stat_id(self, line, kind="explicit", local=False):
        idx = self._stats()
        tmpl = _norm(line)
        if tmpl.startswith("+"):
            forms = [tmpl, tmpl[1:]]
        elif tmpl.startswith("-"):
            forms = [tmpl, "+" + tmpl[1:], tmpl[1:]]  # "-12% to Chaos Resistance" is listed as "+#%"
        else:
            forms = [tmpl, "+" + tmpl]
        for form in forms:
            for t in ([form + " (Local)", form] if local else [form, form + " (Local)"]):
                if (kind, t) in idx:
                    return idx[(kind, t)]
        return None

    def query(self, base, explicit_lines, local=(), need=None):
        """(query, matched, unmatched). need = how many of the stats a listing must have (None: all)."""
        sums, order, matched, unmatched = {}, [], [], []
        for i, line in enumerate(explicit_lines):
            sid = self.stat_id(line, "explicit", i < len(local) and bool(local[i]))
            v = _value(line)
            if sid is None or v is None:
                unmatched.append(line)
                continue
            if sid not in sums:
                order.append(sid)
                sums[sid] = 0.0
            sums[sid] += v
            matched.append(line)
        filters = []
        for sid in order:
            f = {"id": sid}
            if sums[sid] > 0:
                f["value"] = {"min": round(sums[sid] * MIN_SHARE, 2)}
            filters.append(f)
        group = ({"type": "and", "filters": filters} if need is None or need >= len(filters)
                 else {"type": "count", "value": {"min": need}, "filters": filters})
        q = {"query": {"status": {"option": "online"}, "type": base, "stats": [group],
                       "filters": {"type_filters": {"filters": {"rarity": {"option": "nonunique"}}}}},
             "sort": {"price": "asc"}}
        return q, matched, unmatched, len(filters)

    def price(self, base, explicit_lines, crafted_lines=(), local=()):
        _, matched, unmatched, n = self.query(base, explicit_lines, local)
        total = len(explicit_lines)
        if n == 0 or len(matched) < MIN_MATCHED * total:
            return {"divine": None, "listings": 0, "url": None, "matched": matched, "unmatched": unmatched,
                    "need": f"0 of {n}", "floor": False,
                    "reason": f"only {len(matched)} of {total} mods match trade stats"}
        need = n if n <= 3 else n - 1
        q, matched, unmatched, n = self.query(base, explicit_lines, local, need)
        path = urllib.parse.quote(self.league)
        res = self.ggg.call(API + f"search/{path}", q)
        if not res or "id" not in res:
            raise RuntimeError("the trade search failed")
        url = f"https://www.pathofexile.com/trade/search/{path}/{res['id']}"
        ids = (res.get("result") or [])[:10]
        values = []
        if ids:
            got = self.ggg.call(API + f"fetch/{','.join(ids)}?query={res['id']}") or {}
            for x in got.get("result") or []:
                p = ((x or {}).get("listing") or {}).get("price") or {}
                chaos = self.prices.currency_chaos(p.get("currency")) if p.get("currency") else None
                if chaos is not None and p.get("amount") is not None:
                    values.append(float(p["amount"]) * chaos / self.prices.divine)
        values.sort()
        divine = round(statistics.median(values[:CHEAPEST]) + rarecost.BENCH * len(crafted_lines), 3) if values else None
        listings = res.get("total", 0)
        return {"divine": divine, "listings": listings, "url": url, "matched": matched,
                "unmatched": unmatched, "checked": len(values), "need": f"{need} of {n} stats",
                "floor": need < n or bool(unmatched), "thin": bool(values) and listings < MIN_LISTINGS,
                **({} if values else {"reason": "nothing comparable listed"})}
