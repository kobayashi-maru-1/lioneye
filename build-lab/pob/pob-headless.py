"""Run Path of Building Community headless and read its numbers. No GUI, no other app needed.

Where PoB comes from (first that works):
  1. POB_DIR environment variable (a PoB folder with Launch.lua)
  2. the installed app on Windows: %APPDATA%\\Path of Building Community
  3. a cached copy of PoB's source from GitHub (any OS, e.g. a Claude chat sandbox). Files are fetched on first use
     from raw.githubusercontent.com at the latest release tag: ~260 Lua files up front, tree versions and timeless
     jewel data only when a build needs them. Cache: %LOCALAPPDATA%\\poe-build-expert or ~/.cache/poe-build-expert.

Needs Python 3 with `lupa` (LuaJIT 2.1): `pip install lupa`. On Windows the script re-runs itself in
%LOCALAPPDATA%\\poe-build-expert\\venv when the current Python lacks lupa (see references/tools.md).

Command line:
    pob-headless.py info                       PoB version and the tree version it supports
    pob-headless.py titles BUILD.xml           loadouts: specs, item sets, skill sets, config sets (+ active)
    pob-headless.py stats BUILD.xml [--loadout TITLE] [--config TITLE] [--main-skill GEM] [--all]
    pob-headless.py compare A.xml B.xml [--loadout TITLE] [--config TITLE] [--main-skill GEM] [--all]
    pob-headless.py character ITEMS.json PASSIVES.json [--config-from BUILD.xml[::CONFIG]]
                    [--gems-from BUILD.xml[::LOADOUT]] [--main-skill GEM] [--save OUT.xml]

Library (file name has a hyphen, so load it with importlib; needs lupa in that Python):
    pob = Pob()
    pob.load_xml(xml_text)              raises if PoB can't load it; pob.issues lists slots/items PoB dropped
    pob.set_main_skill("Raise Spectre") chosen inside PoB and checked; raises if PoB measures another skill
    pob.stats(); pob.save_xml()
    pob.import_character(items_json, passives_json)
    XML helpers (text in, text out): select_loadout, select_config, equip, set_gem_enabled, copy_config,
    copy_gem_settings, loadout_titles

PoB is never modified: every file write PoB tries is refused, and its Lua is patched in memory only.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zlib

IS_WIN = os.name == "nt"
INSTALLED_DIR = os.path.join(os.environ.get("APPDATA", ""), "Path of Building Community") if IS_WIN else None
CACHE_DIR = (os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "poe-build-expert") if IS_WIN
             else os.path.join(os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "poe-build-expert"))
VENV_PY = os.path.join(CACHE_DIR, "venv", "Scripts" if IS_WIN else "bin", "python.exe" if IS_WIN else "python")
RAW = "https://raw.githubusercontent.com/PathOfBuildingCommunity/PathOfBuilding/{ref}/{path}"
UA = {"User-Agent": "poe-build-expert/1.0"}

try:
    from lupa import luajit21 as _lj
except ImportError:
    _lj = None

# Headline stats, in display order. Missing keys are skipped. Minion builds also get the "minion" block.
PLAYER_KEYS = [
    "FullDPS", "CombinedDPS", "TotalDPS", "TotalDot", "BleedDPS", "IgniteDPS", "PoisonDPS", "ImpaleDPS",
    "Speed", "HitChance", "CritChance", "CritMultiplier",
    "Life", "LifeUnreserved", "EnergyShield", "Mana", "ManaUnreserved", "ManaUnreservedPercent", "Ward",
    "Armour", "Evasion", "PhysicalDamageReduction",
    "TotalEHP", "PhysicalMaximumHitTaken", "FireMaximumHitTaken", "ColdMaximumHitTaken",
    "LightningMaximumHitTaken", "ChaosMaximumHitTaken",
    "FireResist", "ColdResist", "LightningResist", "ChaosResist",
    "FireResistOverCap", "ColdResistOverCap", "LightningResistOverCap",
    "BlockChance", "SpellBlockChance", "EffectiveBlockChance", "EffectiveSpellBlockChance",
    "SpellSuppressionChance", "EffectiveSpellSuppressionChance",
    "LifeRegenRecovery", "EnergyShieldRegenRecovery", "ManaRegenRecovery",
    "Str", "Dex", "Int", "MovementSpeedMod",
]
MINION_KEYS = ["FullDPS", "CombinedDPS", "TotalDPS", "TotalDot", "Speed", "Life", "EnergyShield", "TotalEHP"]


def output_dir():
    """Where files for the user go: Downloads on the PC, the sandbox's outputs folder in a Claude chat."""
    if IS_WIN:
        return os.path.join(os.path.expanduser("~"), "Downloads")
    for d in ("/mnt/user-data/outputs", "/mnt/outputs"):
        if os.path.isdir(d):
            return d
    return os.getcwd()


# ---------------- locating / fetching PoB ----------------

def _http(url, timeout=60):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def _version_from_manifest(text):
    m = re.search(r'<Version [^>]*number="([^"]+)"', text)
    return m.group(1) if m else None


def _vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "0"))


def latest_version():
    data = _http(RAW.format(ref="master", path="manifest.xml"), timeout=20)
    return _version_from_manifest(data.decode("utf-8", "replace"))


def _source_dirs():
    if not os.path.isdir(CACHE_DIR):
        return []
    found = []
    for name in os.listdir(CACHE_DIR):
        m = re.fullmatch(r"pob-src-([\d.]+)", name)
        if m and os.path.exists(os.path.join(CACHE_DIR, name, ".prefetched")):
            found.append((_vtuple(m.group(1)), os.path.join(CACHE_DIR, name)))
    return [d for _, d in sorted(found, reverse=True)]


