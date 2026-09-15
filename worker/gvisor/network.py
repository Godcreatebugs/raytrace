"""Dedicated VM firewall: agent egress cannot reach private networks or VM services."""
import subprocess
from pathlib import Path


def run(*args):
    subprocess.run(args, check=True)


if __name__ == '__main__':
    # Lima's user-mode network provides DNS at this address; public DNS UDP
    # need not be reachable. Only its DNS port is exempted below.
    Path('/etc/raytace/resolv.conf').write_text('nameserver 192.168.5.2\n')
    if subprocess.run(['docker', 'network', 'inspect', 'raytace-egress'], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL).returncode:
        run('docker', 'network', 'create', '--driver=bridge', '--subnet=172.30.60.0/24',
            '--opt=com.docker.network.bridge.name=br-raytace', 'raytace-egress')
    def rule(chain, *args):
        if subprocess.run(['iptables', '-C', chain, *args], stderr=subprocess.DEVNULL).returncode:
            run('iptables', '-I', chain, '1', *args)
    for destination in ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
                        '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4']:
        rule('DOCKER-USER', '-i', 'br-raytace', '-d', destination, '-j', 'REJECT')
    rule('INPUT', '-i', 'br-raytace', '-j', 'REJECT')
    for protocol in ['udp', 'tcp']:
        rule('DOCKER-USER', '-i', 'br-raytace', '-d', '192.168.5.2',
             '-p', protocol, '--dport', '53', '-j', 'ACCEPT')
    # Only the authenticated model bridge. Its management API rejects this Host.
    rule('DOCKER-USER', '-i', 'br-raytace', '-d', '192.168.5.2',
         '-p', 'tcp', '--dport', '8799', '-j', 'ACCEPT')
