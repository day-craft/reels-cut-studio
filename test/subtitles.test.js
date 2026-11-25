import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanSubtitleText,
  validateSubtitleText,
  createSubtitle,
  updateSubtitle,
  subtitleWindows,
  activeSubtitles,
  wrapText,
  layoutSubtitle,
  subtitleFont,
  sizeRatio,
  SUBTITLE_MAX_LENGTH,
} from '../js/core/subtitles.js';
import { segmentsOf, createClip } from '../js/core/timeline.js';

const segments = segmentsOf([
  createClip({ sourceId: 'a', sourceDuration: 4, end: 4 }),
  createClip({ sourceId: 'b', sourceDuration: 10, start: 2, end: 8 }),
]);

test('text cleaning trims, collapses blank lines and caps length', () => {
  assert.equal(cleanSubtitleText('  핑크 크런치  \n\n\n\n좋아!  '), '핑크 크런치\n\n좋아!');
  const long = '가'.repeat(200);
  assert.equal(cleanSubtitleText(long).length, SUBTITLE_MAX_LENGTH);
});

test('validation rejects empty text and accepts normal text', () => {
  assert.equal(validateSubtitleText('   ').valid, false);
  assert.equal(validateSubtitleText('개봉!').valid, true);
  assert.equal(validateSubtitleText('가'.repeat(200)).text.length, SUBTITLE_MAX_LENGTH);
});

test('createSubtitle normalises scope, position, size and range', () => {
  const sub = createSubtitle({
    text: '안녕',
    scope: 'clip',
    clipId: 'c1',
    from: 0.8,
    to: 0.2,
    position: 'nope',
    size: 'huge',
  });
  assert.equal(sub.scope, 'clip');
  assert.equal(sub.clipId, 'c1');
  assert.equal(sub.from, 0.2);
  assert.equal(sub.to, 0.8);
  assert.equal(sub.position, 'bottom');
  assert.equal(sub.size, 'medium');
  // clip scope needs a clip id, otherwise it falls back to the whole video
  const fallback = createSubtitle({ text: 'x', scope: 'clip', clipId: null });
  assert.equal(fallback.scope, 'all');
  assert.equal(fallback.clipId, null);
});

test('updateSubtitle keeps the id', () => {
  const sub = createSubtitle({ text: '처음', size: 'small' });
  const next = updateSubtitle(sub, { text: '바뀜', size: 'large' });
  assert.equal(next.id, sub.id);
  assert.equal(next.text, '바뀜');
  assert.equal(next.size, 'large');
});

test('subtitleWindows keeps whole-video captions stable and places clip captions', () => {
  const total = 10; // segments: 0-4, 4-10
  const all = createSubtitle({ text: '전체', scope: 'all' });
  const clip = createSubtitle({ text: '클립2', scope: 'clip', clipId: segments[1].clipId });

  const windows = subtitleWindows([all, clip], segments, total);
  assert.equal(windows.length, 2);
  assert.deepEqual(
    windows.map((w) => [w.subtitle.text, w.start, w.end]),
    [
      ['전체', 0, 10],
      ['클립2', 4, 10],
    ],
  );
});

test('clip captions follow their clip when speed or trim changes', () => {
  const clips = [createClip({ sourceId: 'a', sourceDuration: 4, end: 4 })];
  const sub = createSubtitle({ text: '두 배속', scope: 'clip', clipId: clips[0].id, from: 0.5, to: 1 });
  const fast = segmentsOf([{ ...clips[0], speed: 2 }]);
  const windows = subtitleWindows([sub], fast, 2);
  assert.deepEqual([windows[0].start, windows[0].end], [1, 2]);
});

test('subtitleWindows skips broken and empty captions', () => {
  const missing = createSubtitle({ text: '없는 클립', scope: 'clip', clipId: 'ghost' });
  const empty = { ...createSubtitle({ text: 'x' }), text: '' };
  assert.deepEqual(subtitleWindows([missing, empty], segments, 10), []);
});

test('activeSubtitles uses a half-open interval', () => {
  const windows = subtitleWindows(
    [createSubtitle({ text: 'A', from: 0, to: 0.5 }), createSubtitle({ text: 'B', from: 0.5, to: 1 })],
    segments,
    10,
  );
  assert.deepEqual(activeSubtitles(windows, 0).map((s) => s.text), ['A']);
  assert.deepEqual(activeSubtitles(windows, 4.9).map((s) => s.text), ['A']);
  assert.deepEqual(activeSubtitles(windows, 5).map((s) => s.text), ['B']);
  assert.deepEqual(activeSubtitles(windows, 99).map((s) => s.text), []);
});

test('wrapText breaks Korean text without spaces by character', () => {
  const measure = (line) => [...line].length * 10;
  const lines = wrapText('핑크크런치수제공개봉', 50, measure);
  assert.ok(lines.length >= 2);
  for (const line of lines) assert.ok(measure(line) <= 50);
  assert.equal(lines.join(''), '핑크크런치수제공개봉');
});

test('wrapText keeps explicit newlines and breaks long Latin words', () => {
  const measure = (line) => [...line].length * 10;
  const lines = wrapText('첫 줄\n두번째줄', 100, measure);
  assert.deepEqual(lines, ['첫 줄', '두번째줄']);
  const long = wrapText('abcdefghijkl', 40, measure);
  assert.deepEqual(long, ['abcd', 'efgh', 'ijkl']);
});

test('layoutSubtitle places the block at the chosen position', () => {
  const width = 720;
  const height = 1280;
  const bottom = layoutSubtitle({ lines: ['한 줄'], canvasWidth: width, canvasHeight: height, position: 'bottom' });
  const center = layoutSubtitle({ lines: ['한 줄'], canvasWidth: width, canvasHeight: height, position: 'center' });
  const top = layoutSubtitle({ lines: ['한 줄'], canvasWidth: width, canvasHeight: height, position: 'top' });

  assert.ok(bottom.box.y > height / 2);
  assert.ok(top.box.y < height / 4);
  assert.ok(center.box.y > top.box.y && center.box.y < bottom.box.y);
  assert.ok(Math.abs(bottom.box.x + bottom.box.width / 2 - width / 2) < 1);
  assert.equal(bottom.textX, width / 2);
  assert.ok(bottom.firstBaseline > bottom.box.y);
  assert.ok(bottom.box.height > bottom.fontPx);
});

test('layoutSubtitle scales with the canvas and size option', () => {
  const small = layoutSubtitle({ lines: ['x'], canvasWidth: 360, canvasHeight: 640, size: 'small' });
  const big = layoutSubtitle({ lines: ['x'], canvasWidth: 360, canvasHeight: 640, size: 'large' });
  assert.ok(big.fontPx > small.fontPx);
  assert.equal(sizeRatio('medium'), 0.042);
  const font = subtitleFont('medium', 1280);
  assert.equal(font.px, Math.round(0.042 * 1280));
  assert.match(font.family, /Apple SD Gothic Neo/);
});

test('multi-line blocks grow taller', () => {
  const one = layoutSubtitle({ lines: ['한 줄'], canvasWidth: 360, canvasHeight: 640 });
  const three = layoutSubtitle({ lines: ['한', '두', '세'], canvasWidth: 360, canvasHeight: 640 });
  assert.ok(three.box.height > one.box.height);
});
