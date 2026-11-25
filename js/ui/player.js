// Real-time preview player. Drives one <video> element across the clip list and
// repaints the canvas on every frame, so the preview and the export share the
// exact same drawing code.

import { clamp } from '../core/util.js';
import { locate, segmentsOf, totalDuration } from '../core/timeline.js';

export function createPlayer({ video, draw, raf, caf, onUpdate, onEnded }) {
  let clips = [];
  let sources = new Map();
  let total = 0;
  let playing = false;
  let token = 0;
  let handle = null;
  let time = 0;
  let loadedSourceId = null;

  function emit() {
    if (onUpdate) onUpdate({ time, total, playing, index: currentIndex() });
  }

  function currentIndex() {
    const hit = locate(clips, time);
    return hit ? hit.index : -1;
  }

  function cancelLoop() {
    if (handle !== null && caf) caf(handle);
    handle = null;
  }

  function setTimeline(nextClips, nextSources) {
    clips = Array.isArray(nextClips) ? nextClips : [];
    if (nextSources) sources = nextSources;
    total = totalDuration(clips);
    time = clamp(time, 0, total);
    emit();
  }

  function loadSource(url) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (video.removeEventListener) {
          video.removeEventListener('loadeddata', finish);
          video.removeEventListener('error', finish);
        }
        resolve();
      };
      if (video.addEventListener) {
        video.addEventListener('loadeddata', finish);
        video.addEventListener('error', finish);
      }
      try {
        video.src = url;
        if (video.load) video.load();
      } catch (error) {
        finish();
      }
      if (typeof video.readyState === 'number' && video.readyState >= 2) finish();
      const timer = setTimeout(finish, 4000);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  async function ensureSource(clip, myToken) {
    const source = sources.get(clip.sourceId);
    if (!source) return false;
    if (loadedSourceId === clip.sourceId) return true;
    if (myToken !== token) return false;
    await loadSource(source.url);
    if (myToken !== token) return false;
    loadedSourceId = clip.sourceId;
    return true;
  }

  function drawAt(t) {
    const hit = locate(clips, t);
    if (!hit) return null;
    draw({ video, time: t, hit });
    return hit;
  }

  async function seek(nextTime) {
    token += 1;
    const my = token;
    playing = false;
    cancelLoop();
    if (video.pause) video.pause();
    time = clamp(nextTime, 0, total);
    const hit = locate(clips, time);
    if (!hit) {
      emit();
      return;
    }
    const ok = await ensureSource(hit.clip, my);
    if (my !== token) return;
    if (ok) {
      try {
        video.playbackRate = hit.speed;
        video.currentTime = hit.sourceTime;
      } catch (error) {
        /* ignore seek errors on unloaded media */
      }
    }
    drawAt(time);
    emit();
  }

  async function play() {
    if (playing || !clips.length) return;
    token += 1;
    const my = token;
    playing = true;
    if (time >= total - 0.02) time = 0;
    emit();
    await run(my, time);
  }

  async function run(myToken, startTime) {
    let cursor = startTime;
    while (myToken === token) {
      const hit = locate(clips, cursor);
      if (!hit) break;
      const ok = await ensureSource(hit.clip, myToken);
      if (!ok || myToken !== token) break;
      try {
        video.playbackRate = hit.speed;
        video.currentTime = hit.sourceTime;
      } catch (error) {
        break;
      }
      try {
        await video.play();
      } catch (error) {
        break;
      }
      if (myToken !== token) break;
      await runSegment(hit, myToken);
      if (myToken !== token) break;
      cursor = hit.timelineEnd;
      if (cursor >= total - 0.01) break;
    }
    if (myToken !== token) return;
    playing = false;
    cancelLoop();
    emit();
    if (onEnded) onEnded();
  }

  function runSegment(hit, myToken) {
    return new Promise((resolve) => {
      const step = () => {
        if (myToken !== token) return resolve();
        const current = Number(video.currentTime) || 0;
        const local = clamp((current - hit.sourceStart) / hit.speed, 0, hit.duration);
        time = Math.min(total, hit.timelineStart + local);
        drawAt(time);
        emit();
        const atEnd = current >= hit.sourceEnd - 0.04;
        const stalled = video.paused && !video.ended;
        if (atEnd || video.ended || stalled) return resolve();
        handle = raf(step);
      };
      step();
    });
  }

  function pause() {
    token += 1;
    playing = false;
    cancelLoop();
    if (video.pause) video.pause();
    emit();
  }

  function refresh() {
    drawAt(time);
    emit();
  }

  function setTime(nextTime) {
    time = clamp(nextTime, 0, total);
    emit();
  }

  return {
    setTimeline,
    seek,
    play,
    pause,
    refresh,
    setTime,
    getTime: () => time,
    getTotal: () => total,
    isPlaying: () => playing,
    getLoadedSourceId: () => loadedSourceId,
    getSegments: () => segmentsOf(clips),
  };
}
