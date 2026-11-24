"""Phase 1 benchmark: how fast can headless PoB evaluate builds?

Measures, per build file:
  load      full XML load + calc (the path pob-headless.py uses today)
  reload    the same build loaded again (warm caches)
  base      PoB's misc calculator with no override (should match the loaded stats)
  node+     one unallocated passive next to the tree added, via override.addNodes
  node-     one allocated small passive removed, via override.removeNodes
  item      the equipped amulet swapped for a plain Onyx Amulet (keeps its implicit), via override.repItem

Usage (the poe-build-expert venv has lupa):
  python bench-eval.py --pob-lib <path to pob-headless.py> BUILD.xml [BUILD.xml ...] [--repeat 20]
"""
import argparse
import importlib.util
import json
import statistics
import sys
import time

LUA = rb"""
function bx_calculator()
  local build = launch.main.modes.BUILD
  local calcFunc, baseOut = build.calcsTab.calcs.getMiscCalculator(build)
  bx_calc, bx_build = calcFunc, build
  bx_plain_amulet = new("Item"):Item("Rarity: NORMAL\nOnyx Amulet\nOnyx Amulet")
  return baseOut
end

-- One unallocated, non-ascendancy, non-mastery node linked to the allocated tree.
function bx_pick_add()
  local spec = bx_build.spec
  for id, node in pairs(spec.allocNodes) do
    for _, other in ipairs(node.linked or {}) do
      if not other.alloc and not other.ascendancyName and other.type ~= "Mastery"
         and other.type ~= "ClassStart" and other.type ~= "AscendClassStart" then
        return other
      end
    end
  end
end

-- One allocated small passive (type Normal) whose removal keeps it a leaf-ish change.
function bx_pick_remove()
  local spec = bx_build.spec
  for id, node in pairs(spec.allocNodes) do
    if node.type == "Normal" and not node.ascendancyName then return node end
  end
end

-- Gem change without reloading XML: switch a support in the main group off, recalc, read, switch back.
function bx_gem_toggle_setup()
  local b = launch.main.modes.BUILD
  local grp = b.skillsTab.socketGroupList[b.mainSocketGroup]
  for _, gem in ipairs(grp and grp.gemList or {}) do
    if gem.gemData and gem.gemData.grantedEffect and gem.gemData.grantedEffect.support and gem.enabled ~= false then
      bx_gem = gem
      return gem.nameSpec
    end
  end
end

function bx_gem_toggle()
  local b = launch.main.modes.BUILD
  bx_gem.enabled = not bx_gem.enabled
  b.buildFlag = true
  runCallback("OnFrame")
  local o = b.calcsTab.mainOutput
  local off = o.FullDPS ~= 0 and o.FullDPS or (o.CombinedDPS or 0)
  bx_gem.enabled = not bx_gem.enabled
  b.buildFlag = true
  runCallback("OnFrame")
  return off
end

function bx_run(kind, node)
  local o
  if kind == "base" then o = bx_calc(nil)
  elseif kind == "add" then o = bx_calc({ addNodes = { [node] = true } })
  elseif kind == "remove" then o = bx_calc({ removeNodes = { [node] = true } })
  elseif kind == "item" then
    o = bx_calc({ repSlotName = "Amulet", repItem = bx_plain_amulet })
  end
  return o.FullDPS or 0, o.CombinedDPS or 0, o.Life or 0, o.TotalEHP or 0
end
"""


def load_lib(path):
    spec = importlib.util.spec_from_file_location("ph", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def timed(fn, repeat):
    times, result = [], None
    for _ in range(repeat):
        t = time.perf_counter()
        result = fn()
        times.append((time.perf_counter() - t) * 1000)
    return result, {"medianMs": round(statistics.median(times), 1), "minMs": round(min(times), 1),
                    "maxMs": round(max(times), 1), "n": repeat}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pob-lib", required=True)
    ap.add_argument("--repeat", type=int, default=20)
    ap.add_argument("builds", nargs="+")
    args = ap.parse_args()
    ph = load_lib(args.pob_lib)

    t = time.perf_counter()
    pob = ph.Pob()
    startup = round(time.perf_counter() - t, 2)
    pob.L.execute(LUA)
    report = {"pob": pob.info(), "startupSec": startup, "builds": []}

    for path in args.builds:
        with open(path, encoding="utf-8") as f:
            xml = f.read()
        row = {"build": path.replace("\\", "/").rsplit("/", 1)[-1]}

        t = time.perf_counter()
        pob.load_xml(xml)
        row["loadMs"] = round((time.perf_counter() - t) * 1000)
        loaded = pob.stats()["player"]
        _, row["reload"] = timed(lambda: pob.load_xml(xml), max(3, args.repeat // 4))
        loaded = pob.stats()["player"]
        row["mainSkill"] = pob.main_skill()

        t = time.perf_counter()
        pob.g.bx_calculator()
        row["calculatorSetupMs"] = round((time.perf_counter() - t) * 1000)

        add, rem = pob.g.bx_pick_add(), pob.g.bx_pick_remove()
        row["addNode"] = ph._s(add.dn) if add is not None else None
        row["removeNode"] = ph._s(rem.dn) if rem is not None else None

        res = {}
        for kind, node in (("base", None), ("add", add), ("remove", rem), ("item", None)):
            if kind in ("add", "remove") and node is None:
                continue
            out, stats = timed(lambda: pob.g.bx_run(kind.encode(), node), args.repeat)
            stats["FullDPS"], stats["CombinedDPS"], stats["Life"], stats["TotalEHP"] = (round(v) for v in out)
            res[kind] = stats
        row["calculator"] = res
        gem = pob.g.bx_gem_toggle_setup()
        if gem is not None:
            off, stats = timed(lambda: pob.g.bx_gem_toggle(), max(3, args.repeat // 4))
            stats["gem"] = ph._s(gem)
            stats["dpsWithGemOff"] = round(off)
            stats["note"] = "time covers two recalcs (off, then back on)"
            row["gemToggle"] = stats
        # The calculator's base pass must agree with the normal load, or deltas mean nothing.
        row["baseMatchesLoad"] = {k: (loaded.get(k), res["base"][k])
                                  for k in ("FullDPS", "CombinedDPS", "Life", "TotalEHP") if k in loaded}
        report["builds"].append(row)
        print(json.dumps(row), file=sys.stderr)

    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
