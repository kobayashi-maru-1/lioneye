"""lioneye-notebook: a local MCP server (stdio) that gives Claude Desktop chats the build lab's notebook.

Claude Desktop starts it from claude_desktop_config.json (install-notebook-mcp.ps1 adds the entry). It runs on
this PC, in the Lioneye clone, with the PC's own git login: public entries commit and push to main straight away
(build-lab/notebook/notebook.py does the git work without touching the working tree); preferences and feedback
stay in the git-ignored local folder.

Python standard library only. Protocol: JSON-RPC 2.0, one message per line on stdin/stdout; logs go to stderr.
"""
import contextlib
import json
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "notebook"))
import notebook as N  # noqa: E402

PROTOCOL = "2025-06-18"
SUPPORTED = ("2024-11-05", "2025-03-26", "2025-06-18")  # this server uses only tools, the same in all three
SERVER = {"name": "lioneye-notebook", "version": "0.1.0"}
INSTRUCTIONS = (
    "The PoE build lab's notebook: tried build concepts, interactions, PoB blind spots, and Andy's preferences "
    "and play feedback. Search it before designing a build; record what a design session found. Public kinds "
    "(concept, interaction, blind-spot) are pushed to the public Lioneye repo at once: never put account or "
    "character names, or other personal details, in them. Preferences and feedback stay on this PC.")

ENTRY = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": list(N.KINDS)},
        "title": {"type": "string", "description": "one line"},
        "body": {"type": "string", "description": "what was found or tried, in a few sentences"},
        "evidence": {"type": "string", "description": "PoB numbers, test or source behind it (required for "
                                                      "interaction and blind-spot)"},
        "verdict": {"type": "string", "enum": list(N.VERDICTS), "description": "concepts only"},
        "numbers": {"type": "object", "description": "concepts: dps, ehp, life, es, cost, novelty, ..."},
        "spec": {"type": "object", "description": "concepts: the concept spec (design/concept.py)"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "refs": {"type": "array", "items": {"type": "string"}, "description": "related entry ids"},
        "build": {"type": "string", "description": "feedback: which build or character"},
    },
    "required": ["kind", "title", "body"],
}

TOOLS = [
    {"name": "notebook_search",
     "description": "Search the notebook. Ranked by weight (confirmed findings first), then match. Entries not "
                    "confirmed on the current patch carry a 'recheck' note.",
     "inputSchema": {"type": "object", "properties": {
         "query": {"type": "string"}, "kind": {"type": "string", "enum": list(N.KINDS)},
         "tag": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}}}},
    {"name": "notebook_show",
     "description": "One entry with all its fields and the checks made on it.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "notebook_add",
     "description": "Record entries. Public kinds are committed and pushed to the Lioneye repo now; preference "
                    "and feedback stay on this PC. Returns the new ids.",
     "inputSchema": {"type": "object", "properties": {"entries": {"type": "array", "items": ENTRY, "minItems": 1}},
                     "required": ["entries"]}},
    {"name": "notebook_check",
     "description": "Record a re-test of an entry: holds (weight up) or contradicted (weight down).",
     "inputSchema": {"type": "object", "properties": {
         "id": {"type": "string"}, "result": {"type": "string", "enum": list(N.RESULTS)},
         "evidence": {"type": "string"}}, "required": ["id", "result", "evidence"]}},
    {"name": "notebook_recheck",
     "description": "Entries not yet confirmed on the current patch.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "notebook_sync",
     "description": "Push entries that were queued while GitHub couldn't be reached.",
     "inputSchema": {"type": "object", "properties": {}}},
]


def call(name, args):
    nb = N.Notebook()
    if name == "notebook_search":
        return [N._brief(e) for e in nb.search(args.get("query"), args.get("kind"), args.get("tag"),
                                                int(args.get("limit") or 20))]
    if name == "notebook_show":
        return nb.show(args["id"])
    if name == "notebook_add":
        return nb.add(args["entries"], source="desktop")
    if name == "notebook_check":
        return nb.add([{"kind": "check", "ref": args["id"], "result": args["result"],
                        "evidence": args.get("evidence")}], source="desktop")
    if name == "notebook_recheck":
        return [N._brief(e) for e in nb.recheck()]
    if name == "notebook_sync":
        return nb.sync()
    raise KeyError(name)


def handle(msg):
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None  # a notification (initialized, cancelled, ...): nothing to answer
    if method == "initialize":
        asked = (msg.get("params") or {}).get("protocolVersion")
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": asked if asked in SUPPORTED else PROTOCOL, "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER, "instructions": INSTRUCTIONS}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        p = msg.get("params") or {}
        name = p.get("name")
        if name not in {t["name"] for t in TOOLS}:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"unknown tool {name}"}}
        try:
            with contextlib.redirect_stdout(sys.stderr):  # stdout carries only protocol messages
                out = call(name, p.get("arguments") or {})
            return {"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": json.dumps(out, indent=1, ensure_ascii=False)}]}}
        except (ValueError, RuntimeError, OSError, KeyError, TypeError, AttributeError) as e:  # bad input too
            return {"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": f"error: {e}"}], "isError": True}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"no method {method}"}}


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    print(f"{SERVER['name']} {SERVER['version']} ready", file=sys.stderr, flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            reply = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
        else:
            try:
                reply = handle(msg) if isinstance(msg, dict) else {
                    "jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "batches aren't supported"}}
            except Exception as e:  # noqa: BLE001 - keep serving
                traceback.print_exc(file=sys.stderr)
                reply = {"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32603, "message": str(e)}}
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
