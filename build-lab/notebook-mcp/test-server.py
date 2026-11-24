"""Protocol checks for the lioneye-notebook MCP server: starts it as Claude Desktop would (stdio) and talks to it.

  python test-server.py

Read-only against the real notebook (a search and a refused add); nothing is written or pushed.
Exit code 1 when any check fails.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    p = subprocess.Popen([sys.executable, os.path.join(HERE, "server.py")], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
    results = []

    def send(msg, reply=True):
        p.stdin.write(json.dumps(msg) + "\n")
        p.stdin.flush()
        return json.loads(p.stdout.readline()) if reply else None

    def add(name, ok, detail=""):
        results.append(ok)
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))

    try:
        r = send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                  "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t"}}})
        add("initialize", r["result"]["serverInfo"]["name"] == "lioneye-notebook"
            and "tools" in r["result"]["capabilities"], r)
        send({"jsonrpc": "2.0", "method": "notifications/initialized"}, reply=False)
        r = send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = {t["name"] for t in r["result"]["tools"]}
        add("tools listed", {"notebook_search", "notebook_add", "notebook_check", "notebook_show"} <= names, names)
        r = send({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                  "params": {"name": "notebook_search", "arguments": {"query": "trigger", "limit": 5}}})
        text = r["result"]["content"][0]["text"]
        add("search answers", not r["result"].get("isError") and isinstance(json.loads(text), list), text[:200])
        r = send({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                  "params": {"name": "notebook_add", "arguments": {"entries": [
                      {"kind": "blind-spot", "title": "test", "body": "no evidence"}]}}})
        add("bad entry refused as a tool error", r["result"].get("isError")
            and "evidence" in r["result"]["content"][0]["text"], r)
        r = send({"jsonrpc": "2.0", "id": 5, "method": "nope"})
        add("unknown method", r.get("error", {}).get("code") == -32601, r)
        r = send({"jsonrpc": "2.0", "id": 6, "method": "ping"})
        add("ping", r.get("result") == {}, r)
    finally:
        p.stdin.close()
        p.wait(timeout=30)
    print(f"\n{sum(results)}/{len(results)} passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
