// Timeline model: clips, trimming, splitting, ordering and speed math.
// Everything here is pure (no DOM) so it can be unit tested in Node.

import { clamp, round, sum } from './util.js';

export const MIN_CLIP_SECONDS = 0.2;
export const SPEED_PRESETS = [0.5, 0.75, 1, 1.2, 1.5, 2];
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 3;

let idCounter = 0;

export function nextId(prefix = 'c') {
  idCounter += 1;
  return `${prefix}${idCounter}_${Date.now().toString(36).slice(-4)}`;
}

/** Test helper so generated ids are predictable between runs. */
export function resetIdCounter() {
  idCounter = 0;
}

export function normalizeSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return round(clamp(n, MIN_SPEED, MAX_SPEED), 2);
}

/**
 * Build a clip. start/end are seconds in the *source* file.
 * The clip plays source[start..end] at `speed`, so its timeline length is
 * (end - start) / speed.
 */
export function createClip({
  sourceId,
  start = 0,
  end,
  speed = 1,
  sourceDuration,
  id,
} = {}) {
  const duration = Number(sourceDuration);
  if (!sourceId) throw new Error('createClip: sourceId is required');
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('createClip: sourceDuration must be a positive number');
  }
  const min = Math.min(MIN_CLIP_SECONDS, duration);
  const safeStart = clamp(start, 0, Math.max(0, duration - min));
  const rawEnd = Number.isFinite(Number(end)) ? Number(end) : duration;
  const safeEnd = clamp(rawEnd, safeStart + min, duration);
  return {
    id: id || nextId(),
    sourceId,
    start: round(safeStart, 3),
    end: round(safeEnd, 3),
    speed: normalizeSpeed(speed),
    sourceDuration: round(duration, 3),
  };
}

export function clipSourceLength(clip) {
  return Math.max(0, clip.end - clip.start);
}

/** Length this clip occupies on the output timeline. */
export function clipDuration(clip) {
  return clipSourceLength(clip) / normalizeSpeed(clip.speed);
}

export function totalDuration(clips) {
  return sum(clips, clipDuration);
}

/** Lay every clip out on the timeline with cumulative start/end times. */
export function segmentsOf(clips) {
  const out = [];
  let cursor = 0;
  clips.forEach((clip, index) => {
    const duration = clipDuration(clip);
    out.push({
      index,
      clipId: clip.id,
      clip,
      timelineStart: round(cursor, 3),
      timelineEnd: round(cursor + duration, 3),
      duration,
      sourceStart: clip.start,
      sourceEnd: clip.end,
      speed: normalizeSpeed(clip.speed),
    });
    cursor += duration;
  });
  return out;
}

/**
 * Find which clip covers `time` on the timeline, plus the local offset inside
 * that clip and the matching source time.
 */
export function locate(clips, time) {
  const segments = segmentsOf(clips);
  if (!segments.length) return null;
  const total = segments[segments.length - 1].timelineEnd;
  const t = clamp(time, 0, total);
  let seg = segments[segments.length - 1];
  for (const candidate of segments) {
    if (t < candidate.timelineEnd - 1e-9) {
      seg = candidate;
      break;
    }
  }
  const local = clamp(t - seg.timelineStart, 0, seg.duration);
  return {
    ...seg,
    local,
    time: t,
    sourceTime: clamp(seg.sourceStart + local * seg.speed, seg.sourceStart, seg.sourceEnd),
  };
}

/** Move one edge of a clip to a new source time. */
export function trimClip(clip, { start, end } = {}) {
  const min = Math.min(MIN_CLIP_SECONDS, clip.sourceDuration);
  let nextStart = start === undefined ? clip.start : Number(start);
  let nextEnd = end === undefined ? clip.end : Number(end);
  if (!Number.isFinite(nextStart)) nextStart = clip.start;
  if (!Number.isFinite(nextEnd)) nextEnd = clip.end;
  if (nextStart > nextEnd - min) {
    // The edge being dragged wins; keep the other edge legal.
    if (start !== undefined && end === undefined) {
      nextStart = Math.min(nextStart, clip.end - min);
    } else {
      nextEnd = Math.max(nextEnd, clip.start + min);
    }
  }
  nextStart = clamp(nextStart, 0, Math.max(0, clip.sourceDuration - min));
  nextEnd = clamp(nextEnd, nextStart + min, clip.sourceDuration);
  return { ...clip, start: round(nextStart, 3), end: round(nextEnd, 3) };
}

export function setSpeed(clip, speed) {
  return { ...clip, speed: normalizeSpeed(speed) };
}

/** Split a clip at a source time. Returns null when a piece would be too short. */
export function splitClip(clip, sourceTime) {
  const cut = clamp(sourceTime, clip.start, clip.end);
  if (cut - clip.start < MIN_CLIP_SECONDS || clip.end - cut < MIN_CLIP_SECONDS) return null;
  return [
    { ...clip, id: nextId(), end: round(cut, 3) },
    { ...clip, id: nextId(), start: round(cut, 3) },
  ];
}

export function duplicateClip(clip) {
  return { ...clip, id: nextId() };
}

/** Move a clip by `delta` slots (-1 up, +1 down). Returns a new array. */
export function moveClip(clips, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= clips.length || target < 0 || target >= clips.length) {
    return clips.slice();
  }
  const next = clips.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export function removeClip(clips, id) {
  return clips.filter((clip) => clip.id !== id);
}

export function replaceClip(clips, id, nextClip) {
  return clips.map((clip) => (clip.id === id ? nextClip : clip));
}

/** Insert `items` after `index` (index -1 puts them first). */
export function insertClips(clips, index, items) {
  const at = clamp(index + 1, 0, clips.length);
  return [...clips.slice(0, at), ...items, ...clips.slice(at)];
}

/** Total length rounded the way the UI shows it. */
export function displayDuration(clips) {
  return Math.round(totalDuration(clips) * 10) / 10;
}
