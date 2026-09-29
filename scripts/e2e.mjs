import { spawn } from 'node:child_process';

const timeoutMs = Number(process.env.BML_E2E_TIMEOUT || 180000);

const child = spawn(process.execPath, ['--test', '--test-reporter=spec'], {
  stdio: 'inherit',
  env: { ...process.env, BML_E2E: '1' },
});

const timer = setTimeout(() => {
  process.stderr.write(`\nBrowser tests exceeded ${timeoutMs}ms; killing the run.\n`);
  child.kill('SIGKILL');
  process.exit(1);
}, timeoutMs);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  process.exit(signal ? 1 : (code ?? 1));
});
