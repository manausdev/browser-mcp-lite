#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Browser } from '../core/page.js';
import { findChrome } from '../core/chrome.js';
import {
  collectContrastSamples,
  collectOverflow,
  evaluateContrast,
  reportOverflow,
} from '../core/audit.js';
import { createToolRegistry } from '../server/tools.js';
import { startStdioServer } from '../server/mcp.js';
import { startBridge } from '../server/bridge.js';
import { loadToken, tokenPath } from '../server/token.js';
import { SERVER_NAME, SERVER_VERSION } from '../server/mcp.js';

const HELP = `${SERVER_NAME} ${SERVER_VERSION} — drive Chrome over raw CDP, no extension.

Usage
  bml mcp                       Serve MCP over stdio (for MCP clients)
  bml bridge                    Serve MCP over HTTP on 127.0.0.1:12307
  bml tools                     Print the tool catalogue as JSON
  bml doctor                    Check the environment (Node, Chrome, token)
  bml shot <url> <out.png>      Screenshot a URL
  bml audit <url...>            Audit overflow + WCAG AA contrast across widths

shot options
  --width=<px>        Viewport width (default 1440)
  --height=<px>       Viewport height (default 900)
  --scale=<n>         Device scale factor (default 1)
  --full              Capture the full scrollable page
  --color-scheme=<s>  light | dark | no-preference (default light)
  --selector=<css>    Clip to one element
  --wait=<ms>         Extra settle time after load (default 250)

audit options
  --widths=<list>     Comma-separated widths (default 390,768,1440)
  --color-scheme=<s>  light | dark (default light)
  --checks=<list>     overflow,contrast (default both)
  --json=<path>       Write the full report as JSON
  --continue-on-fail  Always exit 0

Environment
  BML_CHROME           Absolute path to a Chrome/Chromium/Edge binary
  BML_HEADFUL=1        Run with a visible window
  BML_ENDPOINT         HTTP MCP endpoint (default http://127.0.0.1:12307/mcp)
  BML_TOKEN            Bearer token override
  BML_INSECURE=1       Accept any bearer token (local debugging only)
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split(/=(.*)/s);
      flags[key] = value === undefined ? true : value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

async function withBrowser(options, fn) {
  const browser = await Browser.launch(options);
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

async function cmdShot(url, out, flags) {
  const buffer = await withBrowser({ headless: process.env.BML_HEADFUL !== '1' }, async (browser) => {
    const tab = await browser.newTab(url);
    await tab.setViewport({
      width: number(flags.width, 1440),
      height: number(flags.height, 900),
      deviceScaleFactor: number(flags.scale, 1),
    });
    await tab.emulateColorScheme(flags['color-scheme'] || 'light');
    await new Promise((r) => setTimeout(r, number(flags.wait, 250)));
    return tab.screenshot({ fullPage: flags.full === true, selector: flags.selector });
  });
  const target = resolve(process.cwd(), out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buffer);
  process.stdout.write(`${target} (${buffer.length} bytes)\n`);
}

async function cmdAudit(urls, flags) {
  const widths = String(flags.widths || '390,768,1440')
    .split(',')
    .map((w) => number(w.trim(), 0))
    .filter((w) => w > 0);
  const checks = String(flags.checks || 'overflow,contrast').split(',').map((c) => c.trim());
  const scheme = flags['color-scheme'] || 'light';
  const report = { scheme, checks, generatedAt: new Date().toISOString(), results: [] };
  let failed = 0;

  await withBrowser({ headless: process.env.BML_HEADFUL !== '1' }, async (browser) => {
    const tab = await browser.newTab('about:blank');
    await tab.emulateColorScheme(scheme);
    for (const url of urls) {
      for (const width of widths) {
        await tab.setViewport({ width, height: number(flags.height, 900) });
        let entry;
        try {
          await tab.navigate(url, { timeout: number(flags.timeout, 30000) });
          await new Promise((r) => setTimeout(r, number(flags.wait, 250)));
          entry = { url, width, title: await tab.evaluate('document.title') };
          if (checks.includes('overflow')) {
            const overflow = reportOverflow(await collectOverflow(tab));
            entry.overflow = { status: overflow.status, message: overflow.message, offenders: undefined };
            if (overflow.status === 'fail') failed += 1;
          }
          if (checks.includes('contrast')) {
            const contrast = evaluateContrast(await collectContrastSamples(tab));
            entry.contrast = {
              status: contrast.status,
              checked: contrast.checked,
              message: contrast.message,
              failures: contrast.failures.slice(0, 10),
            };
            if (contrast.status === 'fail') failed += 1;
          }
        } catch (err) {
          entry = { url, width, error: err.message };
          failed += 1;
        }
        report.results.push(entry);
        const badge = entry.error
          ? 'ERROR'
          : [entry.overflow?.status, entry.contrast?.status].filter(Boolean).join('/') || 'ok';
        process.stdout.write(`${badge.padEnd(15)} ${String(width).padStart(5)}px  ${url}\n`);
        if (entry.error) process.stdout.write(`  ${entry.error}\n`);
        for (const line of String(entry.overflow?.message || '').split('\n').slice(1)) {
          if (line.trim()) process.stdout.write(`  ${line}\n`);
        }
        for (const line of String(entry.contrast?.message || '').split('\n').slice(1)) {
          if (line.trim()) process.stdout.write(`  ${line}\n`);
        }
      }
    }
  });

  if (flags.json) {
    const target = resolve(process.cwd(), String(flags.json));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(report, null, 2));
    process.stdout.write(`\nJSON report: ${target}\n`);
  }

  const total = report.results.length;
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${total - failed}/${total} checks clean\n`);
  if (failed > 0 && flags['continue-on-fail'] !== true) process.exitCode = 1;
}

async function cmdDoctor() {
  const rows = [
    ['node', process.version, Number(process.versions.node.split('.')[0]) >= 22],
    ['platform', `${process.platform}/${process.arch}`, true],
    ['chrome', findChrome() || 'not found', Boolean(findChrome())],
    ['token file', tokenPath() || 'will be created on first run', true],
  ];
  for (const [label, value, good] of rows) {
    process.stdout.write(`${good ? 'ok  ' : 'FAIL'}  ${label.padEnd(12)} ${value}\n`);
  }
  const registry = createToolRegistry();
  process.stdout.write(`ok   tools        ${registry.list().length} available\n`);
  if (!findChrome()) process.exitCode = 1;
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case 'mcp':
      startStdioServer();
      return;
    case 'bridge': {
      const bridge = await startBridge();
      process.stderr.write(`listening on ${bridge.url}\nbearer token: ${bridge.bearer}\n`);
      const stop = async () => {
        await bridge.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'tools': {
      const registry = createToolRegistry();
      process.stdout.write(`${JSON.stringify(registry.list(), null, 2)}\n`);
      return;
    }
    case 'doctor':
      await cmdDoctor();
      return;
    case 'shot': {
      const [url, out = 'shot.png'] = positional;
      if (!url) throw new Error('Usage: bml shot <url> [out.png]');
      await cmdShot(url, out, flags);
      return;
    }
    case 'audit': {
      if (positional.length === 0) throw new Error('Usage: bml audit <url...>');
      await cmdAudit(positional, flags);
      return;
    }
    case 'token': {
      process.stdout.write(`${await loadToken()}\n`);
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