def _newer_release(cached_dir):
    """A newer PoB release than the cached source, checked at most once a day; None when offline or current."""
    stamp = os.path.join(CACHE_DIR, ".release-checked")
    try:
        if os.path.exists(stamp) and time.time() - os.path.getmtime(stamp) < 86400:
            return None
        latest = latest_version()
        open(stamp, "w").close()
    except (OSError, urllib.error.URLError):
        return None
    have = re.search(r"pob-src-([\d.]+)$", cached_dir.replace("\\", "/"))
    return latest if latest and have and _vtuple(latest) > _vtuple(have.group(1)) else None


def find_pob(download=True):
    """PoB folder to run, or None. download=True fetches PoB's source from GitHub when nothing local exists,
    and moves to a newer release when one is out (checked once a day)."""
    env = os.environ.get("POB_DIR")
    if env and os.path.exists(os.path.join(env, "Launch.lua")):
        return env
    # POB_SOURCE=github skips the installed app (tests the download route a chat sandbox uses).
    if (os.environ.get("POB_SOURCE") != "github" and INSTALLED_DIR
            and os.path.exists(os.path.join(INSTALLED_DIR, "Launch.lua"))):
        return INSTALLED_DIR
    cached = _source_dirs()
    if cached:
        newer = _newer_release(cached[0]) if download else None
        if newer:
            try:
                return prepare_source(newer)
            except (OSError, RuntimeError) as e:
                print(f"PoB {newer} is out but couldn't be fetched ({e}); using the cached copy.", file=sys.stderr)
        return cached[0]
    if download:
        return prepare_source(latest_version())
    return None


# Files the headless run needs that aren't in the release manifest (developer files under src/).
_EXTRA_SOURCE = {"HeadlessWrapper.lua": "src/HeadlessWrapper.lua",
                 "_SimpleGraphic.def.lua": "src/_SimpleGraphic.def.lua"}
_SKIP_EXT = (".png", ".jpg", ".jpeg", ".webp", ".tga", ".dds", ".ttf", ".otf", ".exe", ".dll")


def _manifest_index(manifest):
    """name PoB opens (relative to its folder) -> (repo path, sha1). Runtime Lua lives under runtime/, the rest
    under src/. Images and binaries are left out: headless never reads them."""
    index = {}
    for tag in re.findall(r"<File [^>]*>", manifest):
        name, part, sha = (re.search(r'\b%s="([^"]*)"' % a, tag) for a in ("name", "part", "sha1"))
        if not name or not part or name.group(1).lower().endswith(_SKIP_EXT):
            continue
        n, pt = name.group(1), part.group(1)
        if pt in ("program", "tree"):
            index[n] = ("src/" + n, sha.group(1) if sha else None)
        elif pt == "runtime" and n.startswith("lua/"):
            index[n] = ("runtime/" + n, sha.group(1) if sha else None)
    for n, path in _EXTRA_SOURCE.items():
        index[n] = (path, None)
    return index


def _crlf(data):
    return data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


class _Fetcher:
    """Fetches PoB source files into the cache on first use (source mode only). Only files the release manifest
    lists are fetched, so PoB's probes for optional files (Settings.xml, first.run, ...) never touch the
    network, and a fully cached copy runs offline."""

    def __init__(self, folder, version):
        self.folder, self.ref = folder, f"v{version}"
        with open(os.path.join(folder, "manifest.xml"), encoding="utf-8") as f:
            self.index = _manifest_index(f.read())

    def __call__(self, rel):
        rel = rel.decode() if isinstance(rel, bytes) else rel
        rel = re.sub(r"/+", "/", rel.replace("\\", "/").replace("/./", "/")).lstrip("/")
        if rel.startswith("./"):
            rel = rel[2:]
        entry = self.index.get(rel)
        if entry is None:
            return False
        dest = os.path.join(self.folder, rel)
        if os.path.exists(dest):
            return True
        path, sha = entry
        try:
            data = _http(RAW.format(ref=self.ref, path=path))
        except (urllib.error.URLError, OSError) as e:
            raise RuntimeError(f"PoB needs {rel}, which isn't cached and couldn't be downloaded ({e})") from None
        # PoB's manifest hashes the release files with CRLF line endings; raw.githubusercontent.com serves the
        # repository's LF text. Accept the bytes as served or with CRLF endings.
        if sha and sha not in (hashlib.sha1(data).hexdigest(), hashlib.sha1(_crlf(data)).hexdigest()):
            raise RuntimeError(f"Downloaded {rel} doesn't match PoB's manifest checksum; run again")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = f"{dest}.{os.getpid()}-{threading.get_ident()}.part"
        with open(tmp, "wb") as f:
            f.write(data)
        try:
            os.replace(tmp, dest)
        except OSError:
            if not os.path.exists(dest):
                raise
            os.remove(tmp)  # another process finished the same file first
        return True


def prepare_source(version):
    """Fetch the Lua PoB needs at start-up into the cache (the rest comes on first use); returns the folder."""
    folder = os.path.join(CACHE_DIR, f"pob-src-{version}")
    os.makedirs(folder, exist_ok=True)
    if os.path.exists(os.path.join(folder, ".prefetched")):
        return folder
    manifest = _http(RAW.format(ref=f"v{version}", path="manifest.xml")).decode("utf-8", "replace")
    with open(os.path.join(folder, "manifest.xml"), "w", encoding="utf-8") as f:
        f.write(manifest)
    fetch = _Fetcher(folder, version)
    names = [n for n in fetch.index if n.endswith(".lua") and not n.startswith(("TreeData/", "Export/"))
             and "lua53" not in n]
    print(f"Fetching PoB {version} source ({len(names)} files, first run only)...", file=sys.stderr)
    with concurrent.futures.ThreadPoolExecutor(16) as pool:
        got = list(pool.map(fetch, names))
    if not os.path.exists(os.path.join(folder, "Launch.lua")) or sum(got) < 100:
        raise RuntimeError(f"PoB source download incomplete ({sum(got)} of {len(names)} files)")
    open(os.path.join(folder, ".prefetched"), "w").close()
    return folder


