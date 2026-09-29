const NAMED = {
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
};

const clamp255 = (n) => Math.min(255, Math.max(0, Math.round(n)));

export function parseColor(input) {
  if (input == null) return null;
  const value = String(input).trim().toLowerCase();
  if (value === '' || value === 'none') return null;
  if (Object.hasOwn(NAMED, value)) return NAMED[value];

  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const expand = (c) => parseInt(c + c, 16);
    if (hex.length === 3 || hex.length === 4) {
      const parts = [...hex].map(expand);
      return [parts[0], parts[1], parts[2], hex.length === 4 ? parts[3] / 255 : 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      const pairs = hex.match(/../g).map((p) => parseInt(p, 16));
      return [pairs[0], pairs[1], pairs[2], hex.length === 8 ? pairs[3] / 255 : 1];
    }
    return null;
  }

  const fn = value.match(/^(rgba?|hsla?)\(([^)]+)\)$/);
  if (!fn) return null;
  const kind = fn[1];
  const parts = fn[2]
    .split(/[\s,/]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length < 3) return null;

  const channel = (p) => {
    if (p.endsWith('%')) return (parseFloat(p) / 100) * 255;
    return parseFloat(p);
  };
  const alpha = parts[3] == null ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  if ([parts[0], parts[1], parts[2]].some((p) => Number.isNaN(parseFloat(p)))) return null;

  if (kind.startsWith('rgb')) {
    return [clamp255(channel(parts[0])), clamp255(channel(parts[1])), clamp255(channel(parts[2])), alpha];
  }

  const hue = ((parseFloat(parts[0]) % 360) + 360) % 360;
  const sat = parseFloat(parts[1]) / 100;
  const light = parseFloat(parts[2]) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const sector = Math.floor(hue / 60) % 6;
  const table = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
  const [r, g, b] = table[sector];
  return [clamp255((r + m) * 255), clamp255((g + m) * 255), clamp255((b + m) * 255), alpha];
}

export function toCss([r, g, b, a = 1]) {
  return a >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${Number(a.toFixed(3))})`;
}

export function composite(fg, bg) {
  const [fr, fg_, fb, fa = 1] = fg;
  const [br, bg_, bb, ba = 1] = bg;
  const outA = fa + ba * (1 - fa);
  if (outA === 0) return [0, 0, 0, 0];
  return [
    clamp255((fr * fa + br * ba * (1 - fa)) / outA),
    clamp255((fg_ * fa + bg_ * ba * (1 - fa)) / outA),
    clamp255((fb * fa + bb * ba * (1 - fa)) / outA),
    outA,
  ];
}

function channelLuminance(v) {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance([r, g, b]) {
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

export function contrastRatio(fg, bg, backdrop = [255, 255, 255, 1]) {
  if (!fg || !bg) return null;
  const surface = composite(bg, backdrop);
  const rendered = composite(fg, surface);
  const l1 = relativeLuminance(rendered.slice(0, 3));
  const l2 = relativeLuminance(surface.slice(0, 3));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export function isLargeText(fontSizePx, fontWeight) {
  const size = parseFloat(fontSizePx) || 0;
  const weight = parseInt(fontWeight, 10) || 400;
  return size >= 24 || (size >= 18.66 && weight >= 700);
}

export function requiredRatio(large) {
  return large ? 3 : 4.5;
}

export function grade(ratio) {
  if (ratio == null) return 'unknown';
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA-large';
  return 'fail';
}
