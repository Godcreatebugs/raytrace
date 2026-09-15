"""Launch a recorded sandbox on the local Linux worker; no host bind mounts."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--network', default='none', choices=['none', 'raytace-egress'])
    parser.add_argument('--image', default='raytace-gvisor-agent')
    parser.add_argument('--workspace', help='Optional directory already copied into the VM')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    opts = parser.parse_args()
    if platform.system() != 'Linux':
        parser.error('Use npm run sandbox:run on macOS to enter the dedicated Lima VM.')
    command = opts.command[1:] if opts.command[:1] == ['--'] else opts.command
    if not command:
        parser.error('Supply a command after --')
    subprocess.run(['systemctl', 'is-active', '--quiet', 'raytace-collector'], check=True)
    info = json.loads(subprocess.check_output(['docker', 'info', '--format', '{{json .Runtimes}}']))
    if 'raytace-gvisor' not in info:
        parser.error('Monitored gVisor runtime missing. Run setup.py; no fallback is allowed.')
    if opts.network == 'raytace-egress':
        subprocess.run(['python3', '/opt/raytace/network.py'], check=True)
    name = 'raytace-' + uuid.uuid4().hex
    records = Path('/var/lib/raytace/jobs')
    records.mkdir(exist_ok=True, mode=0o700)
    job = {'id': name, 'command': command, 'started_ms': int(time.time()*1000), 'status': 'starting'}
    path = records / (name + '.json')
    def save():
        path.write_text(json.dumps(job))
    save()
    args = ['docker', 'create', '--name', name, '--runtime=raytace-gvisor',
            '--network', opts.network, '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--user=1000:1000', '--memory=2g', '--cpus=2', '--pids-limit=256',
            '--tmpfs=/tmp:rw,nosuid,nodev,size=512m',
            '--tmpfs=/home/node:rw,nosuid,nodev,uid=1000,gid=1000,size=256m',
            '--workdir=/workspace']
    if sys.stdin.isatty():
        args += ['-it']
    else:
        args += ['-i']
    if opts.network == 'raytace-egress':
        # Docker's embedded loopback DNS is not usable with this runsc network.
        args += ['--mount=type=bind,src=/etc/raytace/resolv.conf,dst=/etc/resolv.conf,readonly']
    args += [opts.image, *command]
    created = False
    try:
        cid = subprocess.check_output(args, text=True).strip()
        created = True
        job.update(container_id=cid, status='running')
        # Container writable layer is private, not a writable Mac directory.
        if opts.workspace:
            subprocess.run(['docker', 'cp', str(Path(opts.workspace).resolve()) + '/.', cid + ':/workspace'], check=True)
        save()
        code = subprocess.call(['docker', 'start', '-ai', cid])
        state = json.loads(subprocess.check_output(['docker', 'inspect', '--format', '{{json .State}}', cid]))
        job.update(status='exited', exit_code=state['ExitCode'], launcher_exit_code=code,
                   filesystem_changes=subprocess.check_output(['docker', 'diff', cid], text=True))
        print('\nRayTrace sandbox: ' + cid + '\nProcess evidence: http://localhost:8798', file=sys.stderr)
        return state['ExitCode']
    except BaseException as error:
        job.update(status='launcher_failed', error=str(error))
        raise
    finally:
        job['ended_ms'] = int(time.time()*1000)
        save()
        if created:
            # Retain the stopped container for artifact inspection. Never auto-delete user work.
            subprocess.run(['docker', 'stop', '-t', '3', name], stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    sys.exit(main())
