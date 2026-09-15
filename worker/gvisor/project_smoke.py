"""VM-side smoke check. Pass a managed sandbox created for testing; interrupts it."""
import json
import subprocess
import sys
from projects import inspect

name=sys.argv[1]
inspect(name)
def run(*args):return subprocess.check_output(args,text=True).strip()
run('python3','/opt/raytace/projects.py','start',name)
run('docker','exec',name,'python3','-c',
    'from pathlib import Path; import os; '
    'assert os.getuid()==1000; assert Path("/workspace/package.json").is_file(); '
    'assert os.access("/workspace/package.json",os.W_OK); '
    'assert not Path("/workspace/.env").exists(); '
    'assert not Path("/var/run/docker.sock").exists(); '
    'Path("/home/node/.raytace-persistence-check").write_text("retained")')
run('python3','/opt/raytace/projects.py','stop',name)
run('python3','/opt/raytace/projects.py','start',name)
run('docker','exec',name,'python3','-c',
    'from pathlib import Path; p=Path("/home/node/.raytace-persistence-check"); '
    'assert p.read_text()=="retained"; p.unlink()')
print('PASS: project imported, owned by workload user, .env excluded, no Docker socket, home survives stop/start.')
