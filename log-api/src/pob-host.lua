-- Starts Path of Building's own headless mode (HeadlessWrapper.lua) inside exile-leveling.exe
-- and answers stat requests from the guide. Set by the exe before this runs:
--   host_dir        the unpacked PoB folder (forward slashes)
--   host_log(line)  writes a line to the exe's log

local dir = host_dir

-- PoB opens files relative to its own folder; the exe's working folder is elsewhere.
local function abs(path)
	if type(path) ~= "string" or path:match("^%a:[/\\]") or path:match("^[/\\]") then
		return path
	end
	return dir .. "/" .. path
end

local raw = {
	loadfile = loadfile,
	open = io.open,
	lines = io.lines,
	remove = os.remove,
	rename = os.rename,
}
loadfile = function(path, ...) return raw.loadfile(abs(path), ...) end
io.open = function(path, ...) return raw.open(abs(path), ...) end
io.lines = function(path, ...)
	if path == nil then return raw.lines() end
	return raw.lines(abs(path), ...)
end
os.remove = function(path) return raw.remove(abs(path)) end
os.rename = function(from, to) return raw.rename(abs(from), abs(to)) end
-- No console to read from.
io.read = function() return nil end
-- The standalone interpreter's command-line table; PoB reads arg[1] as a build link to open.
arg = {}

local lastLine = ""
print = function(...)
	local parts = {}
	for i = 1, select("#", ...) do
		parts[i] = tostring((select(i, ...)))
	end
	lastLine = table.concat(parts, "\t")
	host_log(lastLine)
end

package.path = dir .. "/?.lua;" .. dir .. "/lua/?.lua;" .. dir .. "/lua/?/init.lua"
package.cpath = ""

-- PoB's text boxes use lua-utf8, a native module. Headless never edits text,
-- so byte-wise string functions stand in for it.
package.preload["lua-utf8"] = function()
	return setmetatable({
		next = function(s, i)
			i = (i or 0) + 1
			if i > #s then return nil end
			return i, s:byte(i)
		end,
	}, { __index = string })
end

dofile = function(path)
	if path == "Launch.lua" then
		-- HeadlessWrapper defines these just before it starts PoB; point them at PoB's folder.
		GetScriptPath = function() return dir end
		GetRuntimePath = function() return dir end
		GetUserPath = function() return dir end
		GetWorkDir = function() return dir end
	end
	local chunk = assert(raw.loadfile(abs(path)))
	return chunk()
end

dofile("HeadlessWrapper.lua")
if build == nil then
	error("Path of Building didn't start: " .. lastLine)
end

local json = require("dkjson")
local ARRAY = { __jsontype = "array" }
local SKIP = "^%^7%^7" -- PoB's own entries in the loadout list ("Loadouts:", "New Loadout", ...)

-- Only the latest tree ships with the exe; specs on an older tree load on the latest one.
local function hasTree(version)
	local file = raw.open(abs("TreeData/" .. version .. "/tree.lua"), "r")
	if file then
		file:close()
		return true
	end
	return false
end

local function onBundledTrees(xml)
	return (xml:gsub('treeVersion="([%w_]+)"', function(version)
		if version ~= latestTreeVersion and not hasTree(version) then
			return 'treeVersion="' .. latestTreeVersion .. '"'
		end
	end))
end

local function loadoutControl()
	return build.controls.buildLoadouts
end

local function loadouts()
	local names = setmetatable({}, ARRAY)
	for _, value in ipairs(loadoutControl().list) do
		if not value:match(SKIP) and value ~= "No Loadouts" then
			names[#names + 1] = value
		end
	end
	return names
end

local function currentLoadout()
	local control = loadoutControl()
	local value = control.list[control.selIndex]
	if value == nil or value:match(SKIP) or value == "No Loadouts" then
		return nil
	end
	return value
end

-- Same as picking the loadout in PoB's dropdown.
local function selectLoadout(name)
	local control = loadoutControl()
	for index, value in ipairs(control.list) do
		if value == name then
			control.selFunc(index, value)
			runCallback("OnFrame")
			return currentLoadout() == name
		end
	end
	return false
end

-- PoB's sidebar: { label, value } rows, single-text rows (headers, notes) and gaps.
local function rows()
	local out = setmetatable({}, ARRAY)
	for _, line in ipairs(build.controls.statBox.list) do
		if line[1] == nil then
			out[#out + 1] = { gap = true }
		elseif line[2] == nil then
			out[#out + 1] = { text = line[1] }
		else
			out[#out + 1] = { label = line[1], value = line[2] }
		end
	end
	return out
end

local function warnings()
	local out = setmetatable({}, ARRAY)
	for _, line in ipairs(build.controls.warnings.lines or {}) do
		out[#out + 1] = line
	end
	return out
end

local loadedXml

-- Called by the exe: stats for `loadout` (nil: the loadout the build was saved on), as JSON.
function host_stats(xml, loadout)
	if xml ~= loadedXml then
		loadedXml = nil
		loadBuildFromXML(onBundledTrees(xml), "Guide")
		loadedXml = xml
	end
	if loadout ~= nil and loadout ~= currentLoadout() and not selectLoadout(loadout) then
		error("Loadout not found: " .. loadout)
	end
	return json.encode({
		loadouts = loadouts(),
		loadout = currentLoadout(),
		rows = rows(),
		warnings = warnings(),
	})
end
