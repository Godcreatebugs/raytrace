"""Loopback-only, read-only evidence viewer, forwarded by Lima to the Mac."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
from urllib.parse import urlparse, parse_qs

def event_page(db, query):
    container = query.get('container', [''])[0]
    before = int(query.get('before', ['0'])[0])
    # `after` is the tailing cursor used by the RayTrace proxy's gVisor
    # forwarder: events with id > after, oldest first, so a poller can
    # advance through the log without gaps. `before` (the UI's "older
    # events" paging, newest first) still works on its own; `after` wins
    # when both are given.
    after = int(query.get('after', ['0'])[0])
    limit = min(500, max(1, int(query.get('limit', ['100'])[0])))
    clauses, params = [], []
    if container:
        clauses.append('container_id = ?'); params.append(container)
    if after:
        clauses.append('id > ?'); params.append(after)
    elif before:
        clauses.append('id < ?'); params.append(before)
    if query.get('processes', [''])[0] == '1':
        clauses.append("kind IN ('exec_succeeded','process_exit','collection_gap','collection_error')")
    where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
    order = 'ASC' if after else 'DESC'
    rows = db.execute('SELECT id,body FROM runtime_events'+where+' ORDER BY id '+order+' LIMIT ?', (*params, limit+1)).fetchall()
    events = []
    for identifier, body in rows[:limit]:
        event=json.loads(body); event.pop('raw_packet_base64',None)
        event['event_id']=identifier; events.append(event)
    page = {'events':events,'next_before':None if after else (rows[limit-1][0] if len(rows)>limit else None)}
    if after:
        page['next_after'] = rows[limit-1][0] if len(rows) > limit else None
    return page

PAGE = '''<!doctype html><meta charset="utf-8"><title>RayTrace runtime evidence</title>
<style>body{font:15px system-ui;background:#111827;color:#e5e7eb;margin:32px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid #374151}code{white-space:pre-wrap}select{padding:8px} .note{color:#fbbf24}</style>
<h1>Runtime evidence</h1><p>Independent gVisor process events. Select a sandbox to inspect its timeline.</p>
<p class="note">Coverage: selected process events only. Missing evidence is not proof of non-execution. Disconnects do not certify completeness.</p>
<select id="jobs"><option value="">All sandboxes and collector health</option></select><p id="status"></p>
<table><thead><tr><th>Event</th><th>PID / parent</th><th>Executable / arguments / result</th></tr></thead><tbody id="events"></tbody></table>
<script>
const select=document.getElementById('jobs');
async function refresh(){try{const response=await fetch('/events');if(!response.ok)throw Error('Collector unavailable');const data=await response.json();
const chosen=select.value;select.replaceChildren(new Option('All sandboxes and collector health',''));for(const id of data.containers)select.add(new Option(id.slice(0,16),id));select.value=chosen;
const rows=data.events.filter(e=>!select.value||e.container_id===select.value);
document.getElementById('status').textContent='Latest '+rows.length+' events (up to 500). '+data.gaps+' recorded collection errors/gaps.';
const body=document.getElementById('events');body.replaceChildren();for(const e of rows){const {raw_packet_base64,...detail}=e;const tr=document.createElement('tr');for(const v of [e.kind,`${e.pid??'—'} / ${e.ppid??'—'}`,JSON.stringify(detail)]){const td=document.createElement('td');const code=document.createElement('code');code.textContent=v;td.append(code);tr.append(td);}body.append(tr);}
}catch(e){document.getElementById('status').textContent=e.message;}}
select.onchange=refresh;refresh();setInterval(refresh,1500);
</script>'''


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get('Host', '').split(':')[0] not in ('localhost', '127.0.0.1'):
            self.send_error(403)
            return
        if self.path == '/':
            body, mime = PAGE.encode(), 'text/html; charset=utf-8'
        elif urlparse(self.path).path == '/events':
            try:
                with sqlite3.connect('file:/var/lib/raytace/runtime.db?mode=ro', uri=True) as db:
                    page = event_page(db, parse_qs(urlparse(self.path).query))
                    containers = [r[0] for r in db.execute("SELECT DISTINCT container_id FROM runtime_events WHERE container_id != ''")]
                    gaps = db.execute("SELECT COUNT(*) FROM runtime_events WHERE kind IN ('collection_error','collection_gap')").fetchone()[0]
                body = json.dumps({**page, 'containers': containers, 'gaps': gaps, 'coverage':'Selected process events; completeness not certified'}).encode()
                mime = 'application/json'
            except (sqlite3.Error, ValueError):
                self.send_error(503, 'Evidence database unavailable')
                return
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8798), Handler).serve_forever()
