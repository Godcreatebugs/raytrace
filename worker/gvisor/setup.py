"""Run with sudo INSIDE the dedicated Lima VM, never on the Mac."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import urllib.request


def run(*args):
    subprocess.run(args, check=True)


if __name__ == '__main__':
    if platform.system() != 'Linux' or os.geteuid() != 0:
        raise SystemExit('Run this setup with sudo inside the RayTrace Linux VM.')
    arch = {'aarch64': 'aarch64', 'x86_64': 'x86_64'}[platform.machine()]
    base = f'https://storage.googleapis.com/gvisor/releases/release/20260817.0/{arch}/'
    binary = urllib.request.urlopen(base + 'runsc', timeout=120).read()
    checksum = urllib.request.urlopen(base + 'runsc.sha512', timeout=30).read().decode().split()[0]
    if hashlib.sha512(binary).hexdigest() != checksum:
        raise SystemExit('runsc checksum mismatch')
    Path('/usr/local/bin/runsc').write_bytes(binary)
    Path('/usr/local/bin/runsc').chmod(0o755)
    for directory in ['/opt/raytace', '/etc/raytace', '/var/lib/raytace', '/run/raytace']:
        Path(directory).mkdir(exist_ok=True, mode=0o700)
    source = Path(__file__).parent
    for name in ['collector.py', 'viewer.py', 'run.py', 'network.py', 'projects.py']:
        shutil.copyfile(source / name, Path('/opt/raytace') / name)
    context = ['time', 'thread_id', 'group_id', 'thread_group_start_time',
               'container_id', 'cwd', 'process_name', 'parent_thread_group_id']
    points = ['sentry/clone', 'sentry/execve', 'sentry/exit_notify_parent',
              'sentry/task_exit', 'syscall/execve/enter', 'syscall/execve/exit',
              'syscall/execveat/enter', 'syscall/execveat/exit']
    for number in ([221, 281] if arch == 'aarch64' else [59, 322]):
        points.append(f'syscall/sysno/{number}/exit')
    config = {'trace_session': {'name': 'Default',
        'points': [{'name': point, 'context_fields': [f for f in context if not
                    (point == 'sentry/exit_notify_parent' and f == 'cwd')]} for point in points],
        'sinks': [{'name': 'remote', 'ignore_setup_error': False,
                   'config': {'endpoint': '/run/raytace/events.sock', 'retries': 3}}]}}
    Path('/etc/raytace/gvisor.json').write_text(json.dumps(config, indent=2))
    run('/usr/local/bin/runsc', 'install', '--runtime=raytace-gvisor', '--',
        '--pod-init-config=/etc/raytace/gvisor.json')
    for name, command in [('collector', 'collector.py --socket /run/raytace/events.sock --database /var/lib/raytace/runtime.db'),
                          ('viewer', 'viewer.py')]:
        unit = f'''[Unit]
Description=RayTrace {name}
After=network.target
[Service]
ExecStart=/usr/bin/python3 /opt/raytace/{command}
Restart=on-failure
RestartSec=2
UMask=0077
RuntimeDirectory=raytace
RuntimeDirectoryPreserve=yes
[Install]
WantedBy=multi-user.target
'''
        if name == 'collector':
            unit = unit.replace('ExecStart=', 'ExecStartPre=/usr/bin/rm -f /run/raytace/events.sock\nExecStart=')
        Path(f'/etc/systemd/system/raytace-{name}.service').write_text(unit)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'restart', 'docker')
    run('systemctl', 'enable', '--now', 'raytace-collector', 'raytace-viewer')
    run('systemctl', 'restart', 'raytace-collector', 'raytace-viewer')
    run('python3', '/opt/raytace/network.py')
    run('docker', 'build', '-t', 'raytace-gvisor-agent', '-f', str(source / 'Dockerfile'), str(source))
    print('Ready. Run: sudo python3 /opt/raytace/run.py -- /bin/ls -la')
