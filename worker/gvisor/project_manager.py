"""Mac-side project import and loopback lifecycle UI; stdlib only."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import tarfile
import tempfile
import threading
import time
import uuid
import project_broker

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / '.raytace' / 'projects'
VM = 'raytace-gvisor'
LOCK = threading.Lock()
EXCLUDED = {'.git', '.raytace', '.ssh', '.aws', '.azure', '.config', 'node_modules', '.venv',
            '__pycache__', '.next', '.vinext', 'dist', 'coverage', '.wrangler', '.DS_Store'}

def allowed(path):
    p = Path(path)
    return not any(part in EXCLUDED for part in p.parts) and not (
        p.name.startswith('.env') or p.suffix.lower() in {'.pem', '.key', '.p12', '.pfx'} or
        p.name in {'.npmrc', '.netrc', '.pypirc', 'credentials', 'auth.json', 'id_rsa', 'id_ed25519'})

def worker(action, *args, interactive=False):
    command = ['limactl', 'shell', VM, 'sudo', 'python3', '/opt/raytace/projects.py', action, *args]
    if interactive:
        return subprocess.run(command, check=True)
    return subprocess.check_output(command, text=True, stderr=subprocess.PIPE, timeout=90).strip()

def save(record):
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = STATE / (record['id']+'.json')
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(record, indent=2))
    temp.chmod(0o600)
    temp.replace(target)

def record_for(sid):
    import re
    if not re.fullmatch(r'rtp-[a-f0-9]{32}', sid):
        raise ValueError('Invalid sandbox ID')
    return json.loads((STATE / (sid+'.json')).read_text())

def snapshot(repo, archive):
    # Git identifies tracked and nonignored files; no hooks or project code run.
    listing = subprocess.check_output(['git', '-C', str(repo), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    manifest, skipped, total = {}, [], 0
    with tarfile.open(archive, 'w:gz') as tar:
        for name in sorted(set(os.fsdecode(x) for x in listing.split(b'\0') if x)):
            relative = Path(name)
            path = repo / relative
            if relative.is_absolute() or '..' in relative.parts or not allowed(name):
                skipped.append(name)
                continue
            if path.is_symlink() or not path.is_file() or any(p.is_symlink() for p in path.parents if p != repo and repo in p.parents):
                skipped.append(name)
                continue
            # No-follow also protects the final component from a concurrent symlink swap.
            parent_fd = os.open(repo, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                for part in relative.parts[:-1]:
                    next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
                    os.close(parent_fd)
                    parent_fd = next_fd
                fd = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
            finally:
                os.close(parent_fd)
            with os.fdopen(fd, 'rb') as stream:
                import stat
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('File type changed during import')
                data = stream.read(256*1024*1024+1)
                total += len(data)
                if total > 256*1024*1024:
                    raise ValueError('Import exceeds 256 MiB; exclude large generated files first')
                import io
                entry = tarfile.TarInfo(relative.as_posix())
                entry.size, entry.mode, entry.uid, entry.gid = len(data), info.st_mode & 0o777, 1000, 1000
                tar.addfile(entry, io.BytesIO(data))
                manifest[name] = hashlib.sha256(data).hexdigest()
    return manifest, skipped, total

def create(repo):
    repo = Path(repo).expanduser().resolve(strict=True)
    top = Path(subprocess.check_output(['git', '-C', str(repo), 'rev-parse', '--show-toplevel'], text=True).strip()).resolve()
    if top != repo:
        raise ValueError('Choose the Git repository root')
    sid = 'rtp-'+uuid.uuid4().hex
    record = {'id': sid, 'repo': str(repo), 'name': repo.name, 'created': time.time(),
              'status': 'importing', 'credentials': 'Not copied; native login persists in sandbox home'}
    with tempfile.TemporaryDirectory(prefix='raytace-import-') as temp:
        archive = Path(temp) / (sid+'.tar.gz')
        manifest, skipped, total = snapshot(repo, archive)
        record.update(manifest=manifest, skipped=skipped, imported_bytes=total)
        save(record)
        remote = '/tmp/'+archive.name
        try:
            subprocess.run(['limactl', 'copy', str(archive), VM+':'+remote], check=True, capture_output=True)
            record['container_id'] = worker('create', sid, '--archive', remote)
            record['status'] = 'created'
        except Exception:
            record['status'] = 'import_failed'
            raise
        finally:
            save(record)
            # Exact generated temporary archive only; never workspace data.
            subprocess.run(['limactl', 'shell', VM, 'rm', '-f', remote], capture_output=True)
    return record

def listing():
    live = {r['id']: r for r in json.loads(worker('list'))}
    result = []
    for path in sorted(STATE.glob('*.json')):
        r = json.loads(path.read_text())
        r.pop('manifest', None)
        r.pop('proxy_token_hash', None)
        r['skipped_count'] = len(r.pop('skipped', []))
        r.update(live.get(r['id'], {}))
        result.append(r)
    return result

PAGE = '''<!doctype html><meta charset="utf-8"><title>RayTrace Sandbox Manager</title>
<style>body{font:16px system-ui;background:#101827;color:#e7edf6;max-width:1100px;margin:40px auto;padding:20px}button,input{font:inherit;padding:9px;margin:5px}article{background:#1c293b;padding:20px;margin:16px 0;border-radius:12px}code{overflow-wrap:anywhere}small{color:#bac6d8}a{color:#8ccaff}</style>
<h1>Sandbox Manager</h1><p>Persistent project copies · local Linux VM: raytace-gvisor</p>
<p>No automatic writes back to your Mac. Closing Codex keeps your work and login. Stop releases container resources; delete permanently removes its files.</p>
<form id="create"><input id="repo" size="55" placeholder="Absolute Git repository path" required><button>Import new sandbox</button></form>
<small>Import excludes Git metadata, ignored files, symlinks, common secret files and generated directories. This is not a complete secret scanner. Review your project before importing. Public internet is enabled.</small>
<p id="message"></p><section id="list"></section>
<script>const token=__TOKEN__;const message=document.querySelector('#message');
async function action(action,id,repo){const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-RayTrace-Token':token},body:JSON.stringify({action,id,repo})});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
async function refresh(){try{
const r=await fetch('/api/projects');const data=await r.json();if(!r.ok)throw Error(data.error);
const list=document.querySelector('#list');list.replaceChildren();
for(const p of data){const card=document.createElement('article');const title=document.createElement('h2');title.textContent=p.name+' · '+p.status;card.append(title);
for(const value of [p.repo,p.id,'Writable layer: '+((p.size_bytes||0)/1048576).toFixed(1)+' MiB',p.credentials,'Resume in terminal: npm run sandbox:open -- '+p.id]){const line=document.createElement('p');line.textContent=value;card.append(line);}
if(p.status!=='deleted'){
for(const [op,label] of [['start','Start'],['stop','Stop'],['approve-proxy','Approve OpenRouter proxy'],['revoke-proxy','Revoke proxy'],['delete','Delete sandbox']]){
const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{
if(op==='delete'&&prompt('Permanently delete sandbox files and login? Host repo and audit evidence stay intact. Type sandbox ID:')!==p.id)return;
if(op==='stop'&&!confirm('Stop this sandbox? Active commands will be interrupted; stored files remain.'))return;
if(op==='approve-proxy'&&!confirm('Allow this sandbox to use the host OpenRouter proxy and incur API charges? Access persists until revoked or deleted. The OpenRouter key stays on the host. Limit: 30 requests/minute, not a dollar budget. Run npm run proxy first.'))return;
try{message.textContent='Working…';await action(op,p.id);message.textContent='Done. Reopen the shell after approving proxy access.';await refresh();}catch(e){message.textContent=e.message;}};card.append(b);}}
const link=document.createElement('a');link.href='http://localhost:8798';link.textContent='Process evidence';card.append(link);list.append(card);}
}catch(e){message.textContent=e.message;}}
document.querySelector('#create').onsubmit=async e=>{e.preventDefault();if(!confirm('Import this project into an internet-enabled isolated copy? Common secret files are excluded, but embedded secrets may still be copied.'))return;try{message.textContent='Importing…';await action('create',null,document.querySelector('#repo').value);message.textContent='Imported. Use the resume command below.';refresh();}catch(e){message.textContent=e.message;}};refresh();setInterval(refresh,10000);</script>'''

def serve():
    token = secrets.token_urlsafe(32)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def respond(self, status, data, mime='application/json'):
            body = data.encode() if isinstance(data, str) else json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.end_headers()
            self.wfile.write(body)
        def valid_host(self):
            return self.headers.get('Host') in ('localhost:8799', '127.0.0.1:8799')
        def do_GET(self):
            if not self.valid_host(): return self.respond(403, {'error':'Invalid host'})
            try:
                if self.path == '/': self.respond(200, PAGE.replace('__TOKEN__', json.dumps(token)), 'text/html; charset=utf-8')
                elif self.path == '/api/projects': self.respond(200, listing())
                else: self.respond(404, {'error':'Not found'})
            except Exception: self.respond(503, {'error':'Cannot query VM. Start raytace-gvisor and deploy projects.py.'})
        def do_POST(self):
            if self.path in ('/v1/responses','/v1/chat/completions'):
                return project_broker.forward(self, STATE)
            if not self.valid_host() or self.headers.get('X-RayTrace-Token') != token or self.headers.get('Origin') not in ('http://localhost:8799','http://127.0.0.1:8799'):
                return self.respond(403, {'error':'Invalid request origin or token'})
            if self.path != '/api/action': return self.respond(404, {'error':'Not found'})
            try:
                size = int(self.headers.get('Content-Length', 0))
                if not 0 < size <= 8192: raise ValueError('Invalid request size')
                data = json.loads(self.rfile.read(size))
                with LOCK:
                    if data['action'] == 'create':
                        result = create(data['repo'])
                        self.respond(200, {'id':result['id']})
                    elif data['action'] in ('start', 'stop', 'delete'):
                        r = record_for(data['id'])
                        extra = ['--confirm', r['id']] if data['action']=='delete' else []
                        worker(data['action'], r['id'], *extra)
                        r['last_activity']=time.time()
                        if data['action']=='delete':
                            r['status']='deleted'; r.pop('proxy_token_hash',None); save(r)
                        self.respond(200, {'ok':True})
                    elif data['action'] in ('approve-proxy','revoke-proxy'):
                        r=record_for(data['id'])
                        if r['status']=='deleted':raise ValueError('Sandbox was deleted')
                        if data['action']=='approve-proxy':project_broker.approve(r,save,VM)
                        else:
                            r.pop('proxy_token_hash',None)
                            r['credentials']='Proxy access revoked';save(r)
                        self.respond(200,{'ok':True})
                    else: raise ValueError('Unsupported action')
            except Exception as error:
                self.respond(400, {'error':str(error) if isinstance(error, ValueError) else 'Operation failed. Stop before deleting; check VM availability. No host files were changed.'})
    print('Sandbox Manager: http://localhost:8799', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8799), Handler).serve_forever()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['serve', 'import', 'open', 'list'])
    parser.add_argument('target', nargs='?')
    args = parser.parse_args()
    if args.action == 'serve': serve()
    elif args.action == 'import':
        r = create(args.target or os.getcwd())
        print('Imported '+str(len(r['manifest']))+' files. Resume: npm run sandbox:open -- '+r['id'])
    elif args.action == 'open':
        r=record_for(args.target)
        r['last_activity']=time.time();save(r)
        worker('shell', args.target, interactive=True)
    else: print(json.dumps(listing(), indent=2))
