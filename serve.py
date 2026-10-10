#!/usr/bin/env python3
"""Static server for Breathe. Usage: serve.py [port] (default 8968, loopback only).
Sends no-cache so phones pick up new versions; expose via `tailscale serve` for HTTPS."""
import functools, http.server, os, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8968
root = os.path.dirname(os.path.abspath(__file__))
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=root)).serve_forever()
