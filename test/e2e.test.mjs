import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Browser } from '../core/page.js';
import { collectContrastSamples, collectOverflow, evaluateContrast, reportOverflow } from '../core/audit.js';

const FIXTURE = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>BML fixture</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #ffffff; color: #111111; }
  #good { color: #595959; background: #ffffff; padding: 8px; }
  #bad { color: #bbbbbb; background: #ffffff; padding: 8px; }
  #wide { width: 1600px; height: 10px; }
  #tall { height: 1500px; }
</style>
</head>
<body>
  <h1>Fixture</h1>
  <p id="good">Texto com contraste suficiente.</p>
  <p id="bad">Texto com contraste insuficiente.</p>
  <input id="nome" name="nome" placeholder="Seu nome" />
  <button id="acao" onclick="document.getElementById('saida').textContent='clicado'">Enviar</button>
  <div id="saida"></div>
  <div id="wide"></div>
  <div id="tall"></div>
</body>
</html>`;

const CLEAN = `<!doctype html><html><body style="margin:0;background:#fff">
<p style="color:#111;background:#fff">Contraste suficiente.</p>
</body></html>`;

const CAROUSEL = `<!doctype html><html><body style="margin:0;background:#fff">
<div class="row" style="display:flex;gap:8px;overflow-x:auto;width:300px">
${Array.from({ length: 20 }, (_, i) => `<button style="flex:0 0 auto;padding:8px">Chip ${i}</button>`).join('\n')}
</div>
</body></html>`;

const CLIPPED = `<!doctype html><html><body style="margin:0;background:#fff">
<div style="overflow-x:hidden;width:300px">
  <div style="width:1600px;height:20px;background:#eee">conteudo cortado</div>
