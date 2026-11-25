// Export helpers: mime selection, bitrate, progress and ETA.

import { formatFileStamp } from './format.js';
import { clamp } from './util.js';

export const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

/**
 * WebKit records real H.264/AAC when asked for MP4, which Photos and Reels
 * accept directly. Chromium accepts the same MP4 codec string but writes
 * VP9/Opus inside an MP4 box, which many players reject — so non-Apple
 * browsers get WebM first.
 */
export function isAppleWebKit(win) {
  try {
    const vendor = win && win.navigator ? String(win.navigator.vendor || '') : '';
    return /apple/i.test(vendor);
  } catch (error) {
    return false;
  }
}

export function mimeCandidates({ preferMp4 = true } = {}) {
  if (preferMp4) return MIME_CANDIDATES.slice();
  return [
    ...MIME_CANDIDATES.filter((mime) => !mime.includes('mp4')),
    ...MIME_CANDIDATES.filter((mime) => mime.includes('mp4')),
  ];
}

/**
 * Pick the best recording format the browser claims to support.
 * MP4 first on Apple browsers: iOS Photos/SNS accept it directly.
 */
export function pickMimeType(isSupported, options = {}) {
  for (const mime of mimeCandidates(options)) {
    try {
      if (!isSupported || isSupported(mime)) return mime;
    } catch (error) {
      // keep looking
    }
  }
  return '';
}

export function extensionFor(mime) {
  return String(mime || '').includes('mp4') ? 'mp4' : 'webm';
}

export function recorderOptions({ mime, width, height, fps = 30 }) {
  const options = {
    videoBitsPerSecond: videoBitrate(width, height, fps),
    audioBitsPerSecond: 128_000,
  };
  if (mime) options.mimeType = mime;
  return options;
}

export function videoBitrate(width, height, fps = 30) {
  const w = Number(width) || 720;
  const h = Number(height) || 1280;
  const target = Math.round(w * h * fps * 0.11);
  return clamp(target, 2_000_000, 14_000_000);
}

export function exportFileName(mime, date = new Date()) {
  return `릴스컷_${formatFileStamp(date)}.${extensionFor(mime)}`;
}

export function progressOf(timelineTime, total) {
  const t = Number(timelineTime) || 0;
  const d = Number(total) || 0;
  if (d <= 0) return 0;
  return clamp(t / d, 0, 1);
}

/** Remaining seconds estimated from the work actually done so far. */
export function etaSeconds(elapsedSeconds, doneSeconds, totalSeconds) {
  const elapsed = Number(elapsedSeconds) || 0;
  const done = Number(doneSeconds) || 0;
  const total = Number(totalSeconds) || 0;
  if (done <= 0.5 || elapsed <= 0) return null;
  const rate = done / elapsed; // timeline seconds per real second
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.max(0, (total - done) / rate);
}

/** Whether the project needs an audio track at all. */
export function projectHasAudio(sources) {
  const list = sources instanceof Map ? [...sources.values()] : Array.isArray(sources) ? sources : [];
  return list.some((source) => source && source.hasAudio);
}

export function recordingPlan({ sources, size, fps = 30, isSupported, anyAudio, preferMp4 = true }) {
  const mime = pickMimeType(isSupported, { preferMp4 });
  const hasAudio = anyAudio === undefined ? projectHasAudio(sources) : Boolean(anyAudio);
  return {
    mime,
    hasAudio,
    extension: extensionFor(mime),
    options: recorderOptions({ mime, width: size.width, height: size.height, fps }),
  };
}

export const EXPORT_STAGES = Object.freeze({
  idle: 'idle',
  preparing: 'preparing',
  recording: 'recording',
  finishing: 'finishing',
  done: 'done',
  error: 'error',
  cancelled: 'cancelled',
});

export function stageLabel(stage, percent = 0) {
  switch (stage) {
    case EXPORT_STAGES.preparing:
      return '내보낼 준비 중…';
    case EXPORT_STAGES.recording:
      return `영상 만드는 중 ${Math.round(percent * 100)}%`;
    case EXPORT_STAGES.finishing:
      return '마무리하는 중…';
    case EXPORT_STAGES.done:
      return '완성!';
    case EXPORT_STAGES.cancelled:
      return '취소했어요';
    case EXPORT_STAGES.error:
      return '내보내기에 실패했어요';
    default:
      return '준비됨';
  }
}
