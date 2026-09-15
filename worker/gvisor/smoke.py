"""Run as root inside the dedicated VM, with no other jobs running."""
import json
from pathlib import Path
import sqlite3
import subprocess
import time

result = subprocess.run(['python3', '/opt/raytace/run.py', '--', '/bin/sh', '-c',
    'ls -la; /raytace-missing-executable; exit 7'], capture_output=True, text=True)
assert result.returncode == 7, result.stderr
job = json.loads(max(Path('/var/lib/raytace/jobs').glob('*.json'), key=lambda p: p.stat().st_mtime).read_text())
time.sleep(.2)
with sqlite3.connect('/var/lib/raytace/runtime.db') as db:
    events = [json.loads(r[0]) for r in db.execute('SELECT body FROM runtime_events WHERE container_id=?', (job['container_id'],))]
assert any(e['kind'] == 'exec_succeeded' and e.get('argv') == ['ls', '-la'] for e in events)
assert any(e['kind'] == 'exec_attempt' and e.get('executable') == '/raytace-missing-executable' for e in events)
assert not any(e['kind'] == 'exec_succeeded' and e.get('executable') == '/raytace-missing-executable' for e in events)
assert any(e.get('exit_code') == 7 for e in events)
assert not any(e['kind'] == 'collection_gap' for e in events)
try:
    subprocess.run(['systemctl', 'stop', 'raytace-collector'], check=True)
    refused = subprocess.run(['docker', 'run', '--rm', '--runtime=raytace-gvisor', '--network=none',
        'raytace-gvisor-agent', '/bin/echo', 'UNMONITORED_EXECUTION'], capture_output=True, text=True)
    assert refused.returncode != 0 and 'UNMONITORED_EXECUTION' not in refused.stdout, refused
finally:
    subprocess.run(['systemctl', 'start', 'raytace-collector'], check=True)
print('PASS: successful exec, missing exec not confirmed, exit 7, runtime refuses missing collector.')