def pob_version(pob_dir):
    for p in (os.path.join(pob_dir, "manifest.xml"), os.path.join(pob_dir, "..", "manifest.xml")):
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                v = _version_from_manifest(f.read())
            if v:
                return v
    return None


def _wrapper_files(pob_dir, version):
    """HeadlessWrapper.lua and the files it dofile()s that an installed PoB doesn't ship (_SimpleGraphic.def.lua),
    from the GitHub tag matching the installed version, cached. Returns the folder holding them."""
    if os.path.exists(os.path.join(pob_dir, "HeadlessWrapper.lua")):
        return pob_dir
    folder = os.path.join(CACHE_DIR, f"pob-{version}")
    os.makedirs(folder, exist_ok=True)

    def get(name):
        dest = os.path.join(folder, name)
        if not os.path.exists(dest):
            try:
                data = _http(RAW.format(ref=f"v{version}", path="src/" + name))
            except urllib.error.HTTPError as e:
                raise RuntimeError(f"Couldn't get PoB's {name} for v{version} from GitHub ({e}). "
                                   "Update PoB, or set POB_DIR to a PoB source checkout's src folder.") from e
            with open(dest, "wb") as f:
                f.write(data)
        return dest
    with open(get("HeadlessWrapper.lua"), "rb") as f:
        text = f.read()
    for dep in re.findall(rb'dofile\("([^"]+)"\)', text):
        dep = dep.decode()
        if dep != "Launch.lua" and not os.path.exists(os.path.join(pob_dir, dep)):
            get(dep)
    return folder


# ---------------- Lua glue ----------------

# PoB 2.68+ uses compound assignment ("x += 1"), which only PoB's own patched LuaJIT accepts.
# Rewrite each one-statement line to "x = x + (1)" as the file loads.
_COMPOUND = re.compile(
    rb"(?m)^(?P<i>[ \t]*)(?P<t>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^\]\r\n()]+\])*)[ \t]*"
    rb"(?P<op>\.\.|[-+*/%^])=[ \t]*(?P<v>[^;\r\n]*?)[ \t]*(?P<eol>\r?)$")


def _fix_source(src):
    def sub(m):
        v = m.group("v")
        if not v or b"--" in v:
            return m.group(0)
        t = m.group("t")
        return m.group("i") + t + b" = " + t + b" " + m.group("op") + b" (" + v + b")" + m.group("eol")
    return _COMPOUND.sub(sub, bytes(src))


def _inflate(data):
    data = bytes(data)
    for wbits in (15, -15, 31):
        try:
            return zlib.decompress(data, wbits)
        except zlib.error:
            pass
    return None  # nil to Lua: PoB treats it as missing data


def _deflate(data):
    return zlib.compress(bytes(data), 9)


def _s(v):
    return v.decode("utf-8", "replace") if isinstance(v, bytes) else v


