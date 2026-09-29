import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  composite,
  contrastRatio,
  grade,
  isLargeText,
  parseColor,
  relativeLuminance,
  requiredRatio,
  toCss,
} from '../core/color.js';

const close = (actual, expected, tolerance = 0.5) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );

describe('parseColor', () => {
  it('expands short hex', () => {
    assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
    assert.deepEqual(parseColor('#0073FD'), [0, 115, 253, 1]);
  });

  it('reads 8-digit hex alpha', () => {
    const parsed = parseColor('#00000080');
    assert.equal(parsed[0], 0);
    close(parsed[3], 0.502, 0.01);
  });

  it('reads modern and legacy rgb syntax', () => {
    assert.deepEqual(parseColor('rgb(0 115 253)'), [0, 115, 253, 1]);
    assert.deepEqual(parseColor('rgb(0, 115, 253)'), [0, 115, 253, 1]);
  });

  it('reads rgba alpha', () => {
    const parsed = parseColor('rgba(0, 0, 0, 0.5)');
    assert.equal(parsed[3], 0.5);
  });

  it('converts hsl to rgb', () => {
    const parsed = parseColor('hsl(210, 100%, 50%)');
    close(parsed[0], 0);
    close(parsed[1], 128);
    close(parsed[2], 255);
  });

  it('handles named colors and rejects junk', () => {
    assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0]);
    assert.equal(parseColor('not-a-color'), null);
    assert.equal(parseColor(''), null);
    assert.equal(parseColor(undefined), null);
  });
});

describe('composite', () => {
  it('is a no-op for opaque colors', () => {
    assert.deepEqual(composite([10, 20, 30, 1], [200, 200, 200, 1]), [10, 20, 30, 1]);
  });

  it('blends translucent foreground over background', () => {
    assert.deepEqual(composite([0, 0, 0, 0.5], [255, 255, 255, 1]), [128, 128, 128, 1]);
  });

  it('keeps the backdrop when the foreground is fully transparent', () => {
    assert.deepEqual(composite([255, 0, 0, 0], [12, 34, 56, 1]), [12, 34, 56, 1]);
  });
});

describe('contrastRatio', () => {
  it('reaches 21:1 for black on white', () => {
    close(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1]), 21, 0.01);
  });

  it('is 1:1 for identical colors', () => {
    close(contrastRatio(parseColor('#0073FD'), parseColor('#0073FD')), 1, 0.001);
  });

  it('is symmetric', () => {
    const a = parseColor('#191918');
    const b = parseColor('#FFFFFF');
    close(contrastRatio(a, b), contrastRatio(b, a), 0.0001);
  });

  it('accounts for alpha instead of ignoring it', () => {
    const ratio = contrastRatio(parseColor('rgba(0,0,0,0.5)'), parseColor('#FFFFFF'));
    close(ratio, 3.95, 0.05);
    assert.ok(ratio < contrastRatio([0, 0, 0, 1], [255, 255, 255, 1]));
  });

  it('composites a translucent backdrop before comparing', () => {
    const solid = contrastRatio([0, 0, 0, 1], [255, 255, 255, 1]);
    const translucent = contrastRatio([0, 0, 0, 1], [255, 255, 255, 0.5]);
    close(translucent, solid, 0.01);
  });

  it('returns null for unusable input', () => {
    assert.equal(contrastRatio(null, [255, 255, 255, 1]), null);
  });
});

describe('relativeLuminance', () => {
  it('anchors the endpoints', () => {
    assert.equal(relativeLuminance([255, 255, 255]), 1);
    assert.equal(relativeLuminance([0, 0, 0]), 0);
  });
});

describe('wcag thresholds', () => {
  it('detects large text', () => {
    assert.equal(isLargeText('24px', '400'), true);
    assert.equal(isLargeText('18.66px', '700'), true);
    assert.equal(isLargeText('18px', '400'), false);
  });

  it('requires 4.5:1 for body text and 3:1 for large text', () => {
    assert.equal(requiredRatio(false), 4.5);
    assert.equal(requiredRatio(true), 3);
  });

  it('grades ratios', () => {
    assert.equal(grade(7.1), 'AAA');
    assert.equal(grade(4.6), 'AA');
    assert.equal(grade(3.2), 'AA-large');
    assert.equal(grade(2.1), 'fail');
    assert.equal(grade(null), 'unknown');
  });
});

describe('toCss', () => {
  it('omits the alpha channel when opaque', () => {
    assert.equal(toCss([1, 2, 3, 1]), 'rgb(1 2 3)');
    assert.match(toCss([1, 2, 3, 0.5]), /rgb\(1 2 3 \/ 0\.5\)/);
  });
});
