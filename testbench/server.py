#!/usr/bin/env python3
"""Meghan testbench: serves the chat UI and proxies /sim to the deployed
worker (avoids CORS). Usage: python3 server.py [port]  (default 8788)."""
import http.server, json, urllib.request, sys, os

WORKER = "https://gbt-meghan.gobluetours.workers.dev/debug/simulate"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class H(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/sim":
            self.send_error(404); return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        req = urllib.request.Request(WORKER, data=body,
            headers={"Content-Type": "application/json",
                     "User-Agent": "Mozilla/5.0 meghan-testbench"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
                self.send_response(200)
        except urllib.error.HTTPError as e:
            data = e.read(); self.send_response(e.code)
        except Exception as e:
            data = json.dumps({"ok": False, "reply": None, "error": str(e)}).encode()
            self.send_response(502)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass  # quiet

print(f"Meghan testbench → http://localhost:{PORT}  (worker: {WORKER})")
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