_PRELUDE = rb"""
local dir = pob_dir
package.path = dir .. "/?.lua;" .. dir .. "/lua/?.lua;" .. dir .. "/lua/?/init.lua;"
  .. dir .. "/../runtime/lua/?.lua;" .. dir .. "/../runtime/lua/?/init.lua"
package.cpath = ""
-- lua-utf8 is a native module for text boxes; headless never edits text.
package.preload["lua-utf8"] = function()
  return setmetatable({ next = function(s, i) i = (i or 0) + 1; if i > #s then return nil end; return i, s:byte(i) end },
    { __index = string })
end
local raw_open, raw_lines = io.open, io.lines
local function abs(p)
  if type(p) ~= "string" or p:match("^%a:[/\\]") or p:match("^[/\\]") then return p end
  return dir .. "/" .. p
end
-- Read a file; in source mode fetch it from GitHub the first time PoB asks for it.
local function ropen(path, mode)
  local full = abs(path)
  local f, err = raw_open(full, mode)
  if f or not py_fetch or type(full) ~= "string" then return f, err end
  local norm = full:gsub("\\", "/")
  if norm:sub(1, #dir + 1) ~= dir .. "/" then return f, err end
  if py_fetch(norm:sub(#dir + 2)) then return raw_open(full, mode) end
  return f, err
end
loadfile = function(path)
  local f, err = ropen(path, "rb")
  if not f then return nil, err end
  local src = f:read("*a"); f:close()
  return load(py_fix(src), "@" .. path)
end
table.insert(package.loaders, 2, function(name)
  local rel = name:gsub("%.", "/")
  for tpl in package.path:gmatch("[^;]+") do
    local p = tpl:gsub("%?", rel)
    local f = ropen(p, "rb")
    if f then f:close(); return assert(loadfile(p)) end
  end
  return nil
end)
-- Read-only: PoB never writes anything (settings, caches, builds) and can't run programs.
io.open = function(path, mode, ...)
  if mode and mode:find("[wa+]") then return nil, "read-only" end
  return ropen(path, mode or "r")
end
io.lines = function(path, ...)
  if path == nil then return raw_lines() end
  local f = ropen(path, "rb"); if f then f:close() end
  return raw_lines(abs(path), ...)
end
local raw_output = io.output
io.output = function(f) if f ~= nil then error("read-only", 2) end; return raw_output() end
io.popen = function() return nil, "disabled" end
os.execute = function() return nil end
os.remove = function() return nil, "read-only" end
os.rename = function() return nil, "read-only" end
os.exit = function() error("os.exit disabled", 2) end
io.read = function() return nil end
arg = {}
local console = {}
pob_console = console
local function quiet(fmt, ...) console[#console + 1] = string.format(fmt, ...) end
ConPrintf = quiet
print = function(...)
  local t = {}
  for i = 1, select("#", ...) do t[i] = tostring((select(i, ...))) end
  console[#console + 1] = table.concat(t, "\t")
end
dofile = function(path)
  local launch_file = path:match("Launch%.lua$") ~= nil
  if launch_file then
    GetScriptPath = function() return dir end
    GetRuntimePath = function() return dir end
    GetUserPath = function() return dir end
    GetWorkDir = function() return dir end
  end
  local file = path
  local f = ropen(path, "rb")
  if f then f:close() else file = wrapper_dir .. "/" .. path end
  local r = assert(loadfile(file))()
  if launch_file then
    Inflate = function(d) return py_inflate(d) end
    Deflate = function(d) return py_deflate(d) end
    ConPrintf = quiet
  end
  return r
end

-- Skill names a gem grants (Vaal gems grant two: "Vaal Molten Shell" and "Molten Shell"), and whether it's a support.
local function gem_names(gem)
  local gd = gem.gemData
  local t = { [gem.nameSpec or ""] = true }
  if gd then
    if gd.name then t[gd.name] = true end
    if gd.grantedEffect and gd.grantedEffect.name then t[gd.grantedEffect.name] = true end
    if gd.secondaryGrantedEffect and gd.secondaryGrantedEffect.name then t[gd.secondaryGrantedEffect.name] = true end
  end
  return t, gd and gd.grantedEffect and gd.grantedEffect.support
end

-- Groups that could be the main skill for `name`: enabled, in an active weapon set (not a swap the build
-- isn't using), with an enabled non-support gem granting that skill.
function pyx_main_candidates(name)
  local b = launch.main.modes.BUILD
  local out = {}
  for i, grp in ipairs(b.skillsTab.socketGroupList) do
    if grp.enabled ~= false and grp.slotEnabled ~= false then
      for _, gem in ipairs(grp.gemList or {}) do
        local names, support = gem_names(gem)
        if gem.enabled ~= false and not support and names[name] then
          out[#out + 1] = { index = i, label = grp.label or "", slot = grp.slot or "",
            fullDPS = grp.includeInFullDPS and true or false, current = (i == b.mainSocketGroup) }
          break
        end
      end
    end
  end
  return out
end

-- Make group i the main socket group and pick `name` inside it (a group can hold several active skills).
-- full=true also counts the group in Full DPS.
function pyx_set_main(i, name, full)
  local b = launch.main.modes.BUILD
  local grp = b.skillsTab.socketGroupList[i]
  b.mainSocketGroup = i
  if full then grp.includeInFullDPS = true end
  b.buildFlag = true
  runCallback("OnFrame")
  for k, s in ipairs(grp.displaySkillList or {}) do
    if s.activeEffect and s.activeEffect.grantedEffect.name == name then
      if grp.mainActiveSkill ~= k then
        grp.mainActiveSkill = k
        b.buildFlag = true
        runCallback("OnFrame")
      end
      break
    end
  end
end

-- Slots in the XML's active item set that PoB didn't take: unknown slot name, or an item it couldn't read.
-- Slots PoB hides (an abyssal socket the item doesn't have, swap slots when swap is off) are skipped: PoB
-- ignores them too.
function pyx_check_slots(want)
  local it = launch.main.modes.BUILD.itemsTab
  local bad = {}
  for name, id in pairs(want) do
    local s = it.slots[name]
    if not s then bad[#bad + 1] = "unknown slot '" .. name .. "'"
    elseif s.IsShown and not s:IsShown() then -- hidden slot, ignored by PoB
    elseif not it.items[id] then bad[#bad + 1] = name .. ": PoB couldn't read item " .. id .. " (dropped)"
    elseif s.selItemId ~= id then bad[#bad + 1] = name .. ": item " .. id .. " isn't equipped" end
  end
  return bad
end

-- Equipped flasks PoB doesn't apply: switch off and not kept up by something else (e.g. Mageblood).
function pyx_inactive_flasks()
  local b = launch.main.modes.BUILD
  local it, env = b.itemsTab, b.calcsTab.mainEnv
  local applied = env and env.flasks or {}
  local out = {}
  for i = 1, 5 do
    local s = it.slots["Flask " .. i]
    local item = s and s.selItemId and it.items[s.selItemId]
    if item and not applied[item] then out[#out + 1] = "Flask " .. i end
  end
  return out
end
"""


