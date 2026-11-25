// Media probing helpers: canvas sizing, aspect-fit math and audio detection.

import { clamp } from './util.js';

export const MAX_LONG_SIDE = 1920;

/** Keep aspect ratio, cap the long side, force even dimensions (H.264). */
export function capSize(width, height, maxLong = MAX_LONG_SIDE) {
  const w = Math.max(2, Number(width) || 0);
  const h = Math.max(2, Number(height) || 0);
  const scale = Math.min(1, maxLong / Math.max(w, h));
  const even = (n) => {
    const r = Math.round(n);
    return r % 2 === 0 ? r : r - 1;
  };
  return { width: Math.max(2, even(w * scale)), height: Math.max(2, even(h * scale)) };
}

/** Where a source frame goes inside the output frame ("contain" letterbox). */
export function fitRect(sourceWidth, sourceHeight, destWidth, destHeight, mode = 'contain') {
  const sw = Math.max(1, Number(sourceWidth) || 1);
  const sh = Math.max(1, Number(sourceHeight) || 1);
  const dw = Math.max(1, Number(destWidth) || 1);
  const dh = Math.max(1, Number(destHeight) || 1);
  if (mode === 'cover') {
    const scale = Math.max(dw / sw, dh / sh);
    const w = sw * scale;
    const h = sh * scale;
    return { x: (dw - w) / 2, y: (dh - h) / 2, width: w, height: h, scale };
  }
  const scale = Math.min(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, width: w, height: h, scale };
}

/**
 * Best-effort audio detection across engines.
 * Returns true when the file probably has an audio track; false when the
 * browser can prove there is none. `unknown` never blocks playback.
 */
export function hasAudioTrack(video) {
  if (!video) return false;
  const moz = video.mozHasAudio;
  if (typeof moz === 'boolean') return moz;
  const webkitBytes = video.webkitAudioDecodedByteCount;
  if (typeof webkitBytes === 'number') {
    if (webkitBytes > 0) return true;
    // 0 can also mean "not decoded yet"; keep it unknown until metadata says so.
  }
  if (video.audioTracks && typeof video.audioTracks.length === 'number') {
    return video.audioTracks.length > 0;
  }
  if (typeof video.mozHasAudio === 'undefined' && typeof webkitBytes === 'undefined') {
    return true; // assume audio rather than silently dropping it
  }
  return true;
}

export function readVideoMeta(video) {
  const width = Number(video.videoWidth) || Number(video.width) || 0;
  const height = Number(video.videoHeight) || Number(video.height) || 0;
  const duration = Number(video.duration);
  return {
    width,
    height,
    duration: Number.isFinite(duration) ? duration : 0,
    hasAudio: hasAudioTrack(video),
  };
}

export function isVideoFile(file) {
  if (!file) return false;
  const type = String(file.type || '');
  if (type.startsWith('video/')) return true;
  const name = String(file.name || '').toLowerCase();
  return /\.(mp4|mov|m4v|webm|qt)$/.test(name);
}

export function isIOS(userAgent = '') {
  const ua = String(userAgent);
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));
}

/**
 * Recorded WebM files often report `duration = Infinity` until they are seeked.
 * Nudge the element to the end once so the real duration appears.
 */
export function resolveDuration(video, timeoutMs = 2000) {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return Promise.resolve(video.duration);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('durationchange', onChange);
      try {
        video.currentTime = 0;
      } catch (error) {
        /* noop */
      }
      resolve(Number.isFinite(video.duration) ? video.duration : 0);
    };
    const onChange = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) finish();
    };
    video.addEventListener('durationchange', onChange);
    try {
      video.currentTime = 1e101;
    } catch (error) {
      finish();
      return;
    }
    const timer = setTimeout(finish, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

/** Wait until a media element knows its duration/size, or time out. */
export function waitForMetadata(video, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && Number(video.duration) > 0) {
      resolve(readVideoMeta(video));
      return;
    }
    let timer = null;
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      if (timer) clearTimeout(timer);
    };
    const onLoaded = () => {
      cleanup();
      resolve(readVideoMeta(video));
    };    const onError = () => {
      cleanup();
      reject(new Error('영상을 읽지 못했어요. 다른 파일로 시도해 주세요.'));
    };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
    timer = setTimeout(() => {
      cleanup();
      if (Number(video.duration) > 0) resolve(readVideoMeta(video));
      else reject(new Error('영상 정보를 읽는 데 시간이 너무 오래 걸려요.'));
    }, timeoutMs);
  }).then(async (meta) => {
    if (meta && Number.isFinite(meta.duration) && meta.duration > 0) return meta;
    const fixed = await resolveDuration(video);
    const next = { ...meta, duration: fixed };
    if (!(next.duration > 0)) throw new Error('영상 길이를 읽지 못했어요.');
    return next;
  });
}

export function aspectLabel(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return '';
  if (Math.abs(w / h - 9 / 16) < 0.02) return '세로 9:16';
  if (Math.abs(w / h - 16 / 9) < 0.02) return '가로 16:9';
  if (Math.abs(w / h - 1) < 0.02) return '정사각';
  if (Math.abs(w / h - 4 / 5) < 0.02) return '세로 4:5';
  return h > w ? '세로' : '가로';
}

export function evenClamp(value) {
  return clamp(Math.round(value), 0, 1e6);
}
