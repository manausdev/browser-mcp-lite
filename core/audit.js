import { composite, contrastRatio, grade, isLargeText, requiredRatio, toCss } from './color.js';

export async function collectOverflow(tab, { tolerance = 1, max = 40, maxDepth = 25 } = {}) {
  return tab.evaluate(
    (opts) => {
      const pathOf = (el) => {
        const parts = [];
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && node !== document.body && depth < 5) {
          let part = node.tagName.toLowerCase();
          if (node.id) {
            parts.unshift(`${part}#${node.id}`);
            break;
          }
          const classes = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
          if (classes.length) part += `.${classes.join('.')}`;
          const parent = node.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
            if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          }
          parts.unshift(part);
          node = node.parentElement;
          depth += 1;
        }
        return parts.join(' > ');
      };

      const classify = (el) => {
        let node = el.parentElement;
        while (node && node !== document.documentElement) {
          const overflowX = getComputedStyle(node).overflowX;
          if (overflowX === 'auto' || overflowX === 'scroll') {
            return { kind: 'scroll', path: pathOf(node) };
          }
          if (overflowX === 'hidden' || overflowX === 'clip') {
            return { kind: 'clip', path: pathOf(node) };
          }
          node = node.parentElement;
        }
        return { kind: 'viewport', path: null };
      };

      const doc = document.documentElement;
      const width = doc.clientWidth;
      const offenders = [];

      for (const el of document.querySelectorAll('*')) {
        if (offenders.length >= opts.max * 3) break;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const overflowsRight = rect.right > width + opts.tolerance;
        const overflowsLeft = rect.left < -opts.tolerance;
        if (!overflowsRight && !overflowsLeft) continue;
        const container = classify(el);
        offenders.push({
          path: pathOf(el),
          tag: el.tagName.toLowerCase(),
          containedBy: container.kind,
          containedByPath: container.path,
          rect: {
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
          },
          overflowPx: Math.round(Math.max(rect.right - width, -rect.left)),
          side: overflowsRight ? 'right' : 'left',
          position: style.position,
          overflowX: style.overflowX,
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70),
        });
      }

      const rank = { viewport: 0, clip: 1, scroll: 2 };
      offenders.sort((a, b) => rank[a.containedBy] - rank[b.containedBy] || b.overflowPx - a.overflowPx);

      const body = document.body;
      const scrollWidth = Math.max(doc.scrollWidth, body ? body.scrollWidth : 0);
      return {
        viewportWidth: width,
        clientWidth: doc.clientWidth,
        scrollWidth,
        hasHorizontalScroll: scrollWidth > width + opts.tolerance,
        maxDepth: opts.maxDepth,
        offenders,
      };
    },
    { args: [{ tolerance, max, maxDepth }] },
  );
}

const CONTAINMENT = {
  viewport: 'escapes the viewport',
  clip: 'clipped by an ancestor with overflow-x hidden/clip',
  scroll: 'inside a deliberate overflow-x auto/scroll container',
};

