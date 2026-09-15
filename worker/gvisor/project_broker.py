"""Restricted bridge to the existing host RayTrace OpenRouter proxy."""
import hashlib
import http.client
import json
import secrets
import subprocess
import threading
import time
from datetime import datetime, timezone

LIMIT_LOCK = threading.Lock()
USAGE = {}

def models():
    connection = http.client.HTTPConnection('127.0.0.1', 8797, timeout=5)
    try:
        connection.request('GET', '/raytace/models')
        response = connection.getresponse()
        data = json.loads(response.read(65536))
        if response.status != 200 or not data.get('execution_available') or not data.get('models'):
            raise ValueError('Start npm run proxy in OpenRouter mode first')
        return [r['id'] for r in data['models']]
    finally: connection.close()

def approve(record, save, vm):
    permitted = models()
    token = secrets.token_urlsafe(48)
    # stdin, never argv or process logs. Underlying OpenRouter key never leaves proxy.
    subprocess.run(['limactl','shell',vm,'sudo','python3','/opt/raytace/projects.py',
        'approve-proxy',record['id']],input=json.dumps({'token':token,'model':permitted[0]}),
        text=True,check=True,capture_output=True,timeout=30)
    record.update(proxy_token_hash=hashlib.sha256(token.encode()).hexdigest(),
        proxy_models=permitted, credentials='Host OpenRouter proxy approved (revocable sandbox token)',
        proxy_approved_at=time.time())
    save(record)

def authorize(state, supplied):
    if not supplied or len(supplied)>128:return None
    digest=hashlib.sha256(supplied.encode()).hexdigest()
    for path in state.glob('*.json'):
        record=json.loads(path.read_text())
        if record.get('status')!='deleted' and secrets.compare_digest(record.get('proxy_token_hash',''),digest):
            return record
    return None

def forward(handler, state):
    record=authorize(state,handler.headers.get('x-raytace-sandbox-token'))
    if not record:return handler.respond(401,{'error':'Sandbox proxy access not approved or revoked'})
    try:
        size=int(handler.headers.get('Content-Length',0))
        if not 0<size<=4*1024*1024:raise ValueError('Request must be at most 4 MiB')
        payload=json.loads(handler.rfile.read(size))
        if payload.get('model') not in record['proxy_models']:raise ValueError('Model not approved')
        # No arbitrary proxy routes, upstreams, or client credential forwarding.
        if payload.get('store') or payload.get('previous_response_id') or payload.get('conversation'):
            raise ValueError('Send full history with store:false')
        with LIMIT_LOCK:
            now=time.monotonic()
            recent=[t for t in USAGE.get(record['id'],[]) if now-t<60]
            if len(recent)>=30:return handler.respond(429,{'error':'30 requests/minute sandbox limit'})
            USAGE[record['id']]=recent+[now]
        # Check the target has not been restarted in native-provider mode.
        models()
    except Exception as error:
        return handler.respond(400,{'error':str(error) if isinstance(error,ValueError) else 'Host OpenRouter proxy unavailable; run npm run proxy'})
    upstream=http.client.HTTPConnection('127.0.0.1',8797,timeout=180)
    started=False
    try:
        upstream.request('POST',handler.path,json.dumps(payload).encode(),{
            'content-type':'application/json','x-raytace-session-id':record['id'],
            'x-raytace-session-started-at':datetime.fromtimestamp(record['proxy_approved_at'], timezone.utc).isoformat()})
        response=upstream.getresponse()
        handler.send_response(response.status)
        handler.send_header('Content-Type',response.getheader('Content-Type','application/json'))
        handler.send_header('Cache-Control','no-store')
        handler.send_header('Connection','close')
        handler.end_headers();started=True
        while True:
            chunk=response.read1(65536)
            if not chunk:break
            handler.wfile.write(chunk);handler.wfile.flush()
    except Exception:
        if not started:handler.respond(502,{'error':'Host proxy connection failed'})
    finally:
        upstream.close();handler.close_connection=True
