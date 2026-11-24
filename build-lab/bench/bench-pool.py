"""Phase 1 benchmark: throughput of N PoB worker processes running the misc calculator.

Each worker starts its own PoB, loads the build, then times `--evals` calculator passes that each add one
different unallocated node next to the tree (cycling through the candidates). Reports aggregate evals per
second and each worker's memory.

Usage:
  python bench-pool.py --pob-lib <pob-headless.py> --workers 1 4 8 12 --evals 300 BUILD.xml
"""
import argparse
import importlib.util
import json
import multiprocessing as mp
import os
import time

LUA = rb"""
function bp_setup()
  local build = launch.main.modes.BUILD
  bp_calc = build.calcsTab.calcs.getMiscCalculator(build)
  bp_cands = {}
  for _, node in pairs(build.spec.allocNodes) do
    for _, other in ipairs(node.linked or {}) do
      if not other.alloc and not other.ascendancyName and other.type ~= "Mastery"
         and other.type ~= "ClassStart" and other.type ~= "AscendClassStart" then
        bp_cands[#bp_cands + 1] = other
      end
    end
  end
  return #bp_cands
end
function bp_eval(i)
  local node = bp_cands[(i % #bp_cands) + 1]
  local o = bp_calc({ addNodes = { [node] = true } })
  return o.FullDPS or 0
end
"""


def rss_mb():
    try:
        import ctypes
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        k32, psapi = ctypes.WinDLL("kernel32"), ctypes.WinDLL("psapi")
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        if not psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
            return None
        return round(pmc.WorkingSetSize / 2**20)
    except Exception:  # noqa: BLE001 - not Windows
        try:
            import resource
            return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
        except Exception:  # noqa: BLE001
            return None


def worker(lib, xml_path, evals, start_evt, out_q):
    spec = importlib.util.spec_from_file_location("ph", lib)
    ph = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ph)
    pob = ph.Pob()
    pob.load_xml(open(xml_path, encoding="utf-8").read())
    pob.L.execute(LUA)
    n = pob.g.bp_setup()
    if n == 0:
        out_q.put("no-candidates")
        return
    out_q.put("ready")
    start_evt.wait()
    t = time.perf_counter()
    for i in range(evals):
        pob.g.bp_eval(i + os.getpid())
    out_q.put({"sec": time.perf_counter() - t, "evals": evals, "cands": n, "rssMb": rss_mb()})


def run(lib, xml_path, workers, evals):
    ctx = mp.get_context("spawn")
    start_evt, out_q = ctx.Event(), ctx.Queue()
    procs = [ctx.Process(target=worker, args=(lib, xml_path, evals, start_evt, out_q)) for _ in range(workers)]
    for p in procs:
        p.start()
    # Wait until every worker has PoB loaded (each says "ready", then blocks), and start the clock together.
    t0 = time.perf_counter()
    for _ in procs:
        msg = out_q.get(timeout=300)
        if msg != "ready":
            for p in procs:
                p.terminate()
            raise RuntimeError(f"worker not ready: {msg}")
    startup = time.perf_counter() - t0
    t = time.perf_counter()
    start_evt.set()
    results = [out_q.get(timeout=600) for _ in procs]
    wall = time.perf_counter() - t
    for p in procs:
        p.join()
    total = sum(r["evals"] for r in results)
    return {"workers": workers, "startupSec": round(startup, 1), "evalsPerSec": round(total / wall),
            "wallSec": round(wall, 2),
            "perWorkerMedianMs": round(sorted(r["sec"] / r["evals"] * 1000 for r in results)[len(results) // 2], 1),
            "rssMbPerWorker": max(r["rssMb"] or 0 for r in results)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pob-lib", required=True)
    ap.add_argument("--workers", type=int, nargs="+", default=[1, 4, 8])
    ap.add_argument("--evals", type=int, default=300)
    ap.add_argument("build")
    args = ap.parse_args()
    print(json.dumps({"logicalCpus": os.cpu_count(),
                      "runs": [run(args.pob_lib, args.build, w, args.evals) for w in args.workers]}, indent=1))


if __name__ == "__main__":
    main()