class Pob:
    """One headless PoB instance. Start-up takes a few seconds; reuse it for many builds."""

    def __init__(self, pob_dir=None, download=True):
        if _lj is None:
            raise RuntimeError("lupa isn't installed in this Python (pip install lupa); see references/tools.md")
        pob_dir = pob_dir or find_pob(download=download)
        if not pob_dir or not os.path.exists(os.path.join(pob_dir, "Launch.lua")):
            raise RuntimeError("No Path of Building found (installed app, POB_DIR, or GitHub download).")
        self.version = pob_version(pob_dir)
        self.dir = os.path.abspath(pob_dir).replace("\\", "/")
        self.source_mode = os.path.exists(os.path.join(pob_dir, ".prefetched"))
        self.issues = []
        self.L = _lj.LuaRuntime(unpack_returned_tuples=True, encoding=None, register_eval=False,
                                register_builtins=False)
        g = self.g = self.L.globals()
        g.pob_dir = self.dir.encode()
        g.py_fix = _fix_source
        g.py_inflate = _inflate
        g.py_deflate = _deflate
        if self.source_mode:
            g.py_fetch = _Fetcher(pob_dir, self.version)
            g.wrapper_dir = g.pob_dir
        else:
            g.wrapper_dir = _wrapper_files(pob_dir, self.version).replace("\\", "/").encode()
        self.L.execute(_PRELUDE)
        wrapper_path = (self.dir if self.source_mode else _s(g.wrapper_dir)) + "/HeadlessWrapper.lua"
        if self.source_mode:
            g.py_fetch("HeadlessWrapper.lua")
        with open(wrapper_path, "rb") as f:
            wrapper = f.read()
        self.L.execute(wrapper.replace(b'dofile("Launch.lua")', b'dofile(pob_dir .. "/Launch.lua")', 1))
        err = self._prompt_error()
        if err or g.launch is None or g.launch.main is None:
            raise RuntimeError("PoB didn't start: " + (err or self.console(5)))
        self.L.execute(b"launch.main.disableDevAutoSave = true")

    # ---- loading ----
    def console(self, last=20):
        c = self.g.pob_console
        n = len(c)
        return "\n".join(_s(c[i]) for i in range(max(1, n - last + 1), n + 1))

    def _prompt_error(self):
        launch = self.g.launch
        msg = launch.promptMsg if launch is not None else None
        if msg:
            launch.promptMsg = None
            return re.sub(r"\^x[0-9A-Fa-f]{6}|\^\d", "", _s(msg)).strip()
        return None

    def load_xml(self, xml_text, name="build"):
        """Load a build. Raises if PoB can't; self.issues lists equipped slots PoB didn't take."""
        if isinstance(xml_text, bytes):
            xml_text = xml_text.decode("utf-8")
        self.loaded = {"config": active_titles(xml_text).get("configSet")}
        self.g.loadBuildFromXML(xml_text.encode("utf-8"), name.encode())
        err = self._prompt_error()
        if err:
            raise RuntimeError("PoB couldn't load the build: " + err)
        want = _active_slot_items(xml_text)
        bad = self.g.pyx_check_slots(self.L.table_from({k.encode(): v for k, v in want.items()}))
        self.issues = [_s(bad[i]) for i in range(1, len(bad) + 1)] if bad else []
        return self

    def set_main_skill(self, gem, group=None, include_in_full_dps=False):
        """Make `gem` the measured skill. Candidates are enabled groups in an active weapon set holding the gem;
        the build's current main group wins, then groups already counted in Full DPS. When several still fit,
        this raises and names them: pass group=<index> (1-based, as listed). include_in_full_dps=True also counts
        the group in Full DPS (needed after a live import, where no group counts). Raises if PoB ends up
        measuring anything else."""
        cands = self.g.pyx_main_candidates(gem.encode())
        cands = [{_s(k): _s(v) for k, v in cands[i].items()} for i in range(1, len(cands) + 1)] if cands else []
        if group is not None:
            pick = [c for c in cands if c["index"] == group]
        else:
            pick = [c for c in cands if c["current"]] or [c for c in cands if c["fullDPS"]] or cands
        if not pick:
            raise ValueError(f"No enabled group in this loadout's active weapon set grants {gem!r}. A Vaal skill "
                             "needs the gem's Vaal part on; an item-granted skill needs its item equipped.")
        if len(pick) > 1:
            desc = "; ".join(f"group {c['index']} ({c['slot'] or 'no slot'}{', ' + c['label'] if c['label'] else ''})"
                             for c in pick)
            raise ValueError(f"{gem!r} is in several groups: {desc}. Choose one with group= / --main-group.")
        self.g.pyx_set_main(pick[0]["index"], gem.encode(), include_in_full_dps)
        got = self.main_skill()
        if got != gem:
            raise ValueError(f"Couldn't make {gem!r} the main skill (PoB measures {got!r}).")
        self.main_group = pick[0]["index"]
        return self

    def import_character(self, items_json, passives_json):
        """GGG character-window get-items and get-passive-skills JSON, imported the way PoB's own account-name
        import does it (including Animate Guardian gear). No config or spectres yet: see copy_config,
        copy_gem_settings and set_main_skill."""
        g = self.g
        g.items_json = items_json if isinstance(items_json, bytes) else items_json.encode()
        g.passives_json = passives_json if isinstance(passives_json, bytes) else passives_json.encode()
        self.L.execute(b"""
        local dkjson = require "dkjson"
        launch.main:SetMode("BUILD", false, "Imported character")
        runCallback("OnFrame")
        build = launch.main.modes.BUILD
        local it = dkjson.decode(items_json)
        local pa = dkjson.decode(passives_json)
        if type(it) ~= "table" or type(pa) ~= "table" then error("character JSON isn't an object (private profile?)") end
        local char = it.character or {}
        char.equipment = it.items
        char.guardian = it.guardian
        char.passives = pa
        char.jewels = pa.items
        build.importTab:ImportItemsAndSkills(char, true, true, false)
        build.importTab:ImportPassiveTreeAndJewels(char, true)
        runCallback("OnFrame")
        """)
        err = self._prompt_error()
        if err:
            raise RuntimeError("PoB couldn't import the character: " + err)
        self.loaded = {"config": None}
        self.issues = []
        return self

    def save_xml(self):
        return _s(self.L.eval(b"launch.main.modes.BUILD:SaveDB('headless')"))

    # ---- reading ----
    @property
    def build(self):
        return self.g.launch.main.modes[b"BUILD"]

    @staticmethod
    def _num(v):
        if isinstance(v, bool) or v is None:
            return v
        if isinstance(v, float):
            if v != v or v in (float("inf"), float("-inf")):
                return str(v)
            return round(v, 2) if abs(v) < 100 else round(v)
        return v

    def _pick(self, out, keys):
        res = {}
        for k in keys:
            v = out[k.encode()]
            if v is not None and not _lj.lua_type(v):
                res[k] = self._num(v)
        return res

    def _all(self, out):
        return dict(sorted((_s(k), self._num(v)) for k, v in out.items()
                           if isinstance(v, (int, float)) and not isinstance(v, bool)))

    def main_skill(self):
        try:
            return _s(self.L.eval(b"launch.main.modes.BUILD.calcsTab.mainEnv.player.mainSkill.activeEffect.grantedEffect.name"))
        except Exception:  # noqa: BLE001 - no main skill
            return None

    def warnings(self):
        lines = self.build.controls.warnings.lines
        return [re.sub(r"\^x[0-9A-Fa-f]{6}|\^\d", "", _s(v)) for _, v in sorted(lines.items())] if lines else []

    def stats(self, full=False):
        out = self.build.calcsTab.mainOutput
        res = {"mainSkill": self.main_skill(), "config": getattr(self, "loaded", {}).get("config"),
               "player": self._all(out) if full else self._pick(out, PLAYER_KEYS)}
        minion = out[b"Minion"]
        if minion is not None:
            res["minion"] = self._all(minion) if full else self._pick(minion, MINION_KEYS)
        res["warnings"] = self.warnings()
        if self.issues:
            res["loadIssues"] = self.issues
        flasks = self.g.pyx_inactive_flasks()
        if flasks and len(flasks):
            res["flasksNotApplied"] = [_s(flasks[i]) for i in range(1, len(flasks) + 1)]
        return res

    def info(self):
        return {"pobVersion": self.version, "treeVersion": _s(self.g.latestTreeVersion), "pobDir": self.dir,
                "mode": "source download" if self.source_mode else "local"}