</div>
</body></html>`;

const toDataUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

const enabled = process.env.BML_E2E === '1';
const options = { skip: enabled ? false : 'set BML_E2E=1 to run browser integration tests' };

describe('browser integration', options, () => {
  let browser;
  let tab;

  const load = async (html = FIXTURE, { width = 1440, height = 900, scheme = 'light' } = {}) => {
    await tab.setViewport({ width, height });
    await tab.emulateColorScheme(scheme);
    await tab.navigate(toDataUrl(html));
    return tab;
  };

  before(async () => {
    browser = await Browser.launch({ headless: true });
    tab = await browser.newTab('about:blank');
  });

  after(async () => {
    if (browser) await browser.close();
  });

  it('lists and focuses tabs', async () => {
    const tabs = await browser.listTabs();
    assert.ok(tabs.length >= 1);
    const focused = await browser.focusTab(tabs[0].id);
    assert.equal(focused.id, tabs[0].id);
  });

  it('refuses to navigate to a relative URL', async () => {
    await assert.rejects(() => tab.navigate('/devs'), /non-absolute URL/);
  });

  it('reads a page outline with refs', async () => {
    await load();
    const outline = await tab.readPage();
    assert.match(outline, /role=heading h1 \| label="Fixture"/);
    assert.match(outline, /role=textbox \| label="Seu nome" \| name=nome \| placeholder=Seu nome/);
    assert.match(outline, /role=button \| label="Enviar"/);
    assert.match(outline, /interactive\/structural nodes captured/);
  });

  it('clicks a button by ref', async () => {
    await load();
    const outline = await tab.readPage();
    const ref = outline.match(/ref=(r\d+) \| role=button \| label="Enviar"/)?.[1];
    assert.ok(ref, 'expected a ref for the Enviar button');
    await tab.click(ref);
    assert.equal(await tab.evaluate("document.getElementById('saida').textContent"), 'clicado');
  });

  it('types into a field so framework listeners fire', async () => {
    await load();
    await tab.evaluate(() => {
      window.__events = 0;
      document.getElementById('nome').addEventListener('input', () => {
        window.__events += 1;
      });
    });
    await tab.typeText('#nome', { text: 'Ada Lovelace', clear: true });
    assert.equal(await tab.evaluate("document.getElementById('nome').value"), 'Ada Lovelace');
    assert.ok((await tab.evaluate('window.__events')) >= 1, 'input event should have fired');
  });

  it('clears a field when asked to type nothing', async () => {
    await load();
    await tab.typeText('#nome', { text: 'Ada', clear: true });
    await tab.typeText('#nome', { text: '', clear: true });
    assert.equal(await tab.evaluate("document.getElementById('nome').value"), '');
  });

  it('injects scripts and returns the JSON result', async () => {
    await load();
    assert.equal(await tab.injectScript((a, b) => a + b, { args: [2, 3] }), 5);
    assert.match(await tab.injectScript('document.title'), /BML fixture/);
  });

  it('waits for selectors and times out cleanly', async () => {
    await load();
    assert.equal(await tab.waitForSelector('#nome'), 'visible');
    await assert.rejects(() => tab.waitForSelector('#nao-existe', { timeout: 300 }), /Timed out/);
  });

  it('captures screenshots', async () => {
    await load();
    const png = await tab.screenshot();
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    const full = await tab.screenshot({ fullPage: true });
    assert.ok(full.length > png.length, 'full-page capture should be larger than the viewport');
    const jpeg = await tab.screenshot({ format: 'jpeg', quality: 60 });
    assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    await assert.rejects(() => tab.screenshot({ selector: '#nao-existe' }), /No element matched/);
  });

  it('emulates viewport width and color scheme', async () => {
    await load(FIXTURE, { width: 390, height: 844, scheme: 'dark' });
    const metrics = await tab.evaluate(
      '({ w: window.innerWidth, scheme: matchMedia("(prefers-color-scheme: dark)").matches })',
    );
    assert.equal(metrics.w, 390);
    assert.equal(metrics.scheme, true);
  });

  it('detects horizontal overflow and names the offender', async () => {
    await load(FIXTURE, { width: 390, height: 844 });
    const report = reportOverflow(await collectOverflow(tab));
    assert.equal(report.status, 'fail');
    assert.equal(report.escaping, 1);
    assert.ok(report.message.includes('escape the viewport'));
    assert.ok(report.message.includes('div#wide'), report.message);
  });

  it('does not flag a deliberate horizontal scroll container', async () => {
    await load(CAROUSEL, { width: 390, height: 844 });
    const report = reportOverflow(await collectOverflow(tab));
    assert.equal(report.escaping, 0, 'chips inside overflow-x:auto are not a defect');
    assert.equal(report.status, 'pass');
    assert.ok(report.insideScrollContainer > 0, 'they should be reported as intentional');
    assert.ok(report.message.includes('intentional, not a defect'));
  });

  it('separates content clipped by an ancestor from real overflow', async () => {
    await load(CLIPPED, { width: 390, height: 844 });
    const report = reportOverflow(await collectOverflow(tab));
    assert.equal(report.escaping, 0);
    assert.ok(report.clipped > 0);
    assert.equal(report.status, 'warn');
    assert.ok(report.message.includes('unreachable'));
  });

  it('reports no overflow on a well-behaved page', async () => {
    await load(CLEAN, { width: 390, height: 844 });
    assert.equal(reportOverflow(await collectOverflow(tab)).status, 'pass');
  });

  it('grades contrast against WCAG AA', async () => {
    await load();
    const report = evaluateContrast(await collectContrastSamples(tab));
    assert.equal(report.status, 'fail');
    const failure = report.failures.find((f) => f.path.includes('#bad'));
    assert.ok(failure, 'expected the low-contrast node to fail');
    assert.ok(failure.ratio < 4.5);
    assert.equal(failure.required, 4.5);
    assert.equal(failure.grade, 'fail');
    assert.ok(report.failures.every((f) => !f.path.includes('#good')), 'the readable node must pass');
  });

  it('passes contrast when every node is readable', async () => {
    await load(CLEAN);
    assert.equal(evaluateContrast(await collectContrastSamples(tab)).status, 'pass');
  });

  it('measures the box model of a node', async () => {
    await load();
    const geometry = await (await import('../core/audit.js')).collectGeometry(tab, '#good');
    assert.equal(geometry.selector, '#good');
    assert.equal(geometry.box.paddingTop, 8);
    assert.equal(geometry.display, 'block');
  });
});
