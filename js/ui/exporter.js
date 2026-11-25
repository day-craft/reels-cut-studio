// Export pipeline: play the timeline once through, paint every frame into an
// export canvas, capture it with MediaRecorder and return a Blob.
// MP4 is preferred (iOS Photos / Reels friendly), WebM is the fallback.

import { clamp } from '../core/util.js';
import { locate, segmentsOf } from '../core/timeline.js';
import {
  EXPORT_STAGES,
  recorderOptions,
  pickMimeType,
  extensionFor,
  isAppleWebKit,
} from '../core/exporting.js';

export function buildAudioGraph(win, video) {
  const Ctx = win.AudioContext || win.webkitAudioContext;
  if (!Ctx || !video) return null;
  try {
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(video);
    const recordGain = ctx.createGain();
    recordGain.gain.value = 1;
    const monitorGain = ctx.createGain();
    monitorGain.gain.value = 1;
    const destination = ctx.createMediaStreamDestination();
    source.connect(recordGain);
    recordGain.connect(destination);
    source.connect(monitorGain);
    monitorGain.connect(ctx.destination);
    return { ctx, source, recordGain, monitorGain, destination };
  } catch (error) {
    return null;
  }
}

export async function exportVideo({
  win,
  canvas,
  video,
  clips,
  sources,
  drawAt,
  total,
  anyAudio,
  audioGraph,
  onProgress,
  onStage,
  fps = 30,
  signal,
}) {
  if (!win.MediaRecorder) throw new Error('이 브라우저는 영상 저장(MediaRecorder)을 지원하지 않아요.');
  if (!canvas || typeof canvas.captureStream !== 'function') {
    throw new Error('이 브라우저에서는 캔버스 녹화를 지원하지 않아요. 사파리를 최신 버전으로 올려 주세요.');
  }

  const mime = pickMimeType((type) => win.MediaRecorder.isTypeSupported(type), {
    preferMp4: isAppleWebKit(win),
  });
  const stream = canvas.captureStream(fps);
  const wantAudio = Boolean(anyAudio && audioGraph && audioGraph.destination);
  if (wantAudio) {
    const track = audioGraph.destination.stream.getAudioTracks()[0];
    if (track) stream.addTrack(track);
  }

  const recorder = new win.MediaRecorder(stream, recorderOptions({
    mime,
    width: canvas.width,
    height: canvas.height,
    fps,
  }));
  const chunks = [];
  let stage = EXPORT_STAGES.preparing;
  const setStage = (next) => {
    stage = next;
    if (onStage) onStage(next);
  };

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  setStage(EXPORT_STAGES.preparing);
  if (audioGraph) {
    try {
      audioGraph.monitorGain.gain.value = 0;
      await audioGraph.ctx.resume();
    } catch (error) {
      /* keep going muted */
    }
  }

  const stopped = new Promise((resolve) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => resolve();
  });

  try {
    recorder.start(250);
  } catch (error) {
    throw new Error('녹화를 시작하지 못했어요. 사파리에서 다시 시도해 주세요.');
  }
  setStage(EXPORT_STAGES.recording);

  const segments = segmentsOf(clips);
  const startedAt = Date.now();
  let lastError = null;
  let drawnFrames = 0;

  const recorderPause = () => {
    try {
      if (recorder.state === 'recording') recorder.pause();
    } catch (error) {
      /* not supported: transitions keep recording */
    }
  };
  const recorderResume = () => {
    try {
      if (recorder.state === 'paused') recorder.resume();
    } catch (error) {
      /* noop */
    }
  };

  const paint = (globalTime, hit, sourceSize) => {
    drawAt({ time: globalTime, hit, video, sourceSize });
    drawnFrames += 1;
    if (onProgress) {
      onProgress({
        time: globalTime,
        total,
        percent: total > 0 ? clamp(globalTime / total, 0, 1) : 0,
        elapsedSeconds: (Date.now() - startedAt) / 1000,
      });
    }
  };

  try {
    for (let index = 0; index < segments.length; index += 1) {
      if (signal?.aborted) break;
      const seg = segments[index];
      const source = sources.get(seg.clip.sourceId);
      if (!source) continue;

      recorderPause();
      await loadVideo(video, source.url, signal);
      if (signal?.aborted) break;
      video.playbackRate = seg.speed;
      try {
        video.currentTime = seg.sourceStart;
      } catch (error) {
        lastError = error;
      }
      try {
        await video.play();
      } catch (error) {
        lastError = error;
      }
      // Paint the first frame right away, then resume recording so the cut has
      // no frozen gap.
      paint(seg.timelineStart, { ...seg, local: 0, time: seg.timelineStart }, source);
      recorderResume();

      await recordSegment({
        video,
        seg,
        signal,
        onFrame: (current) => {
          const local = clamp((current - seg.sourceStart) / seg.speed, 0, seg.duration);
          const globalTime = Math.min(total, seg.timelineStart + local);
          paint(globalTime, { ...seg, local, time: globalTime }, source);
        },
        win,
      });
    }

    setStage(EXPORT_STAGES.finishing);
    // Hold the final frame briefly so the last frame lands in the recording.
    await sleep(220);
    try {
      if (recorder.state === 'paused') recorder.resume();
    } catch (error) {
      /* noop */
    }
    if (recorder.state !== 'inactive') recorder.stop();
    await Promise.race([stopped, sleep(4000)]);
  } finally {
    if (video && video.pause) video.pause();
    try {
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      /* noop */
    }
    if (audioGraph) {
      try {
        audioGraph.monitorGain.gain.value = 1;
      } catch (error) {
        /* noop */
      }
    }
  }

  if (signal?.aborted) {
    setStage(EXPORT_STAGES.cancelled);
    return { cancelled: true, blob: null, mime, drawnFrames, lastError };
  }

  const type = mime || (chunks[0] && chunks[0].type) || 'video/webm';
  const blob = new Blob(chunks, { type });
  setStage(EXPORT_STAGES.done);
  return {
    blob,
    mime: type,
    extension: extensionFor(type),
    durationSeconds: total,
    drawnFrames,
    lastError,
    realSeconds: (Date.now() - startedAt) / 1000,
  };
}