# ---------------- XML helpers (text in, text out; parsed with ElementTree) ----------------

# PoB writes raw newlines inside attribute values (e.g. the Custom Modifiers config box) and its XML reader
# doesn't decode numeric entities. XML parsers turn raw newlines in attributes into spaces, so protect them
# going in and write them back raw coming out.
_WS_ENT = {"\r": "&#13;", "\n": "&#10;", "\t": "&#9;"}


def _protect_attr_ws(xml):
    def tag(m):
        return re.sub(r'"[^"]*"', lambda q: re.sub(r"[\r\n\t]", lambda c: _WS_ENT[c.group(0)], q.group(0)), m.group(0))
    return re.sub(r"<[^<>]+>", tag, xml)


def _parse(xml):
    if isinstance(xml, bytes):
        xml = xml.decode("utf-8")
    return ET.fromstring(_protect_attr_ws(xml).encode("utf-8"))


def _dump(root):
    text = ET.tostring(root, encoding="unicode")
    for ch, ent in _WS_ENT.items():
        text = text.replace(ent, ch).replace(ent.replace("&#9;", "&#09;"), ch)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + text


def _sets(root, parent, child):
    p = root.find(parent)
    if p is None:
        raise ValueError(f"no <{parent}> in this build")
    return p, p.findall(child)


def _active_set(root, parent, child, attr):
    """The active set element, or the parent itself for old files that have no sets."""
    p, sets = _sets(root, parent, child)
    if not sets:
        return p
    active = p.get(attr)
    for s in sets:
        if s.get("id") == active:
            return s
    raise ValueError(f"active {child} id {active!r} not found")


def _title(e):
    return e.get("title") or "Default"


def loadout_titles(xml):
    """Titles of tree specs, item sets, skill sets and config sets (untitled = 'Default', as PoB shows it)."""
    root = _parse(xml)
    out = {}
    for key, parent, child in (("specs", "Tree", "Spec"), ("itemSets", "Items", "ItemSet"),
                               ("skillSets", "Skills", "SkillSet"), ("configSets", "Config", "ConfigSet")):
        p = root.find(parent)
        out[key] = [_title(e) for e in p.findall(child)] if p is not None else []
    out["active"] = active_titles(xml)
    return out


def active_titles(xml):
    root = _parse(xml)
    res = {}
    tree = root.find("Tree")
    if tree is not None:
        specs = tree.findall("Spec")
        i = int(tree.get("activeSpec") or 1)
        if 1 <= i <= len(specs):
            res["spec"] = _title(specs[i - 1])
    for key, parent, child, attr in (("itemSet", "Items", "ItemSet", "activeItemSet"),
                                     ("skillSet", "Skills", "SkillSet", "activeSkillSet"),
                                     ("configSet", "Config", "ConfigSet", "activeConfigSet")):
        try:
            s = _active_set(root, parent, child, attr)
            res[key] = _title(s) if s.tag == child else "Default"
        except ValueError:
            pass
    return res


def _pick_by_title(sets, title, what):
    hits = [s for s in sets if _title(s) == title]
    if not hits:
        raise ValueError(f"no {what} titled {title!r}: {[_title(s) for s in sets]}")
    return hits[0]


def select_config(xml, title):
    root = _parse(xml)
    p, sets = _sets(root, "Config", "ConfigSet")
    p.set("activeConfigSet", _pick_by_title(sets, title, "config set").get("id"))
    return _dump(root)


def _links(title):
    """('Mapping', {'1','2'}) for a PoB linked title like 'Mapping {1,2}'; ids empty when unlinked."""
    m = re.search(r"\{([\w,]+)\}", title)
    if not m:
        return title.strip(), set()
    return re.sub(r"\{[\w,]+\}", "", title).strip(), set(m.group(1).split(","))


def _loadout_set(sets, title, what):
    """Set for a loadout, as PoB matches them: exact title, then a {id} link shared with the loadout's title,
    then the only set when there's just one (PoB shares a lone set across every loadout)."""
    exact = [s for s in sets if _title(s) == title]
    if exact:
        return exact[0]
    _, ids = _links(title)
    if ids:
        linked = [s for s in sets if _links(_title(s))[1] & ids]
        if linked:
            return linked[0]
    if len(sets) == 1:
        return sets[0]
    raise ValueError(f"no {what} for loadout {title!r}: {[_title(s) for s in sets]}")


