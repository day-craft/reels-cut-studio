import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_COLOR,
  COLOR_PRESETS,
  normalizeColor,
  isNeutral,
  matchPreset,
  cssFilter,
  warmthLayer,
  supportsCanvasFilter,
  adjustPixels,
  describeColor,
} from '../js/core/color.js';

test('default colour is neutral and matches the original preset', () => {
  assert.equal(isNeutral(DEFAULT_COLOR), true);
  assert.equal(matchPreset(DEFAULT_COLOR), 'original');
  assert.equal(describeColor(DEFAULT_COLOR), '원본');
});

test('presets have the four promised names', () => {
  assert.deepEqual(
    COLOR_PRESETS.map((p) => p.label),
    ['원본', '화사하게', '뽀얗게', '선명하게'],
  );
  for (const preset of COLOR_PRESETS) {
    assert.equal(matchPreset(preset.settings), preset.id);
    assert.equal(isNeutral(preset.settings), preset.id === 'original');
  }
});

test('normalizeColor clamps and rounds slider values', () => {
  const c = normalizeColor({ brightness: 3, contrast: -9, saturation: 0.123456, warmth: 0 });
  assert.equal(c.brightness, 1);
  assert.equal(c.contrast, -1);
  assert.equal(c.saturation, 0.123);
  assert.equal(c.warmth, 0);
});

test('cssFilter maps sliders into brightness / contrast / saturate', () => {
  assert.equal(cssFilter(DEFAULT_COLOR), 'brightness(1) contrast(1) saturate(1)');
  const fresh = COLOR_PRESETS.find((p) => p.id === 'fresh').settings;
  assert.equal(cssFilter(fresh), 'brightness(1.08) contrast(1.025) saturate(1.08)');
  assert.equal(cssFilter({ brightness: 1, contrast: 1, saturation: 1, warmth: 0 }),
    'brightness(1.5) contrast(1.5) saturate(1.8)');
});

test('warmthLayer returns a warm / cool soft-light veil only when needed', () => {
  assert.equal(warmthLayer({ ...DEFAULT_COLOR }), null);
  const warm = warmthLayer({ ...DEFAULT_COLOR, warmth: 1 });
  assert.equal(warm.composite, 'soft-light');
  assert.equal(warm.direction, 'warm');
  assert.match(warm.color, /^rgba\(255, 176, 92, 0\.3\)$/);
  const cool = warmthLayer({ ...DEFAULT_COLOR, warmth: -0.5 });
  assert.equal(cool.direction, 'cool');
  assert.match(cool.color, /rgba\(112, 168, 255/);
});

test('adjustPixels brightens, keeps alpha and clamps channels', () => {
  const data = new Uint8ClampedArray([100, 100, 100, 255, 10, 200, 60, 128]);
  adjustPixels(data, { brightness: 0.5, contrast: 0, saturation: 0, warmth: 0 });
  assert.ok(data[0] > 100);
  assert.equal(data[3], 255);
  assert.equal(data[7], 128);
  const blown = new Uint8ClampedArray([250, 250, 250, 255]);
  adjustPixels(blown, { brightness: 1, contrast: 1, saturation: 0, warmth: 0 });
  assert.equal(blown[0], 255);
});

test('adjustPixels leaves a neutral grade untouched', () => {
  const original = [12, 34, 56, 78, 90, 123, 200, 255];
  const data = new Uint8ClampedArray(original);
  adjustPixels(data, DEFAULT_COLOR);
  assert.deepEqual([...data], original);
});

test('supportsCanvasFilter probes the context safely', () => {
  assert.equal(supportsCanvasFilter(null), false);
  assert.equal(supportsCanvasFilter({}), false);
  assert.equal(supportsCanvasFilter({ filter: 'none' }), true);
  const throwing = {
    get filter() {
      return 'none';
    },
    set filter(_value) {
      throw new Error('blocked');
    },
  };
  assert.equal(supportsCanvasFilter(throwing), false);
});

test('custom colours are described with words', () => {
  assert.equal(describeColor({ brightness: 0.2, contrast: 0, saturation: 0, warmth: 0 }), '밝게');
  assert.equal(
    describeColor({ brightness: 0.2, contrast: 0.2, saturation: 0, warmth: 0 }),
    '밝게 · 또렷하게',
  );
});
