import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--test', '--test-reporter=spec'], {
  stdio: 'inherit',
  env: { ...process.env, BML_E2E: '1' },
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