export function reportOverflow(samples, { max = 15 } = {}) {
  const escaping = samples.offenders.filter((o) => o.containedBy === 'viewport');
  const clipped = samples.offenders.filter((o) => o.containedBy === 'clip');
  const scrollable = samples.offenders.filter((o) => o.containedBy === 'scroll');

  const status = samples.hasHorizontalScroll || escaping.length > 0 ? 'fail' : clipped.length > 0 ? 'warn' : 'pass';

  const lines = [
    `viewport=${samples.viewportWidth}px scrollWidth=${samples.scrollWidth}px pageScrolls=${samples.hasHorizontalScroll}`,
  ];

  const describe = (list) =>
    list
      .slice(0, max)
      .map(
        (o) =>
          `  ${o.overflowPx}px past the ${o.side} edge | ${o.path} | "${o.text}"${
            o.containedByPath ? ` <- clipped by ${o.containedByPath}` : ''
          }`,
      );

  if (escaping.length > 0) {
    lines.push(
      `${escaping.length} element(s) escape the viewport and create horizontal scroll:`,
      ...describe(escaping),
    );
  }
  if (clipped.length > 0) {
    lines.push(
      `${clipped.length} element(s) are cut off by an ancestor (${CONTAINMENT.clip}) — the content is unreachable:`,
      ...describe(clipped),
    );
  }
  if (scrollable.length > 0) {
    lines.push(
      `${scrollable.length} element(s) overflow inside a scroll container (${CONTAINMENT.scroll}) — intentional, not a defect.`,
    );
  }

  return {
    status,
    viewportWidth: samples.viewportWidth,
    scrollWidth: samples.scrollWidth,
    clientWidth: samples.clientWidth,
    escaping: escaping.length,
    clipped: clipped.length,
    insideScrollContainer: scrollable.length,
    message: lines.join('\n'),
  };
}

export async function collectContrastSamples(tab, { max = 400 } = {}) {
  return tab.evaluate(
    (limit) => {
      const pathOf = (el) => {
        const parts = [];
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && node !== document.body && depth < 5) {
          let part = node.tagName.toLowerCase();
          if (node.id) {
            parts.unshift(`${part}#${node.id}`);
            break;
          }
          const classes = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
          if (classes.length) part += `.${classes.join('.')}`;
          const parent = node.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
            if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          }
          parts.unshift(part);
          node = node.parentElement;
          depth += 1;
        }
        return parts.join(' > ');
      };

      const effectiveBackground = (el) => {
        const layers = [];
        let node = el;
        while (node && node.nodeType === 1) {
          const style = getComputedStyle(node);
          layers.push({
            color: style.backgroundColor,
            image: style.backgroundImage !== 'none' ? style.backgroundImage : null,
            opacity: parseFloat(style.opacity),
          });
          const bg = style.backgroundColor;
          const alphaMatch = bg && bg.match(/rgba?\(([^)]+)\)/);
          const isOpaque = alphaMatch ? (alphaMatch[1].split(',').length < 4 || parseFloat(alphaMatch[1].split(',')[3] ?? 1) >= 0.999) : true;
          if (isOpaque) break;
          node = node.parentElement;
        }
        return { layers, hasImage: layers.some((l) => l.image) };
      };

      const samples = [];
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      const owners = new Set();

      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const el = node.parentElement;
        if (!el || owners.has(el)) continue;
        owners.add(el);
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (parseFloat(style.opacity) === 0) continue;

        const bg = effectiveBackground(el);
        samples.push({
          path: pathOf(el),
          tag: el.tagName.toLowerCase(),
          text: text.slice(0, 80),
          color: style.color,
          backgroundLayers: bg.layers,
          hasBackgroundImage: bg.hasImage,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          opacity: parseFloat(style.opacity),
        });
        if (samples.length >= limit) break;
      }

      return samples;
    },
    { args: [max] },
  );
}

