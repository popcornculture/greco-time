#!/usr/bin/env python3
"""Local rig for Greco Time.

Two servers on two ports on purpose: the real app talks to Apps Script cross-origin, and
serving the mock endpoint same-origin would hide every CORS mistake until a phone found it.

  http://localhost:8765/              the app
  http://localhost:8765/harness.html  390px / 320px side by side
  http://localhost:8766/exec          mock endpoint, PIN 1234
  http://localhost:8766/_fail?on      make the network fail, to exercise the queue
  http://localhost:8766/_dump         what the "sheet" received
"""
import json, os, threading, http.server, socketserver, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, '..', '..', 'docs')

SHEET = {'entries': [], 'expenses': []}
FAIL = {'on': False}

CLIENTS = [
    {'name': 'Maria Ramirez', 'matterType': 'Criminal'},
    {'name': 'People vs Aaron', 'matterType': 'Criminal'},
    {'name': 'Richards, Aaron', 'matterType': 'Civil'},
    {'name': 'abel maya', 'matterType': 'Family'},
    {'name': 'Clara Benson', 'matterType': 'Family'},
    {'name': 'Artesia Holdings LLC', 'matterType': 'Civil'},
    {'name': 'Ashford, Daniel PETITION FOR APPOINTMENT OF PROBATE CONSERVATOR',
     'matterType': 'Conservatorship'},
]

# Shaped exactly like Calendar.gs returns, including a title that matches no client and
# one that names the case only in the location.
EVENTS = [
    {'id': 'ev1', 'title': 'Hearing re Maria Ramirez', 'hours': 1.3, 'minutes': 78,
     'start': '9:00 AM', 'end': '10:18 AM', 'startMs': 1, 'location': 'Dept 5'},
    {'id': 'ev2', 'title': 'Call w/ DA', 'hours': 0.5, 'minutes': 30,
     'start': '11:00 AM', 'end': '11:30 AM', 'startMs': 2, 'location': ''},
    {'id': 'ev3', 'title': 'Status conference', 'hours': 0.8, 'minutes': 48,
     'start': '1:30 PM', 'end': '2:18 PM', 'startMs': 3,
     'location': 'Dept 2 — Clara Benson'},
    {'id': 'ev4', 'title': 'Ashford conservatorship review', 'hours': 2.0, 'minutes': 120,
     'start': '3:00 PM', 'end': '5:00 PM', 'startMs': 4, 'location': ''},
]


class App(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DOCS, **kw)

    def do_GET(self):
        if self.path.startswith('/harness.html'):
            body = open(os.path.join(HERE, 'harness.html'), 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass


class Api(http.server.BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        # Apps Script answers a simple cross-origin POST with this and nothing else.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/_fail':
            FAIL['on'] = 'on' in u.query
            return self._json({'failing': FAIL['on']})
        if u.path == '/_dump':
            return self._json(SHEET)
        if u.path == '/_reset':
            SHEET['entries'] = []
            SHEET['expenses'] = []
            return self._json({'ok': True})
        return self._json({'ok': True, 'msg': 'POST only'})

    def do_POST(self):
        if FAIL['on']:
            self.close_connection = True
            return
        n = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(n) or b'{}')

        if str(body.get('pin')) != '1234':
            return self._json({'ok': False, 'error': 'Wrong PIN.'})

        action = body.get('action')
        if action == 'verify':
            return self._json({'ok': True, 'timekeepers': [
                {'name': 'Paul Greco', 'isTest': False},
                {'name': 'Staff', 'isTest': False},
                {'name': 'Alex (testing)', 'isTest': True}]})
        if action == 'clients':
            return self._json({'ok': True, 'clients': CLIENTS})
        if action == 'calendar':
            return self._json({'ok': True, 'events': EVENTS, 'calendarId': 'primary'})
        if action == 'entries':
            accepted = []
            for e in (body.get('payload') or {}).get('entries') or []:
                accepted.append(e.get('uuid'))
                bucket = 'expenses' if e.get('kind') == 'expense' else 'entries'
                if not any(x.get('uuid') == e.get('uuid') for x in SHEET[bucket]):
                    SHEET[bucket].append(e)
            return self._json({'ok': True, 'accepted': accepted, 'rejected': []})
        return self._json({'ok': False, 'error': 'Unknown action.'})

    def log_message(self, *a):
        pass


class Threaded(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    a = Threaded(('127.0.0.1', 8765), App)
    b = Threaded(('127.0.0.1', 8766), Api)
    threading.Thread(target=b.serve_forever, daemon=True).start()
    print('app  http://localhost:8765/')
    print('rig  http://localhost:8765/harness.html')
    print('api  http://localhost:8766/exec  (PIN 1234)')
    a.serve_forever()
