import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/opt/homebrew/bin/chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
};

export function findChrome(explicit = process.env.BML_CHROME) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`BML_CHROME points to a missing binary: ${explicit}`);
    return explicit;
  }
  for (const candidate of CANDIDATES[process.platform] || []) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function launchChrome({ headless = true, width = 1440, height = 900, timeout = 30000 } = {}) {
  const binary = findChrome();
  if (!binary) {
    throw new Error(
      'No Chrome/Chromium/Edge binary found. Set BML_CHROME to an absolute path.',
    );
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'bml-profile-'));
  const args = [
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--disable-extensions',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Browser did not expose a DevTools endpoint within ${timeout}ms`));
    }, timeout);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    child.once('error', (err) => finish(reject, err));
    child.once('exit', (code) => {
      if (!settled) finish(reject, new Error(`Browser exited early with code ${code}`));
    });

    let buffer = '';
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        buffer = '';
        finish(resolve, match[1]);
      }
    });
  });

  const handle = {
    binary,
    wsUrl,
    userDataDir,
    child,
    async close() {
      if (!child.killed) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        void 0;
      }
    },
  };
  return handle;
}