def select_loadout(xml, title, config=None):
    """Activate the loadout `title`: the tree spec with that title plus the item set, skill set and config set PoB
    pairs with it (same title, a shared {id} link, or the only set of its kind). `config` picks a config set by
    title instead. Raises when a part is missing, rather than quietly measuring another loadout's config."""
    root = _parse(xml)
    tree, specs = _sets(root, "Tree", "Spec")
    spec = _pick_by_title(specs, title, "tree spec")
    tree.set("activeSpec", str(specs.index(spec) + 1))
    for parent, child, attr in (("Items", "ItemSet", "activeItemSet"), ("Skills", "SkillSet", "activeSkillSet")):
        p, sets = _sets(root, parent, child)
        if sets:
            p.set(attr, _loadout_set(sets, title, child).get("id"))
    p, sets = _sets(root, "Config", "ConfigSet")
    if sets:
        try:
            chosen = _pick_by_title(sets, config, "config set") if config else _loadout_set(sets, title, "config set")
        except ValueError as e:
            raise ValueError(f"{e}. Pass --config / config= to choose one explicitly.") from None
        p.set("activeConfigSet", chosen.get("id"))
    root.find("Build").attrib.pop("mainSkillIndex", None)
    return _dump(root)


def set_gem_enabled(xml, gem, enabled):
    """Turn every copy of a gem in the active skill set on or off (to see what it costs or adds)."""
    root = _parse(xml)
    gems = [g for g in _active_set(root, "Skills", "SkillSet", "activeSkillSet").iter("Gem")
            if g.get("nameSpec") == gem]
    if not gems:
        raise ValueError(f"{gem!r} isn't in the active skill set")
    for g in gems:
        g.set("enabled", "true" if enabled else "false")
    return _dump(root)


def _active_slot_items(xml):
    root = _parse(xml)
    try:
        s = _active_set(root, "Items", "ItemSet", "activeItemSet")
    except ValueError:
        return {}
    return {e.get("name"): int(e.get("itemId")) for e in s.findall("Slot")
            if e.get("name") and (e.get("itemId") or "0").isdigit() and int(e.get("itemId") or 0) > 0}


def equip(xml, slot, item_text, active=None):
    """Add an item (PoB item text, or an in-game Ctrl+C copy) and put it in `slot` of the active item set,
    e.g. "Weapon 2", "Helmet", "Ring 1", "Flask 3", "Helmet Abyssal Socket 1". Flasks are switched on unless
    active=False (PoB ignores a flask that's off). After Pob.load_xml, check pob.issues: PoB silently drops
    items it can't read and ignores unknown slot names."""
    root = _parse(xml)
    items = root.find("Items")
    new_id = max([int(i.get("id")) for i in items.findall("Item") if (i.get("id") or "").isdigit()] + [0]) + 1
    item = ET.Element("Item", {"id": str(new_id)})
    item.text = "\n" + item_text.strip().replace("\r\n", "\n") + "\n"
    sets = items.findall("ItemSet")
    items.insert(0 if not sets else list(items).index(sets[0]), item)
    s = _active_set(root, "Items", "ItemSet", "activeItemSet")
    slot_el = next((e for e in s.findall("Slot") if e.get("name") == slot), None)
    if slot_el is None:
        slot_el = ET.SubElement(s, "Slot", {"name": slot})
    slot_el.set("itemId", str(new_id))
    if active is None:
        active = slot.startswith("Flask")
    if active:
        slot_el.set("active", "true")
    else:
        slot_el.attrib.pop("active", None)
    return _dump(root)


def copy_config(dst_xml, src_xml, src_title=None):
    """Replace dst's active config with src's config set (by title, or src's active one), plus the bandit and
    pantheon choices, so builds are compared on the same assumptions."""
    src, dst = _parse(src_xml), _parse(dst_xml)
    if src_title:
        _, sets = _sets(src, "Config", "ConfigSet")
        s = _pick_by_title(sets, src_title, "config set")
    else:
        s = _active_set(src, "Config", "ConfigSet", "activeConfigSet")
    d = _active_set(dst, "Config", "ConfigSet", "activeConfigSet")
    keep = {k: v for k, v in d.attrib.items() if k in ("id", "title")} if d.tag == "ConfigSet" else dict(d.attrib)
    for child in list(d):
        d.remove(child)
    for child in s:
        if s.tag == "ConfigSet" or child.tag != "ConfigSet":
            d.append(child)
    if d.tag == "ConfigSet":
        d.attrib.clear()
        d.attrib.update({**{k: v for k, v in s.attrib.items() if k not in ("id", "title")}, **keep})
    sb, db = src.find("Build"), dst.find("Build")
    for a in ("bandit", "pantheonMajorGod", "pantheonMinorGod"):
        if sb.get(a) is not None:
            db.set(a, sb.get(a))
    return _dump(dst)


# Per-gem choices GGG's character data doesn't carry. Item-set ids (skillMinionItemSet) aren't copied: they
# point at the source file's item sets.
GEM_SETTINGS = ("count", "skillMinion", "skillMinionCalcs", "skillMinionSkill", "skillMinionSkillCalcs",
                "skillPart", "skillPartCalcs", "skillStageCount", "skillStageCountCalcs",
                "skillMineCount", "skillMineCountCalcs", "enableGlobal1", "enableGlobal2")