function recordSegment({ video, seg, signal, onFrame, win }) {
  return new Promise((resolve) => {
    const raf = win.requestAnimationFrame
      ? win.requestAnimationFrame.bind(win)
      : (cb) => setTimeout(() => cb(Date.now()), 16);
    const step = () => {
      if (signal?.aborted) return resolve();
      const current = Number(video.currentTime) || 0;
      onFrame(current);
      if (current >= seg.sourceEnd - 0.035 || video.ended || video.paused) return resolve();
      raf(step);
    };
    step();
  });
}

export function loadVideo(video, url, signal) {
  return new Promise((resolve) => {
    if (video.dataset && video.dataset.loadedUrl === url && video.readyState >= 2) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener?.('loadeddata', finish);
      video.removeEventListener?.('error', finish);
      resolve();
    };
    video.addEventListener?.('loadeddata', finish);
    video.addEventListener?.('error', finish);
    try {
      video.src = url;
      if (video.load) video.load();
    } catch (error) {
      finish();
    }
    if (video.readyState >= 2) finish();
    const timer = setTimeout(finish, 6000);
    if (signal) {
      signal.addEventListener?.('abort', () => {
        clearTimeout(timer);
        finish();
      });
    }
    if (video.dataset) video.dataset.loadedUrl = url;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Patiently wait for a canvas frame to be captured on iOS. */
export async function settleFrame(win, ms = 60) {
  await new Promise((resolve) => {
    const raf = win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : null;
    if (raf) raf(() => resolve());
    else setTimeout(resolve, ms);
  });
}

export { locate };
