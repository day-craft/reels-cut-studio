import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_CLIP_SECONDS,
  createClip,
  clipDuration,
  totalDuration,
  segmentsOf,
  locate,
  trimClip,
  setSpeed,
  splitClip,
  duplicateClip,
  moveClip,
  removeClip,
  replaceClip,
  insertClips,
  normalizeSpeed,
  resetIdCounter,
} from '../js/core/timeline.js';

function clip(overrides = {}) {
  return createClip({
    sourceId: 'src1',
    sourceDuration: 10,
    start: 0,
    end: 10,
    speed: 1,
    ...overrides,
  });
}

test('createClip clamps the range into the source', () => {
  resetIdCounter();
  const c = createClip({ sourceId: 's', sourceDuration: 10, start: -3, end: 99 });
  assert.equal(c.start, 0);
  assert.equal(c.end, 10);
  assert.equal(c.speed, 1);
  assert.equal(c.sourceDuration, 10);
});

test('createClip keeps a minimum length and snaps a valid range', () => {
  const c = createClip({ sourceId: 's', sourceDuration: 5, start: 4.95, end: 5 });
  assert.ok(c.end - c.start >= MIN_CLIP_SECONDS - 1e-9);
  assert.ok(c.start >= 0);
  const d = createClip({ sourceId: 's', sourceDuration: 5, start: 1, end: 3.5 });
  assert.equal(d.start, 1);
  assert.equal(d.end, 3.5);
});

test('createClip rejects missing sources', () => {
  assert.throws(() => createClip({ sourceDuration: 5 }));
  assert.throws(() => createClip({ sourceId: 's', sourceDuration: 0 }));
});

test('clipDuration divides by speed and totalDuration sums clips', () => {
  const a = clip({ end: 4, speed: 1 });
  const b = clip({ end: 10, speed: 2 });
  assert.equal(clipDuration(a), 4);
  assert.equal(clipDuration(b), 5);
  assert.equal(totalDuration([a, b]), 9);
});

test('segmentsOf lays clips out with cumulative times', () => {
  const a = clip({ end: 3 });
  const b = clip({ end: 6, speed: 0.5 });
  const segments = segmentsOf([a, b]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].timelineStart, 0);
  assert.equal(segments[0].timelineEnd, 3);
  assert.equal(segments[1].timelineStart, 3);
  assert.equal(segments[1].timelineEnd, 15);
  assert.equal(segments[1].sourceStart, 0);
  assert.equal(segments[1].sourceEnd, 6);
});

test('locate maps timeline time into clip and source time', () => {
  const a = clip({ end: 4 });
  const b = createClip({ sourceId: 'src1', sourceDuration: 10, start: 4, end: 10, speed: 2 });
  const list = [a, b];
  const hitFirst = locate(list, 2);
  assert.equal(hitFirst.index, 0);
  assert.equal(hitFirst.sourceTime, 2);

  const hitSecond = locate(list, 5); // b lasts (10-4)/2 = 3s → 4..7
  assert.equal(hitSecond.index, 1);
  assert.ok(Math.abs(hitSecond.sourceTime - 6) < 1e-6);

  assert.equal(locate(list, 999).index, 1);
  assert.equal(locate(list, -5).sourceTime, 0);
  assert.equal(locate([], 3), null);
});

test('locate at a boundary belongs to the next clip', () => {
  const list = [clip({ end: 4 }), createClip({ sourceId: 'src1', sourceDuration: 10, start: 4, end: 10 })];
  const hit = locate(list, 4);
  assert.equal(hit.index, 1);
  assert.equal(hit.sourceTime, 4);
});

test('trimClip respects the other edge and the source length', () => {
  const c = clip({ start: 2, end: 8 });
  const trimmedStart = trimClip(c, { start: 9 });
  assert.ok(trimmedStart.end - trimmedStart.start >= MIN_CLIP_SECONDS - 1e-9);
  assert.ok(trimmedStart.start <= 8 - MIN_CLIP_SECONDS + 1e-9);
  const trimmedEnd = trimClip(c, { end: 1 });
  assert.ok(trimmedEnd.end - trimmedEnd.start >= MIN_CLIP_SECONDS - 1e-9);
  assert.equal(trimmedEnd.start, 2);
  const wide = trimClip(c, { start: -5, end: 100 });
  assert.equal(wide.start, 0);
  assert.equal(wide.end, 10);
});

test('setSpeed clamps to the supported range', () => {
  const c = clip();
  assert.equal(setSpeed(c, 2).speed, 2);
  assert.equal(setSpeed(c, 0.1).speed, 0.25);
  assert.equal(setSpeed(c, 99).speed, 3);
  assert.equal(normalizeSpeed('nope'), 1);
});

test('splitClip cuts into two clips with new ids', () => {
  const c = clip({ start: 0, end: 10 });
  const parts = splitClip(c, 4);
  assert.ok(parts);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].start, 0);
  assert.equal(parts[0].end, 4);
  assert.equal(parts[1].start, 4);
  assert.equal(parts[1].end, 10);
  assert.notEqual(parts[0].id, parts[1].id);
  assert.notEqual(parts[0].id, c.id);
  // total duration preserved
  assert.ok(Math.abs(totalDuration(parts) - clipDuration(c)) < 1e-6);
});

test('splitClip refuses cuts too close to an edge', () => {
  const c = clip({ start: 0, end: 2 });
  assert.equal(splitClip(c, 0.05), null);
  assert.equal(splitClip(c, 1.95), null);
  assert.ok(splitClip(c, 1));
});

test('duplicate, move, remove, replace and insert keep the list consistent', () => {
  const a = clip({ end: 2 });
  const b = clip({ end: 3 });
  const c = clip({ end: 4 });
  const copy = duplicateClip(a);
  assert.equal(copy.start, a.start);
  assert.notEqual(copy.id, a.id);

  const moved = moveClip([a, b, c], 0, 1);
  assert.deepEqual(moved.map((x) => x.id), [b.id, a.id, c.id]);
  assert.deepEqual(moveClip([a, b, c], 0, -1).map((x) => x.id), [a.id, b.id, c.id]);
  assert.deepEqual(moveClip([a, b, c], 2, 1).map((x) => x.id), [a.id, b.id, c.id]);

  const removed = removeClip([a, b, c], b.id);
  assert.deepEqual(removed.map((x) => x.id), [a.id, c.id]);

  const replaced = replaceClip([a, b], a.id, { ...a, speed: 2 });
  assert.equal(replaced[0].speed, 2);
  assert.equal(replaced[1].id, b.id);

  const inserted = insertClips([a, c], 0, [b]);
  assert.deepEqual(inserted.map((x) => x.id), [a.id, b.id, c.id]);
  const appended = insertClips([a], 0, [b, c]);
  assert.deepEqual(appended.map((x) => x.id), [a.id, b.id, c.id]);
});

test('a full trim → split → reorder flow keeps durations honest', () => {
  let clips = [
    clip({ sourceDuration: 12, start: 0, end: 6 }),
    clip({ sourceDuration: 20, start: 2, end: 12 }),
  ];
  clips[0] = trimClip(clips[0], { start: 1.5, end: 5 });
  const parts = splitClip(clips[1], 7);
  clips = [...clips.slice(0, 1), ...parts];
  clips = moveClip(clips, 0, 2);
  clips[0] = setSpeed(clips[0], 2);
  const total = totalDuration(clips);
  const expected = (7 - 2) / 2 + (12 - 7) / 1 + (5 - 1.5) / 1;
  assert.ok(Math.abs(total - expected) < 1e-6);
  assert.equal(segmentsOf(clips).length, 3);
});
