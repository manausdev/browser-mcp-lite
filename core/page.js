import { launchChrome } from './chrome.js';
import { CdpClient } from './cdp.js';

const DEFAULT_UA_HINT = /devtools|chrome-headless/i;

function toExpression(source, args = []) {
  if (typeof source === 'function') {
    return `(${source.toString()})(${args.map((a) => JSON.stringify(a ?? null)).join(',')})`;
  }
  return String(source);
}

export class Tab {
  constructor(browser, targetId, info = {}) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = null;
    this.info = info;
  }

  get id() {
    return this.targetId;
  }

  get title() {
    return this.info.title || '';
  }

  get url() {
    return this.info.url || '';
  }

  async attach() {
    if (this.sessionId) return this.sessionId;
    const { sessionId } = await this.browser.client.send('Target.attachToTarget', {
      targetId: this.targetId,
      flatten: true,
    });
    this.sessionId = sessionId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    return sessionId;
  }

  send(method, params) {
    return this.browser.client.send(method, params, this.sessionId);
  }

  once(method, predicate, timeout) {
    const sessionId = this.sessionId;
    return this.browser.client.once(method, (params, from) => from === sessionId, timeout);
  }

  async evaluate(source, { args = [], returnByValue = true, awaitPromise = true } = {}) {
    await this.attach();
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: toExpression(source, args),
      returnByValue,
      awaitPromise,
      userGesture: true,
    });
    if (exceptionDetails) {
      const text = exceptionDetails.exception?.description || exceptionDetails.text || 'evaluation failed';
      throw new Error(`Page evaluation failed: ${text}`);
    }
    return returnByValue ? result.value : result;
  }

  async navigate(url, { waitUntil = 'load', timeout = 30000 } = {}) {
    await this.attach();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      throw new Error(`Refusing to navigate to a non-absolute URL: ${url}`);
    }
    const loaded = this.once('Page.loadEventFired', () => true, timeout).catch(() => null);
    const result = await this.send('Page.navigate', { url });
    if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
    if (waitUntil === 'load') await loaded;
    await this.waitForReadyState();
    this.info.url = url;
    return this;
  }

  async waitForReadyState({ timeout = 10000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const state = await this.evaluate('document.readyState');
      if (state !== 'loading') return state;
      if (Date.now() > deadline) return state;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async reload({ ignoreCache = false, waitUntil = 'load' } = {}) {
    await this.attach();
    const loaded = this.once('Page.loadEventFired', () => true, 30000).catch(() => null);
    await this.send('Page.reload', { ignoreCache });
    if (waitUntil === 'load') await loaded;
    await this.waitForReadyState();
    return this;
  }

  async activate() {
    await this.browser.client.send('Target.activateTarget', { targetId: this.targetId });
    this.browser.activeTabId = this.targetId;
    return this;
  }

  async setViewport({ width = 1440, height = 900, deviceScaleFactor = 1, mobile = false }) {
    await this.attach();
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
    return this;
  }

  async emulateColorScheme(value = 'light') {
    await this.attach();
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value }],
    });
    return this;
  }

  async screenshot({ fullPage = false, format = 'png', quality, selector } = {}) {
    await this.attach();
    const params = { format, fromSurface: true, optimizeForSpeed: false };
    if (quality != null && format === 'jpeg') params.quality = quality;
    if (selector) {
      const box = await this.evaluate(
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };
        },
        { args: [selector] },
      );
      if (!box) throw new Error(`No element matched selector: ${selector}`);
      params.clip = box;
    } else if (fullPage) {
      const metrics = await this.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size && size.width > 0 && size.height > 0) {
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
      }
    }
    const { data } = await this.send('Page.captureScreenshot', params);
    return Buffer.from(data, 'base64');
  }

  async readPage(options = {}) {
    await this.attach();
    const yaml = await this.evaluate(readPageInPage, { args: [options] });
    return yaml;
  }

  #selector(target) {
    if (typeof target !== 'string' || target.trim() === '') {
      throw new Error('A target ref (e.g. "r4") or a CSS selector is required');
    }
    const value = target.trim();
    if (/^r\d+$/.test(value)) return `[data-bml-ref="${value}"]`;
    return value;
  }

  async #rect(selector) {
    return this.evaluate(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          disabled: el.disabled === true,
          pointerEvents: getComputedStyle(el).pointerEvents,
        };
      },
      { args: [selector] },
    );
  }

  async click(target, { button = 'left' } = {}) {
    await this.attach();
    const selector = this.#selector(target);
    const rect = await this.#rect(selector);
    if (!rect) throw new Error(`No element matched ${target}`);
    if (rect.disabled) throw new Error(`Element ${target} is disabled`);

    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const usable = rect.width > 0 && rect.height > 0 && rect.pointerEvents !== 'none';

    if (usable) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await this.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        clickCount: 1,
      });
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        clickCount: 1,
      });
    }

    const fellBack = await this.evaluate(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return 'missing';
        if (el.getBoundingClientRect().width === 0 && el.getBoundingClientRect().height === 0) {
          el.click();
          return 'fallback';
        }
        return 'dispatched';
      },
      { args: [selector] },
    );

    return { target, selector, method: usable ? 'mouse-event' : 'element-click', fallback: fellBack };
  }

  async typeText(target, { text = '', clear = true, submit = false } = {}) {
    await this.attach();
    const selector = this.#selector(target);
    const focused = await this.evaluate(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        if (el.isContentEditable) el.focus();
        else if ('focus' in el) el.focus();
        return document.activeElement === el;
      },
      { args: [selector] },
    );
    if (!focused) throw new Error(`Could not focus ${target}`);

    if (clear) {
      const editable = await this.evaluate(
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          if (el.isContentEditable) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return true;
          }
          if (typeof el.select === 'function') {
            el.select();
            return true;
          }
          return false;
        },
        { args: [selector] },
      );
      if (editable) {
        await this.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Delete',
          code: 'Delete',
          windowsVirtualKeyCode: 46,
        });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete' });
      }
    }

    if (text) await this.send('Input.insertText', { text });

    if (submit) {
      for (const type of ['keyDown', 'keyUp']) {
        await this.send('Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          text: '\r',
          unmodifiedText: '\r',
          windowsVirtualKeyCode: 13,
        });
      }
    }

    return { target, typed: text.length, cleared: clear, submitted: submit };
  }

  async scroll({ deltaX = 0, deltaY = 0, to = null, selector = null, behavior = 'auto' } = {}) {
    await this.attach();
    if (selector) {
      const found = await this.evaluate(
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return true;
        },
        { args: [selector] },
      );
      if (!found) throw new Error(`No element matched selector: ${selector}`);
      return { scrolledTo: 'element', selector };
    }
    if (to != null) {
      const y = await this.evaluate(
        (target, b) => {
          const value = target === 'bottom' ? document.body.scrollHeight : target === 'top' ? 0 : Number(target);
          window.scrollTo({ top: value, behavior: b });
          return window.scrollY;
        },
        { args: [to, behavior] },
      );
      return { scrolledTo: to, y };
    }
    const viewport = await this.evaluate('({ x: window.innerWidth / 2, y: window.innerHeight / 2 })');
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: viewport.x,
      y: viewport.y,
      deltaX,
      deltaY,
    });
    return { deltaX, deltaY };
  }

  async injectScript(source, { args = [] } = {}) {
    return this.evaluate(source, { args, returnByValue: true });
  }

  async waitForSelector(selector, { timeout = 10000, visible = true } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const state = await this.evaluate(
        (sel, wantVisible) => {
          const el = document.querySelector(sel);
          if (!el) return 'absent';
          if (!wantVisible) return 'present';
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
            return 'visible';
          }
          return 'hidden';
        },
        { args: [selector, visible] },
      );
      if (state === 'visible' || (state === 'present' && !visible)) return state;
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeout}ms waiting for selector: ${selector} (last state: ${state})`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async close() {
    await this.browser.client.send('Target.closeTarget', { targetId: this.targetId });
    this.sessionId = null;
  }

  async title_() {
    return this.evaluate('document.title');
  }
}

export class Browser {
  constructor(handle, client) {
    this.handle = handle;
    this.client = client;
    this.tabs = new Map();
    this.activeTabId = null;
  }

  static async launch(options = {}) {
    const handle = await launchChrome(options);
    try {
      const client = await CdpClient.connect(handle.wsUrl);
      return new Browser(handle, client);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async newTab(url = 'about:blank') {
    const { targetId } = await this.client.send('Target.createTarget', { url: 'about:blank' });
    const tab = new Tab(this, targetId, { url: 'about:blank', title: '' });
    this.tabs.set(targetId, tab);
    if (url !== 'about:blank') await tab.navigate(url);
    this.activeTabId = targetId;
    return tab;
  }

  async listTabs() {
    const { targetInfos } = await this.client.send('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page' && !DEFAULT_UA_HINT.test(t.url || ''));
    const result = [];
    for (const info of pages) {
      if (!this.tabs.has(info.targetId)) {
        this.tabs.set(info.targetId, new Tab(this, info.targetId, info));
      } else {
        this.tabs.get(info.targetId).info = info;
      }
      result.push(this.tabs.get(info.targetId));
    }
    return result;
  }

  async focusTab(tabId) {
    const tabs = await this.listTabs();
    const tab = tabs.find((t) => t.id === tabId) || this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    await tab.activate();
    return tab;
  }

  async tab(tabId) {
    if (!tabId) {
      const tabs = await this.listTabs();
      const tab = tabs.find((t) => t.id === this.activeTabId) || tabs[0];
      if (!tab) throw new Error('The browser has no open pages');
      return tab;
    }
    const tabs = await this.listTabs();
    const found = tabs.find((t) => t.id === tabId);
    if (!found) throw new Error(`No tab with id: ${tabId}`);
    return found;
  }

  async close() {
    this.client.close();
    await this.handle.close();
  }
}

export function readPageInPage(options) {
  const opts = options || {};
  const maxDepth = opts.maxDepth || 22;
  const maxNodes = opts.maxNodes || 320;
  const includeHidden = opts.includeHidden === true;
  const maxNameLength = opts.maxNameLength || 90;

  for (const stale of Array.from(document.querySelectorAll('[data-bml-ref]'))) {
    stale.removeAttribute('data-bml-ref');
  }

  const selector = [
    'header',
    'nav',
    'main',
    'aside',
    'footer',
    'section',
    'article',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'form',
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    'details',
    'img',
    'video',
    'iframe',
    'table',
    '[role]',
    '[tabindex]:not([tabindex="-1"])',
    '[onclick]',
  ].join(',');

  const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'BR', 'SVG', 'PATH']);

  const isVisible = (el) => {
    if (el.closest('[hidden]') || el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || el.tagName === 'A' || el.tagName === 'BUTTON';
  };

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target && target.textContent.trim()) return target.textContent.trim();
    }
    if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').trim();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return (el.getAttribute('placeholder') || el.getAttribute('name') || el.value || '').trim();
    }
    if (el.tagName === 'SELECT') {
      const option = el.selectedOptions && el.selectedOptions[0];
      return (option ? option.textContent : el.getAttribute('name') || '').trim();
    }
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
    return (el.getAttribute('title') || el.getAttribute('value') || '').trim();
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'a') return 'link';
    if (tag === 'img') return 'image';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'aside') return 'complementary';
    if (tag === 'form') return 'form';
    if (tag === 'button') return 'button';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'iframe') return 'iframe';
    if (tag === 'input') return el.getAttribute('type') === 'checkbox' ? 'checkbox' : el.getAttribute('type') === 'radio' ? 'radio' : el.getAttribute('type') || 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'summary';
    if (tag === 'details') return 'group';
    return tag;
  };

  const attributesOf = (el) => {
    const parts = [];
    const tag = el.tagName.toLowerCase();
    const clip = (v) => (v.length > 60 ? `${v.slice(0, 60)}…` : v);
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) parts.push(`href=${clip(href)}`);
    }
    if (tag === 'img') {
      const src = el.getAttribute('src');
      if (src) parts.push(`src=${clip(src)}`);
    }
    if (tag === 'input') {
      if (el.type && el.type !== 'text') parts.push(`type=${el.type}`);
      if (el.name) parts.push(`name=${el.name}`);
      if (el.placeholder) parts.push(`placeholder=${el.placeholder}`);
      if (el.value) parts.push(`value=${JSON.stringify(String(el.value).slice(0, 40))}`);
      if (el.checked) parts.push('checked');
    }
    if (tag === 'textarea' && el.placeholder) parts.push(`placeholder=${el.placeholder}`);
    if (el.getAttribute('aria-expanded')) parts.push(`aria-expanded=${el.getAttribute('aria-expanded')}`);
    if (el.getAttribute('aria-current')) parts.push(`aria-current=${el.getAttribute('aria-current')}`);
    if (el.disabled) parts.push('disabled');
    return parts;
  };

  const root = document.body || document.documentElement;
  const lines = [];
  let counter = 0;
  const emitted = new Set();

  const walk = (el, depth) => {
    if (counter >= maxNodes || depth > maxDepth) return;
    for (const child of el.children) {
      if (counter >= maxNodes) return;
      if (skipTags.has(child.tagName)) continue;
      if (!includeHidden && !isVisible(child)) continue;
      const matches = child.matches(selector);
      if (matches) {
        const ref = `r${++counter}`;
        child.setAttribute('data-bml-ref', ref);
        emitted.add(child);
        const name = accessibleName(child).slice(0, maxNameLength);
        const attrs = attributesOf(child);
        const heading = /^H[1-6]$/.test(child.tagName) ? ` h${child.tagName.slice(1)}` : '';
        const parts = [`ref=${ref}`, `role=${roleOf(child)}${heading}`];
        if (name) parts.push(`label=${JSON.stringify(name)}`);
        parts.push(...attrs);
        lines.push(`${'  '.repeat(depth)}- ${parts.join(' | ')}`);
        if (['A', 'BUTTON', 'SUMMARY', 'INPUT', 'SELECT', 'TEXTAREA', 'IMG', 'IFRAME'].includes(child.tagName)) {
          continue;
        }
      }
      const hasEmittedDescendant = Array.from(child.children).some((c) => emitted.has(c));
      if (hasEmittedDescendant && ['A', 'BUTTON'].includes(child.tagName)) continue;
      walk(child, matches ? depth + 1 : depth);
    }
  };

  walk(root, 0);

  const meta = {
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang || '',
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { y: Math.round(window.scrollY), height: document.body.scrollHeight },
  };

  const header = [
    `url: ${meta.url}`,
    `title: ${JSON.stringify(meta.title)}`,
    `lang: ${meta.lang || '(unset)'}`,
    `viewport: ${meta.viewport.width}x${meta.viewport.height}`,
    `scroll_y: ${meta.scroll.y} of ${meta.scroll.height}`,
  ].join('\n');

  const footer = [
    '',
    `${counter} interactive/structural nodes captured.`,
    'Use ref=<id> with click, type_text, scroll_page or inject_script to target an element.',
  ].join('\n');

  return [header, '', ...lines, footer].join('\n');
}
