import test from 'node:test';
import assert from 'node:assert/strict';

import { drawFrame, fitContain, drawSubtitle } from '../js/core/render.js';
import { DEFAULT_COLOR } from '../js/core/color.js';
import { createSubtitle } from '../js/core/subtitles.js';

function mockCtx() {
  const calls = [];
  const ctx = {
    calls,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: '',
    textBaseline: '',
    lineJoin: '',
    globalCompositeOperation: 'source-over',
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    drawImage: (...args) => calls.push(['drawImage', ...args]),
    getImageData: (x, y, w, h) => {
      calls.push(['getImageData', x, y, w, h]);
      return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)) };
    },
    putImageData: () => calls.push(['putImageData']),
    measureText: (text) => ({ width: [...text].length * 20 }),
    fillText: (...args) => calls.push(['fillText', ...args]),
    strokeText: (...args) => calls.push(['strokeText', ...args]),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    closePath: () => {},
    fill: () => calls.push(['fill']),
  };
  let filterValue = 'none';
  Object.defineProperty(ctx, 'filter', {
    get: () => filterValue,
    set: (value) => {
      filterValue = value;
      calls.push(['filter', value]);
    },
    configurable: true,
  });
  return ctx;
}

test('fitContain letterboxes a landscape source in a portrait frame', () => {
  const rect = fitContain(1280, 720, 360, 640);
  assert.equal(rect.width, 360);
  assert.ok(Math.abs(rect.height - 202.5) < 1e-6);
  assert.ok(Math.abs(rect.y - (640 - 202.5) / 2) < 1e-6);
  assert.equal(rect.x, 0);
});

test('drawFrame paints a background and fits a 9:16 source exactly', () => {
  const ctx = mockCtx();
  const metrics = drawFrame(ctx, {
    width: 360,
    height: 640,
    video: { id: 'v' },
    videoWidth: 720,
    videoHeight: 1280,
    color: DEFAULT_COLOR,
  });
  const fills = ctx.calls.filter((c) => c[0] === 'fillRect');
  const draws = ctx.calls.filter((c) => c[0] === 'drawImage');
  assert.equal(fills.length, 1);
  assert.deepEqual(fills[0].slice(1), [0, 0, 360, 640]);
  assert.equal(draws.length, 1);
  assert.deepEqual(draws[0].slice(2), [0, 0, 360, 640]);
  assert.deepEqual(metrics.videoRect, { x: 0, y: 0, width: 360, height: 640, scale: 0.5 });
  assert.deepEqual(metrics.subtitleBoxes, []);
});

test('drawFrame returns empty metrics without a video', () => {
  const ctx = mockCtx();
  const metrics = drawFrame(ctx, { width: 360, height: 640, video: null });
  assert.equal(ctx.calls.filter((c) => c[0] === 'drawImage').length, 0);
  assert.equal(metrics.videoRect, null);
});

test('a graded frame uses ctx.filter when supported', () => {
  const ctx = mockCtx();
  drawFrame(ctx, {
    width: 360,
    height: 640,
    video: {},
    videoWidth: 720,
    videoHeight: 1280,
    color: { brightness: 0.5, contrast: 0, saturation: 0, warmth: 0 },
    filterSupported: true,
  });
  const saveIndex = ctx.calls.findIndex((c) => c[0] === 'save');
  assert.ok(saveIndex >= 0);
  const filters = ctx.calls.filter((c) => c[0] === 'filter').map((c) => c[1]);
  assert.ok(filters.some((value) => /brightness\(1\.25\)/.test(String(value))), filters.join(' | '));
  assert.ok(!ctx.calls.some((c) => c[0] === 'getImageData'));
});

test('a graded frame falls back to pixels when ctx.filter is missing', () => {
  const ctx = mockCtx();
  drawFrame(ctx, {
    width: 360,
    height: 640,
    video: {},
    videoWidth: 720,
    videoHeight: 1280,
    color: { brightness: 0.5, contrast: 0, saturation: 0, warmth: 0 },
    filterSupported: false,
  });
  assert.ok(ctx.calls.some((c) => c[0] === 'getImageData'));
  assert.ok(ctx.calls.some((c) => c[0] === 'putImageData'));
});

test('warmth is drawn as a soft-light veil over the video rect', () => {
  const ctx = mockCtx();
  drawFrame(ctx, {
    width: 360,
    height: 640,
    video: {},
    videoWidth: 720,
    videoHeight: 1280,
    color: { brightness: 0, contrast: 0, saturation: 0, warmth: 0.6 },
    filterSupported: true,
  });
  const veil = ctx.calls.filter((c) => c[0] === 'fillRect')[1];
  assert.ok(veil, 'warm veil should fill the video rect');
  assert.match(String(ctx.fillStyle), /rgba\(255, 176, 92/);
});

test('subtitles are measured, wrapped and drawn on the canvas', () => {
  const ctx = mockCtx();
  const metrics = drawFrame(ctx, {
    width: 360,
    height: 640,
    video: {},
    videoWidth: 720,
    videoHeight: 1280,
    color: DEFAULT_COLOR,
    subtitles: [createSubtitle({ text: '핑크 크런치 수제공 개봉!', position: 'bottom' })],
  });
  const texts = ctx.calls.filter((c) => c[0] === 'fillText');
  assert.ok(texts.length >= 1);
  assert.equal(texts.map((c) => c[1]).join(' ').includes('핑크'), true);
  assert.equal(metrics.subtitleBoxes.length, 1);
  assert.ok(metrics.subtitleBoxes[0].y > 640 / 2);
});

test('a transparent-background subtitle gets a stroke for readability', () => {
  const ctx = mockCtx();
  drawSubtitle(ctx, createSubtitle({ text: '자막', background: false }), 360, 640);
  assert.ok(ctx.calls.some((c) => c[0] === 'strokeText'));
  assert.ok(!ctx.calls.some((c) => c[0] === 'fill'));
});

test('empty subtitles draw nothing', () => {
  const ctx = mockCtx();
  assert.equal(drawSubtitle(ctx, createSubtitle({ text: '   ' }), 360, 640), null);
  assert.equal(ctx.calls.length, 0);
});
