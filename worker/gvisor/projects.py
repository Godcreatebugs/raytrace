"""Trusted VM-side persistent container lifecycle. Not mounted into workloads."""
import argparse
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile

LABEL = 'io.raytace.project'

def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def inspect(name):
    if not re.fullmatch(r'rtp-[a-f0-9]{32}', name):
        raise ValueError('Invalid sandbox ID')
    data = json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]
    if data['Config'].get('Labels', {}).get(LABEL) != name:
        raise ValueError('Container is not a managed RayTrace project')
    if data['HostConfig']['Runtime'] != 'raytace-gvisor':
        raise ValueError('Unexpected runtime; refusing operation')
    return data

def preflight():
    run('systemctl', 'is-active', '--quiet', 'raytace-collector')
    run('python3', '/opt/raytace/network.py')

def validate_archive(path):
    total = 0
    with tarfile.open(path, 'r:gz') as archive:
        for item in archive:
            parts = PurePosixPath(item.name)
            if parts.is_absolute() or '..' in parts.parts or not item.isfile():
                raise ValueError('Archive contains unsafe path or non-regular file')
            total += item.size
            if total > 256 * 1024 * 1024:
                raise ValueError('Import exceeds 256 MiB')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['create', 'list', 'start', 'shell', 'stop', 'delete', 'approve-proxy'])
    parser.add_argument('id', nargs='?')
    parser.add_argument('--archive')
    parser.add_argument('--confirm')
    opts = parser.parse_args()
    if opts.action == 'list':
        ids = subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'label='+LABEL], text=True).split()
        result = []
        for cid in ids:
            d = json.loads(subprocess.check_output(['docker', 'inspect', '--size', cid]))[0]
            result.append({'id': d['Name'].lstrip('/'), 'container_id': d['Id'],
                'status': d['State']['Status'], 'created': d['Created'],
                'persistent_volumes': d['Config'].get('Labels',{}).get('io.raytace.storage')=='volumes-v1',
                'size_bytes': d.get('SizeRw', 0)})
        print(json.dumps(result))
        return
    if not opts.id or not re.fullmatch(r'rtp-[a-f0-9]{32}', opts.id):
        parser.error('Invalid sandbox ID')
    if opts.action == 'create':
        if not opts.archive or not re.fullmatch(r'/tmp/rtp-[a-f0-9]{32}\.tar\.gz', opts.archive):
            parser.error('Expected staged import archive')
        validate_archive(opts.archive)
        preflight()
        for suffix in ('workspace','home'):
            run('docker','volume','create','--label',LABEL+'='+opts.id,opts.id+'-'+suffix,stdout=subprocess.DEVNULL)
        cid = subprocess.check_output(['docker', 'create', '--name', opts.id,
            '--label', LABEL+'='+opts.id, '--runtime=raytace-gvisor',
            '--label', 'io.raytace.storage=volumes-v1',
            '--network=raytace-egress', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--user=1000:1000', '--memory=2g', '--cpus=2', '--pids-limit=256',
            '--tmpfs=/tmp:rw,nosuid,nodev,size=512m',
            '--mount=type=volume,src='+opts.id+'-workspace,dst=/workspace',
            '--mount=type=volume,src='+opts.id+'-home,dst=/home/node',
            '--mount=type=bind,src=/etc/raytace/resolv.conf,dst=/etc/resolv.conf,readonly',
            '--workdir=/workspace', '--entrypoint=/bin/sleep',
            'raytace-gvisor-agent', 'infinity'], text=True).strip()
        # docker cp -a honors the deliberately normalized uid/gid in this tar.
        with tarfile.open(opts.archive, 'r:gz') as source:
            with io.BytesIO() as buffer:
                with tarfile.open(fileobj=buffer, mode='w') as dest:
                    for item in source:
                        item.uid = item.gid = 1000
                        item.uname = item.gname = 'node'
                        item.mode = 0o755 if item.mode & 0o111 else 0o644
                        dest.addfile(item, source.extractfile(item))
                run('docker', 'cp', '-a', '-', cid+':/workspace', input=buffer.getvalue())
        print(cid)
        return
    state = inspect(opts.id)
    if opts.action == 'approve-proxy':
        data = json.loads(sys.stdin.buffer.read(8193))
        if not re.fullmatch(r'[A-Za-z0-9_-]{40,100}', data['token']):
            raise ValueError('Invalid proxy token')
        if not re.fullmatch(r'[A-Za-z0-9_./:-]{1,150}', data['model']):
            raise ValueError('Invalid model')
        config = ('model_provider = "raytace"\nmodel = '+json.dumps(data['model'])+
            '\n[model_providers.raytace]\nname = "RayTrace project proxy"\nwire_api = "responses"\n'
            'requires_openai_auth = false\nbase_url = "http://192.168.5.2:8799/v1"\n'
            'http_headers = { "x-raytace-sandbox-token" = '+json.dumps(data['token'])+' }\n')
        with io.BytesIO() as buffer:
            with tarfile.open(fileobj=buffer, mode='w') as archive:
                directory = tarfile.TarInfo('.raytace-codex'); directory.type=tarfile.DIRTYPE
                directory.uid=directory.gid=1000; directory.mode=0o700
                archive.addfile(directory)
                entry=tarfile.TarInfo('.raytace-codex/config.toml'); entry.uid=entry.gid=1000
                entry.mode=0o600; entry.size=len(config.encode())
                archive.addfile(entry, io.BytesIO(config.encode()))
            run('docker', 'cp', '-a', '-', opts.id+':/home/node', input=buffer.getvalue())
        print('Proxy configured; reopen shell to use it')
    elif opts.action in ('shell', 'start'):
        preflight()
        if not state['State']['Running']:
            run('docker', 'start', opts.id, stdout=subprocess.DEVNULL)
        if opts.action == 'start':
            return
        # Exiting this shell or Codex never stops/removes the persistent container.
        run('docker', 'exec', '-it', opts.id, '/bin/bash', '-c',
            'if [ -f /home/node/.raytace-codex/config.toml ]; then export CODEX_HOME=/home/node/.raytace-codex; fi; exec /bin/bash')
    elif opts.action == 'stop':
        run('docker', 'stop', '-t', '10', opts.id)
    elif opts.action == 'delete':
        if opts.confirm != opts.id:
            parser.error('Deletion requires --confirm with the exact sandbox ID')
        if state['State']['Running']:
            parser.error('Stop the sandbox before deleting it')
        run('docker', 'rm', opts.id)
        for suffix in ('workspace','home'):
            volume=opts.id+'-'+suffix
            result=subprocess.run(['docker','volume','inspect',volume],capture_output=True,text=True)
            if result.returncode==0:
                item=json.loads(result.stdout)[0]
                if item.get('Labels',{}).get(LABEL)!=opts.id:
                    raise ValueError('Unexpected volume ownership; volume retained')
                run('docker','volume','rm',volume)

if __name__ == '__main__':
    main()
