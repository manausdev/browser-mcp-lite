import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Browser } from '../core/page.js';
import {
  captureHighlighted,
  collectContrastSamples,
  collectGeometry,
  collectOverflow,
  evaluateContrast,
  reportOverflow,
} from '../core/audit.js';

const text = (value) => ({ type: 'text', text: String(value) });
const image = (buffer, mimeType = 'image/png') => ({
  type: 'image',
  data: buffer.toString('base64'),
  mimeType,
});
const fail = (value) => ({ content: [text(value)], isError: true });
const ok = (value) => ({ content: [text(value)] });

const TAB_PROPERTY = {
  type: 'string',
  description: 'Tab id from list_tabs. Defaults to the active tab.',
};

export function createToolRegistry({ launch = (opts) => Browser.launch(opts) } = {}) {
  let browser = null;
  let launching = null;

  const getBrowser = async () => {
    if (browser && !browser.client.closed) return browser;
    if (!launching) {
      launching = launch({ headless: process.env.BML_HEADFUL !== '1' })
        .then((instance) => {
          browser = instance;
          launching = null;
          return instance;
        })
        .catch((err) => {
          launching = null;
          throw err;
        });
    }
    return launching;
  };

  const save = (buffer, path) => {
    const target = resolve(process.cwd(), path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buffer);
    return target;
  };

  const tools = [
    {
      name: 'list_tabs',
      description:
        'List every open page in the browser with its id, title and URL. Call this first to obtain a tabId.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const instance = await getBrowser();
        const tabs = await instance.listTabs();
        if (tabs.length === 0) return ok('No tabs are open. Use open_tab to create one.');
        return ok(
          tabs
            .map((tab, index) => `${index === 0 ? '*' : ' '} [${tab.id}] ${JSON.stringify(tab.title)} — ${tab.url}`)
            .join('\n'),
        );
      },
    },
    {
      name: 'open_tab',
      description: 'Open a new tab at the given absolute URL and return its tabId.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute URL, e.g. https://example.com' } },
        required: ['url'],
        additionalProperties: false,
      },
      handler: async ({ url }) => {
        const instance = await getBrowser();
        const tab = await instance.newTab(url);
        return ok(`Opened [${tab.id}] ${tab.url}\n\n${await tab.readPage({ maxNodes: 60 })}`);
      },
    },
    {
      name: 'navigate_tab',
      description: 'Navigate a tab to a new absolute URL and wait for the page to load.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' }, tabId: TAB_PROPERTY },
        required: ['url'],
        additionalProperties: false,
      },
      handler: async ({ url, tabId }) => {
        const instance = await getBrowser();
        const tab = await instance.tab(tabId);
        await tab.navigate(url);
        return ok(`Navigated [${tab.id}] to ${url}\n\n${await tab.readPage({ maxNodes: 60 })}`);
      },
    },
    {
      name: 'reload_tab',
      description: 'Reload a tab, optionally bypassing the HTTP cache.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: TAB_PROPERTY,
          ignoreCache: { type: 'boolean', description: 'Bypass the cache (hard reload).' },
        },
        additionalProperties: false,
      },
      handler: async ({ tabId, ignoreCache = false }) => {
        const instance = await getBrowser();
        const tab = await instance.tab(tabId);
        await tab.reload({ ignoreCache });
        return ok(`Reloaded [${tab.id}] ${tab.url}`);
      },
    },
    {
      name: 'focus_tab',
      description: 'Bring a tab to the foreground so later input events target it.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string', description: 'Tab id from list_tabs.' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      handler: async ({ tabId }) => {
        const instance = await getBrowser();
        const tab = await instance.focusTab(tabId);
        return ok(`Focused [${tab.id}] ${tab.url}`);
      },
    },
    {
      name: 'read_page',
      description:
        'Return a YAML outline of the page: landmarks, headings, links, forms and buttons, each tagged with a ref. Pass a ref to click, type_text, scroll_page or inject_script.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: TAB_PROPERTY,
          maxNodes: { type: 'number', description: 'Cap on captured nodes (default 320).' },
          maxDepth: { type: 'number', description: 'Cap on outline depth (default 22).' },
          includeHidden: { type: 'boolean', description: 'Include display:none subtrees.' },
        },
        additionalProperties: false,
      },
      handler: async ({ tabId, maxNodes, maxDepth, includeHidden }) => {
        const instance = await getBrowser();
        const tab = await instance.tab(tabId);
        const options = {};
        if (maxNodes != null) options.maxNodes = maxNodes;
        if (maxDepth != null) options.maxDepth = maxDepth;
        if (includeHidden != null) options.includeHidden = includeHidden;
        return ok(await tab.readPage(options));
      },
    },
    {
      name: 'screenshot',
      description:
        'Capture a PNG/JPEG screenshot. Set fullPage for the whole scrollable page, or selector to clip to one element. Provide path to also write the file to disk.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: TAB_PROPERTY,
          fullPage: { type: 'boolean' },
          selector: { type: 'string', description: 'CSS selector to clip to.' },
          format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
          quality: { type: 'number', description: 'JPEG quality 1-100.' },
          path: { type: 'string', description: 'Where to write the image, relative to cwd.' },
        },
        additionalProperties: false,
      },
      handler: async ({ tabId, fullPage = false, selector, format = 'png', quality, path: outPath }) => {
        const instance = await getBrowser();
        const tab = await instance.tab(tabId);
        const buffer = await tab.screenshot({
          fullPage,
          selector,
          format,
          quality: format === 'jpeg' ? Math.min(100, Math.max(1, quality ?? 80)) : undefined,
        });
        const blocks = [];
        if (outPath) blocks.push(text(`Wrote ${save(buffer, outPath)} (${buffer.length} bytes)`));
        else blocks.push(text(`Captured ${buffer.length} bytes. Pass "path" to write it to disk.`));
        blocks.push(image(buffer, format === 'jpeg' ? 'image/jpeg' : 'image/png'));
        return { content: blocks };
      },
    },
    {
      name: 'click',
      description: 'Click an element by ref (e.g. "r12") or CSS selector. Dispatches real mouse events.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Element ref from read_page, or a CSS selector.' },
          tabId: TAB_PROPERTY,
          button: { type: 'string', enum: ['left', 'middle', 'right'], default: 'left' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      handler: async ({ target, tabId, button = 'left' }) => {
        const instance = await getBrowser();
        const tab = await instance.tab(tabId);
        const result = await tab.click(target, { button });
        return ok(`Clicked ${result.selector} via ${result.method}.\n\n${await tab.readPage({ maxNodes: 60 })}`);
      },
    },
    {
      name: 'type_text',
      description:
        'Type into a field identified by ref or CSS selector. Uses real key events so React and other frameworks register the change. Optionally clear first and press Enter.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          text: { type: 'string', description: 'Text to type. Omit to only clear the field.' },
          tabId: TAB_PROPERTY,
          clear: { type: 'boolean', default: true },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      handler: async ({ target, text: value = '', tabId, clear = true, submit = false }) => {
        const instance = await getBrowser();
        const tab = await instance.tab(tabId);
        const result = await tab.typeText(target, { text: value, clear, submit });
        return ok(`Typed ${result.typed} characters into ${target}${submit ? ' and pressed Enter' : ''}.`);
      },
    },
    {
      name: 'scroll_page',
      description: 'Scroll by a delta, jump to "top"/"bottom", or scroll a selector into view.',
      inputSchema: {
        type: 'object',
        properties: {
          deltaY: { type: 'number', description: 'Vertical wheel delta; negative scrolls up.' },
          deltaX: { type: 'number' },
          to: { type: 'string', enum: ['top', 'bottom'], description: 'Jump to an absolute position.' },
          selector: { type: 'string', description: 'Scroll this element into view instead.' },
          tabId: TAB_PROPERTY,
        },
        additionalProperties: false,
      },
      handler: async ({ deltaY = 0, deltaX = 0, to, selector, tabId }) => {
        const instance = await getBrowser();
        const tab = await instance.tab(tabId);
        const result = await tab.scroll({ deltaY, deltaX, to, selector });
        return ok(`Scrolled: ${JSON.stringify(result)}`);
      },
    },
    {
      name: 'inject_script',
      description:
        'Evaluate JavaScript in the page and return the JSON result. The script may be a function (serialized) or an expression.',
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'Function or expression to evaluate.' },
          args: { type: 'array', items: {}, description: 'Arguments passed to a function script.' },
          tabId: TAB_PROPERTY,
        },
        required: ['script'],
        additionalProperties: false,
      },
      handler: async ({ script, args = [], tabId }) => {
        const instance = await getBrowser();
        const tab = await instance.tab(tabId);
        const result = await tab.injectScript(script, { args });
        return ok(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      },
    },
    {
      name: 'audit_page',
      description:
        'Run a layout/accessibility audit on the current page: horizontal overflow offenders and WCAG AA text contrast. Optionally returns a highlighted screenshot.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: TAB_PROPERTY,
          checks: {
            type: 'array',
            items: { type: 'string', enum: ['overflow', 'contrast', 'geometry'] },
            default: ['overflow', 'contrast'],
          },
          selector: { type: 'string', description: 'Element to measure for the geometry check.' },
          highlight: { type: 'boolean', description: 'Return a full-page screenshot with offenders outlined.' },
        },
        additionalProperties: false,
      },
      handler: async ({ tabId, checks = ['overflow', 'contrast'], selector, highlight = false }) => {
        const instance = await getBrowser();
        const tab = await instance.tab(tabId);
        const sections = [];
        const blocks = [];

        if (checks.includes('overflow')) {
          const report = reportOverflow(await collectOverflow(tab));
          sections.push(`## Overflow\n${report.message}`);
        }
        if (checks.includes('contrast')) {
          const report = evaluateContrast(await collectContrastSamples(tab));
          sections.push(`## Contrast\n${report.message}`);
        }
        if (checks.includes('geometry')) {
          const geometry = await collectGeometry(tab, selector);
          sections.push(`## Geometry\n${geometry ? JSON.stringify(geometry, null, 2) : `No element matched ${selector}`}`);
        }
        if (highlight) {
          const { count, buffer } = await captureHighlighted(tab, selector);
          sections.push(`## Highlight\n${count} element(s) outlined in the screenshot.`);
          blocks.push(image(buffer));
        }

        blocks.unshift(text(sections.join('\n\n')));
        return { content: blocks };
      },
    },
  ];

  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    tools,
    getBrowser,
    list: () => tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    async call(name, args = {}) {
      const tool = byName.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      for (const key of tool.inputSchema.required || []) {
        if (args[key] == null) throw new Error(`Missing required argument: ${key}`);
      }
      try {
        return await tool.handler(args);
      } catch (err) {
        return fail(err.message);
      }
    },
    async close() {
      if (browser) await browser.close();
      browser = null;
    },
  };
}