export function evaluateContrast(samples, { min = 4.5 } = {}) {
  const rows = [];
  for (const sample of samples) {
    const fg = parse(sample.color);
    if (!fg) continue;
    let bg = [255, 255, 255, 1];
    for (let i = sample.backgroundLayers.length - 1; i >= 0; i -= 1) {
      const layer = sample.backgroundLayers[i];
      const parsed = parse(layer.color);
      if (!parsed) continue;
      bg = composite(parsed, bg);
      if (parsed[3] >= 1) break;
    }
    let foreground = fg;
    if (sample.opacity != null && sample.opacity < 1) {
      foreground = [...fg.slice(0, 3), fg[3] * sample.opacity];
    }
    const ratio = contrastRatio(foreground, bg);
    const large = isLargeText(sample.fontSize, sample.fontWeight);
    rows.push({
      path: sample.path,
      text: sample.text,
      foreground: toCss(foreground),
      background: toCss(bg),
      ratio,
      grade: grade(ratio),
      required: requiredRatio(large),
      largeText: large,
      unverifiable: sample.hasBackgroundImage,
      pass: ratio != null && ratio >= requiredRatio(large),
    });
  }

  rows.sort((a, b) => (a.ratio ?? 99) - (b.ratio ?? 99));
  const failures = rows.filter((r) => !r.pass && !r.unverifiable);
  const manual = rows.filter((r) => !r.pass && r.unverifiable);

  return {
    status: failures.length === 0 ? 'pass' : 'fail',
    checked: rows.length,
    min,
    failures: failures.slice(0, 50),
    needsManualReview: manual.slice(0, 20),
    message: [
      `Checked ${rows.length} text nodes against WCAG AA.`,
      failures.length === 0
        ? 'All measurable text passes.'
        : [
            `${failures.length} failing node(s):`,
            ...failures.map(
              (r) =>
                `  ${r.ratio.toFixed(2)}:1 needs ${r.required}:1 (${r.largeText ? 'large' : 'normal'} text) | ${r.path} | fg=${r.foreground} bg=${r.background} | "${r.text}"`,
            ),
          ].join('\n'),
      manual.length > 0 ? `${manual.length} node(s) sit on a background image/gradient and need manual review.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function parse(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^rgba?\(([^)]+)\)$/);
  if (!match) return null;
  const parts = match[1].split(/[\s,/]+/).filter((p) => p !== '').map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

export async function collectGeometry(tab, selector) {
  return tab.evaluate(
    (sel) => {
      const el = sel ? document.querySelector(sel) : document.body;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const box = (name) => {
        const v = parseFloat(style[name]);
        return Number.isNaN(v) ? null : v;
      };
      return {
        selector: sel || 'body',
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        box: {
          marginTop: box('marginTop'),
          marginRight: box('marginRight'),
          marginBottom: box('marginBottom'),
          marginLeft: box('marginLeft'),
          paddingTop: box('paddingTop'),
          paddingRight: box('paddingRight'),
          paddingBottom: box('paddingBottom'),
          paddingLeft: box('paddingLeft'),
        },
        display: style.display,
        position: style.position,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        transform: style.transform,
        zIndex: style.zIndex,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      };
    },
    { args: [selector || null] },
  );
}

export async function captureHighlighted(tab, selector, { color = '#ff0044', max = 25 } = {}) {
  const count = await tab.evaluate(
    (opts) => {
      const pathOf = (el) => {
        const parts = [];
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && node !== document.body && depth < 5) {
          let part = node.tagName.toLowerCase();
          if (node.id) {
            parts.unshift(`${part}#${node.id}`);
            break;
          }
          parts.unshift(part);
          node = node.parentElement;
          depth += 1;
        }
        return parts.join(' > ');
      };
      for (const stale of Array.from(document.querySelectorAll('[data-bml-outline]'))) {
        stale.removeAttribute('data-bml-outline');
      }
      const width = document.documentElement.clientWidth;
      let found = 0;
      for (const el of document.querySelectorAll('*')) {
        if (found >= opts.max) break;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right <= width + 1 && r.left >= -1) continue;
        let node = el.parentElement;
        let contained = false;
        while (node && node !== document.documentElement) {
          const overflowX = getComputedStyle(node).overflowX;
          if (overflowX !== 'visible') {
            contained = true;
            break;
          }
          node = node.parentElement;
        }
        if (contained) continue;
        el.setAttribute('data-bml-outline', opts.color);
        el.dataset.bmlPath = pathOf(el);
        found += 1;
      }
      return found;
    },
    { args: [{ color, max }] },
  );
  const buffer = await tab.screenshot({ fullPage: true });
  await tab.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('[data-bml-outline]'))) {
      el.removeAttribute('data-bml-outline');
      delete el.dataset.bmlPath;
    }
  });
  return { count, buffer };
}
