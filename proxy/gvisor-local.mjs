import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const vm = 'raytace-gvisor';
const source = fileURLToPath(new URL('../worker/gvisor', import.meta.url));
function run(args) {
  const result = spawnSync('limactl', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const [action, ...raw] = process.argv.slice(2);
const args = raw[0] === '--' ? raw.slice(1) : raw;
try {
  if (action === 'setup') {
    run(['start', '--name', vm, '--tty=false', `${source}/lima.yaml`]);
    run(['shell', vm, 'mkdir', '-p', '/tmp/raytace-gvisor-source']);
    run(['copy', '-r', `${source}/.`, `${vm}:/tmp/raytace-gvisor-source/`]);
    run(['shell', vm, 'sudo', 'python3', '/tmp/raytace-gvisor-source/setup.py']);
  } else if (action === 'run') {
    run(['shell', vm, 'sudo', 'python3', '/opt/raytace/run.py', ...args]);
  } else if (action === 'stop') {
    run(['stop', vm]);
  } else throw new Error('Use setup, run, or stop');
} catch (error) {
  console.error(`RayTrace local gVisor: ${error.message}. Lima is required (brew install lima).`);
  process.exitCode = 1;
}