def copy_gem_settings(dst_xml, src_xml, src_loadout=None):
    """Copy spectre/minion choices, gem counts, skill parts and Vaal-part switches from src's skill set (by loadout
    title, or its active one) onto dst's active skill set, plus each group's Full DPS flag and src's spectre
    library. Groups are paired by item slot and gem, like PoB's own re-import, so two Raise Spectre groups
    keep their own spectres. Use after a live-character import."""
    src, dst = _parse(src_xml), _parse(dst_xml)
    if src_loadout:
        _, sets = _sets(src, "Skills", "SkillSet")
        ss = _pick_by_title(sets, src_loadout, "skill set")
    else:
        ss = _active_set(src, "Skills", "SkillSet", "activeSkillSet")

    def key(grp, gem_name):
        return (grp.get("slot") or "", gem_name)
    by_key, by_name = {}, {}
    for grp in ss.findall("Skill"):
        for g in grp.findall("Gem"):
            n = g.get("nameSpec")
            if n:
                opts = {a: g.get(a) for a in GEM_SETTINGS if g.get(a) not in (None, "nil")}
                by_key.setdefault(key(grp, n), (grp, opts))
                by_name.setdefault(n, []).append((grp, opts))
    seen = {}
    for grp in _active_set(dst, "Skills", "SkillSet", "activeSkillSet").findall("Skill"):
        src_grp = None
        for g in grp.findall("Gem"):
            n = g.get("nameSpec")
            if not n:
                continue
            hit = by_key.get(key(grp, n))
            if hit is None and n in by_name:
                k = seen.get(n, 0)
                seen[n] = k + 1
                hit = by_name[n][min(k, len(by_name[n]) - 1)]
            if hit is None:
                continue
            if src_grp is None:
                src_grp = hit[0]
            for a, v in hit[1].items():
                g.set(a, v)
        if src_grp is not None and src_grp.get("includeInFullDPS") == "true":
            grp.set("includeInFullDPS", "true")
    db = dst.find("Build")
    have = {e.get("id") for e in db.findall("Spectre")}
    for e in src.find("Build").findall("Spectre"):
        if e.get("id") not in have:
            db.insert(0, ET.Element("Spectre", {"id": e.get("id")}))
            have.add(e.get("id"))
    return _dump(dst)


# ---------------- command line ----------------

def _prepare(xml, args):
    if args.loadout:
        xml = select_loadout(xml, args.loadout, args.config)
    elif args.config:
        xml = select_config(xml, args.config)
    return xml


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _measure(pob, xml, args):
    pob.load_xml(xml)
    if args.main_skill:
        pob.set_main_skill(args.main_skill, group=args.main_group)
    return pob.stats(full=args.all)


def _compare(a, b):
    def flat(s):
        d = {"player." + k: v for k, v in s["player"].items()}
        d.update({"minion." + k: v for k, v in s.get("minion", {}).items()})
        return d
    fa, fb = flat(a), flat(b)
    rows = []
    for k in list(dict.fromkeys(list(fa) + list(fb))):
        va, vb = fa.get(k), fb.get(k)
        if va == vb:
            continue
        pct = None
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)) and va:
            pct = round((vb - va) / abs(va) * 100, 1)
        rows.append({"stat": k, "a": va, "b": vb, "changePct": pct})
    meta = ("mainSkill", "config", "warnings", "loadIssues")
    return {"a": {k: a.get(k) for k in meta if a.get(k) is not None},
            "b": {k: b.get(k) for k in meta if b.get(k) is not None}, "changed": rows}


def main():
    if _lj is None:
        if os.path.exists(VENV_PY) and os.path.abspath(sys.executable).lower() != os.path.abspath(VENV_PY).lower():
            sys.exit(subprocess.call([VENV_PY] + sys.argv))
        sys.exit("lupa isn't installed. Run: pip install lupa   (on Andy's PC: see references/tools.md)")
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    ap = argparse.ArgumentParser(description="Headless Path of Building Community")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info")
    p = sub.add_parser("titles")
    p.add_argument("xml")
    for name in ("stats", "compare"):
        p = sub.add_parser(name)
        p.add_argument("xml", nargs=1 if name == "stats" else 2)
        p.add_argument("--loadout")
        p.add_argument("--config", help="config set title, when it differs from the loadout title")
        p.add_argument("--main-skill")
        p.add_argument("--main-group", type=int, help="group index when the main skill is in several groups")
        p.add_argument("--all", action="store_true", help="every numeric output, not just the headline")
    p = sub.add_parser("character")
    p.add_argument("items")
    p.add_argument("passives")
    p.add_argument("--config-from", help="BUILD.xml or BUILD.xml::CONFIG TITLE")
    p.add_argument("--gems-from", help="BUILD.xml or BUILD.xml::LOADOUT: spectres, minion counts, skill parts")
    p.add_argument("--main-skill")
    p.add_argument("--main-group", type=int)
    p.add_argument("--save", help="write the imported build as PoB XML")
    p.add_argument("--all", action="store_true")
    args = ap.parse_args()

    if args.cmd == "titles":
        print(json.dumps(loadout_titles(_read(args.xml)), indent=1))
        return

    def src_arg(v):
        if not v:
            return None
        f, _, t = v.partition("::")
        return f, t or None

    pob = Pob()
    if args.cmd == "info":
        print(json.dumps(pob.info(), indent=1))
    elif args.cmd == "stats":
        print(json.dumps(_measure(pob, _prepare(_read(args.xml[0]), args), args), indent=1))
    elif args.cmd == "compare":
        res = [_measure(pob, _prepare(_read(p), args), args) for p in args.xml]
        print(json.dumps(_compare(*res), indent=1))
    elif args.cmd == "character":
        with open(args.items, "rb") as f1, open(args.passives, "rb") as f2:
            pob.import_character(f1.read(), f2.read())
        xml = pob.save_xml()
        cfg_from, gems_from = src_arg(args.config_from), src_arg(args.gems_from)
        if cfg_from:
            xml = copy_config(xml, _read(cfg_from[0]), cfg_from[1])
        if gems_from:
            xml = copy_gem_settings(xml, _read(gems_from[0]), gems_from[1])
        if cfg_from or gems_from:
            pob.load_xml(xml)
            pob.loaded["config"] = f"from {os.path.basename(cfg_from[0])}" + (f"::{cfg_from[1]}" if cfg_from and cfg_from[1] else "") if cfg_from else None
        if args.main_skill:
            # A live import counts no group in Full DPS; count the main one unless --gems-from supplied flags.
            pob.set_main_skill(args.main_skill, group=args.main_group, include_in_full_dps=True)
        if args.save:
            with open(args.save, "w", encoding="utf-8") as f:
                f.write(pob.save_xml())
        print(json.dumps(pob.stats(full=args.all), indent=1))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as e:
        sys.exit(f"error: {e}")
