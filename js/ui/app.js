// App wiring: DOM, state, editor actions, preview and export UI.
// Everything the browser-specific parts need is injected, so the same module
// can be exercised in jsdom with a fake media adapter and a fake video element.

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
} from '../core/timeline.js';
import {
  DEFAULT_COLOR,
  COLOR_PRESETS,
  normalizeColor,
  matchPreset,
  describeColor,
  supportsCanvasFilter,
} from '../core/color.js';
import {
  createSubtitle,
  updateSubtitle,
  validateSubtitleText,
  subtitleWindows,
  activeSubtitles,
} from '../core/subtitles.js';
import {
  formatTimecode,
  formatSpeed,
  formatSeconds,
  formatBytes,
  formatPercent,
} from '../core/format.js';
import { drawFrame } from '../core/render.js';
import { capSize, isVideoFile, waitForMetadata } from '../core/media.js';
import {
  exportFileName,
  projectHasAudio,
  etaSeconds,
  stageLabel,
  EXPORT_STAGES,
} from '../core/exporting.js';
import { createPlayer } from './player.js';
import { exportVideo, buildAudioGraph } from './exporter.js';

const PREVIEW_LONG_SIDE = 540;

export function createMediaAdapter(doc, win) {
  let counter = 0;
  return {
    async load(file) {
      counter += 1;
      const id = `src${counter}`;
      const url = win.URL.createObjectURL(file);
      const video = doc.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      if (video.setAttribute) video.setAttribute('playsinline', '');
      video.src = url;
      // iOS 사파리는 문서에 붙지 않은 <video>에서 캔버스로 프레임을 못 그리는 경우가 있어
      // 화면 밖에 잠깐 붙였다가 썸네일을 뽑은 뒤 치운다.
      try {
        video.style.cssText =
          'position:fixed;left:-4px;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
        if (doc.body && doc.body.appendChild) doc.body.appendChild(video);
      } catch (error) {
        /* noop */
      }
      if (video.load) video.load();
      const meta = await waitForMetadata(video);
      const cleanup = () => {
        try {
          if (video.pause) video.pause();
          if (video.remove) video.remove();
        } catch (error) {
          /* noop */
        }
      };
      const source = {
        id,
        name: file.name || '영상',
        url,
        thumb: '',
        file,
        ...meta,
      };
      // 썸네일은 불러오기를 기다리게 하지 않고 뒤에서 뽑아 화면만 갱신한다.
      source.thumbPromise = grabThumb(doc, video, meta, win)
        .catch(() => '')
        .then((thumb) => {
          cleanup();
          return thumb;
        });
      return source;
    },
  };
}

const THUMB_WIDTH = 132;

function nextFrame(win) {
  return new Promise((resolve) => {
    if (win && typeof win.requestAnimationFrame === 'function') {
      win.requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });
}

/** iOS 사파리는 메타데이터만으로는 프레임을 그리지 못한다. 실제 데이터가 올 때까지 기다린다. */
function waitForFrameData(video, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!video) {
      resolve(false);
      return;
    }
    if (video.readyState >= 2 && video.videoWidth) {
      resolve(true);
      return;
    }
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      video.removeEventListener('loadeddata', onData);
      video.removeEventListener('canplay', onData);
      resolve(ok);
    };
    const onData = () => finish(true);
    video.addEventListener('loadeddata', onData);
    video.addEventListener('canplay', onData);
    timer = setTimeout(() => finish(video.readyState >= 2), timeoutMs);
  });
}

function seekAndSettle(video, time, timeoutMs = 2200) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      video.removeEventListener('seeked', finish);
      resolve();
    };
    video.addEventListener('seeked', finish);
    timer = setTimeout(finish, timeoutMs);
    const before = Number(video.currentTime) || 0;
    const destination = Math.abs(before - time) < 0.01 ? time + 0.08 : time;
    try {
      video.currentTime = destination;
    } catch (error) {
      finish();
    }
  });
}

function isNearlyBlack(ctx, width, height) {
  try {
    const { data } = ctx.getImageData(0, 0, width, height);
    let total = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4 * 17) {
      total += data[i] + data[i + 1] + data[i + 2];
      count += 3;
    }
    if (!count) return true;
    return total / count < 10;
  } catch (error) {
    // 픽셀을 읽을 수 없는 환경(테스트 등)에서는 그 프레임을 그대로 쓴다.
    return false;
  }
}

/**
 * 첫 프레임 썸네일을 뽑는다. iOS 사파리에서 디코딩 전 drawImage가 검은 프레임을
 * 찍는 문제를 피하려고 준비 대기 + 두 번의 화면 프레임 대기 + 검정 판별 후
 * 다른 지점에서 재시도를 한다. 끝까지 실패하면 빈 문자열을 돌려주고,
 * 화면은 파스텔 카드로 대신한다(검은 막대가 보이지 않게).
 */
export async function grabThumb(doc, video, meta, win = globalThis.window) {
  if (!video || !meta || !meta.width || !meta.height) return '';
  const width = THUMB_WIDTH;
  const height = Math.max(2, Math.round((width * meta.height) / meta.width));
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return '';
  await waitForFrameData(video);
  const duration = Number(meta.duration) > 0 ? Number(meta.duration) : 1;
  const spots = [
    Math.min(0.28, duration * 0.1) + 0.04,
    Math.min(duration * 0.5, 1.5),
    0.04,
  ];
  for (const spot of spots) {
    await seekAndSettle(video, spot);
    await nextFrame(win);
    await nextFrame(win);
    try {
      ctx.drawImage(video, 0, 0, width, height);
    } catch (error) {
      continue;
    }
    if (!isNearlyBlack(ctx, width, height)) {
      try {
        return canvas.toDataURL('image/jpeg', 0.72);
      } catch (error) {
        return '';
      }
    }
  }
  return '';
}

export function createApp(options = {}) {
  const doc = options.doc || globalThis.document;
  const win = options.win || globalThis.window;
  const media = options.media || createMediaAdapter(doc, win);
  const frameDrawer = options.drawFrame || drawFrame;

  const $ = (id) => doc.getElementById(id);
  const el = {
    appRoot: $('app'),
    emptyState: $('emptyState'),
    editor: $('editor'),
    dock: $('dock'),
    pickBtn: $('pickBtn'),
    fileInput: $('fileInput'),
    previewCanvas: $('previewCanvas'),
    previewFrame: $('previewFrame'),
    previewBadge: $('previewBadge'),
    previewOverlay: $('previewOverlay'),
    playBtn: $('playBtn'),
    seekBar: $('seekBar'),
    curTime: $('curTime'),
    totalTime: $('totalTime'),
    clipStrip: $('clipStrip'),
    clipCard: $('clipCard'),
    clipThumb: $('clipThumb'),
    clipTitle: $('clipTitle'),
    clipSub: $('clipSub'),
    upBtn: $('upBtn'),
    downBtn: $('downBtn'),
    trimStart: $('trimStart'),
    trimEnd: $('trimEnd'),
    trimStartLabel: $('trimStartLabel'),
    trimEndLabel: $('trimEndLabel'),
    markStartBtn: $('markStartBtn'),
    markEndBtn: $('markEndBtn'),
    splitBtn: $('splitBtn'),
    dupBtn: $('dupBtn'),
    delBtn: $('delBtn'),
    addMoreBtn: $('addMoreBtn'),
    speedChips: $('speedChips'),
    speedValue: $('speedValue'),
    speedFine: $('speedFine'),
    colorMood: $('colorMood'),
    colorPresets: $('colorPresets'),
    resetColorBtn: $('resetColorBtn'),
    subFormTitle: $('subFormTitle'),
    subText: $('subText'),
    subScope: $('subScope'),
    subFrom: $('subFrom'),
    subTo: $('subTo'),
    subRangeLabel: $('subRangeLabel'),
    subPositions: $('subPositions'),
    subSizes: $('subSizes'),
    subColors: $('subColors'),
    subBg: $('subBg'),
    subAddBtn: $('subAddBtn'),
    subCancelEdit: $('subCancelEdit'),
    subList: $('subList'),
    subCount: $('subCount'),
    subEmpty: $('subEmpty'),
    exportBtn: $('exportBtn'),
    dockDuration: $('dockDuration'),
    dockMeta: $('dockMeta'),
    infoBtn: $('infoBtn'),
    infoSheet: $('infoSheet'),
    exportSheet: $('exportSheet'),
    expStage: $('expStage'),
    expBar: $('expBar'),
    expPercent: $('expPercent'),
    expEta: $('expEta'),
    expResult: $('expResult'),
    expVideo: $('expVideo'),
    expFileInfo: $('expFileInfo'),
    expCancelBtn: $('expCancel'),
    expClose: $('expClose'),
    shareBtn: $('shareBtn'),
    downloadBtn: $('downloadBtn'),
    expNote: $('expNote'),
    toast: $('toast'),
    toastMsg: $('toastMsg'),
    undoBtn: $('undoBtn'),
    exportCanvas: $('exportCanvas'),
    video: options.videoEl || $('mediaVideo'),
  };

  const state = {
    sources: new Map(),
    clips: [],
    color: { ...DEFAULT_COLOR },
    subtitles: [],
    selectedId: null,
    time: 0,
    editingSubId: null,
    draft: {
      scope: 'all',
      position: 'bottom',
      size: 'medium',
      color: '#ffffff',
      background: true,
      from: 0,
      to: 1,
    },
    exportBlob: null,
    exportMime: '',
    exportUrl: '',
    exporting: false,
    size: { width: 720, height: 1280 },
  };

  let history = [];
  let trimDirty = false;
  let colorDirty = false;
  let toastTimer = null;
  let filterSupported = false;
  let audioGraph = null;
  let abortController = null;
  let wakeLock = null;
  let exportCtx = null;
  let exportSize = { width: 720, height: 1280 };
  let seekPending = null;

  const previewCtx =
    el.previewCanvas && el.previewCanvas.getContext ? el.previewCanvas.getContext('2d') : null;
  filterSupported = supportsCanvasFilter(previewCtx);

  const previewSize = { width: 360, height: 640 };
  if (el.previewCanvas) {
    el.previewCanvas.width = previewSize.width;
    el.previewCanvas.height = previewSize.height;
  }

  const player =
    options.player ||
    createPlayer({
      video: el.video,
      draw: drawPreview,
      raf: (cb) => (win.requestAnimationFrame ? win.requestAnimationFrame(cb) : setTimeout(cb, 16)),
      caf: (handle) =>
        win.cancelAnimationFrame ? win.cancelAnimationFrame(handle) : clearTimeout(handle),
      onUpdate: handleUpdate,
      onEnded: () => setPlayingUI(false),
    });

  /* ── rendering ─────────────────────────────────────────── */

  function activeSubtitleList(time) {
    const segments = segmentsOf(state.clips);
    const windows = subtitleWindows(state.subtitles, segments, totalDuration(state.clips));
    return activeSubtitles(windows, time);
  }

  function paint(ctx, size, videoEl, hit, time) {
    const source = hit ? state.sources.get(hit.clip.sourceId) : null;
    frameDrawer(ctx, {
      width: size.width,
      height: size.height,
      video: videoEl,
      videoWidth: source ? source.width : 0,
      videoHeight: source ? source.height : 0,
      color: state.color,
      filterSupported,
      subtitles: activeSubtitleList(time),
    });
  }

  function drawPreview({ video, time, hit }) {
    paint(previewCtx, previewSize, video, hit, time);
  }

  function drawExportFrame({ video, hit, time }) {
    if (!exportCtx) return;
    paint(exportCtx, exportSize, video, hit, time);
  }

  function applyProjectSize() {
    const first = state.clips.length ? state.sources.get(state.clips[0].sourceId) : null;
    if (first && first.width && first.height) {
      state.size = capSize(first.width, first.height, 1920);
    }
    const preview = capSize(state.size.width, state.size.height, PREVIEW_LONG_SIDE);
    previewSize.width = preview.width;
    previewSize.height = preview.height;
    if (el.previewCanvas) {
      el.previewCanvas.width = preview.width;
      el.previewCanvas.height = preview.height;
    }
    if (el.previewBadge) {
      el.previewBadge.textContent = `${state.size.width} × ${state.size.height}`;
    }
    if (el.previewFrame) {
      // 세로 화면에서는 미리보기를 컴팩트하게(30dvh · 최대 240px) 두고,
      // 남는 세로 공간은 클립·색감·자막 패널이 쓰게 한다.
      el.previewFrame.style.aspectRatio = `${preview.width} / ${preview.height}`;
      el.previewFrame.style.width = `min(100%, calc(clamp(180px, 30dvh, 240px) * ${(preview.width / preview.height).toFixed(4)}))`;
      el.previewFrame.style.height = 'auto';
    }
  }

  /* ── state helpers ─────────────────────────────────────── */

  function snapshot() {
    return {
      clips: state.clips.map((clip) => ({ ...clip })),
      subtitles: state.subtitles.map((sub) => ({ ...sub })),
      color: { ...state.color },
      selectedId: state.selectedId,
    };
  }

  function pushHistory() {
    history.push(snapshot());
    if (history.length > 30) history.shift();
  }

  function undo() {
    const previous = history.pop();
    if (!previous) return false;
    state.clips = previous.clips;
    state.subtitles = previous.subtitles;
    state.color = previous.color;
    state.selectedId = previous.selectedId;
    syncAll();
    showToast('되돌렸어요.');
    return true;
  }

  function selectedClip() {
    return state.clips.find((clip) => clip.id === state.selectedId) || state.clips[0] || null;
  }

  function selectedIndex() {
    const clip = selectedClip();
    return clip ? state.clips.findIndex((item) => item.id === clip.id) : -1;
  }

  function syncAll({ seek = false } = {}) {
    const hasClips = state.clips.length > 0;
    if (el.appRoot && el.appRoot.classList) el.appRoot.classList.toggle('is-editing', hasClips);
    if (el.emptyState) el.emptyState.hidden = hasClips;
    if (el.editor) el.editor.hidden = !hasClips;
    if (el.dock) el.dock.hidden = !hasClips;
    if (!hasClips) {
      state.selectedId = null;
      renderClipStrip();
      if (el.clipStrip) el.clipStrip.innerHTML = '';
      return;
    }
    if (!state.clips.some((clip) => clip.id === state.selectedId)) {
      state.selectedId = state.clips[0].id;
    }
    player.setTimeline(state.clips, state.sources);
    applyProjectSize();
    renderClipStrip();
    renderClipPanel();
    renderColorPanel();
    renderSubtitleList();
    updateTimeUI({ time: player.getTime(), total: player.getTotal(), playing: player.isPlaying() });
    player.refresh();
    if (seek) player.seek(state.time);
  }

  function handleUpdate({ time, total, playing }) {
    state.time = time;
    updateTimeUI({ time, total, playing });
    if (!playing) renderClipPanel();
    else updateSplitAvailability();
  }

  function updateTimeUI({ time = 0, total = 0, playing = false } = {}) {
    const timeText = formatTimecode(time, { decimals: 0 });
    const totalText = formatTimecode(total, { decimals: 0 });
    if (el.curTime && el.curTime.textContent !== timeText) el.curTime.textContent = timeText;
    if (el.totalTime && el.totalTime.textContent !== totalText) el.totalTime.textContent = totalText;
    if (el.seekBar) {
      el.seekBar.max = String(Math.max(total, 0.01));
      if (seekPending === null) el.seekBar.value = String(Math.min(time, total));
    }
    if (el.dockDuration) {
      const dockText = formatTimecode(total, { decimals: 1 });
      if (el.dockDuration.textContent !== dockText) el.dockDuration.textContent = dockText;
    }
    if (el.dockMeta) {
      const meta = `클립 ${state.clips.length}개 · ${formatSeconds(total)}`;
      if (el.dockMeta.textContent !== meta) el.dockMeta.textContent = meta;
    }
    setPlayingUI(playing);
  }

  function setPlayingUI(playing) {
    if (!el.playBtn) return;
    const playIcon = el.playBtn.querySelector('.i-play');
    const pauseIcon = el.playBtn.querySelector('.i-pause');
    if (playIcon) playIcon.hidden = playing;
    if (pauseIcon) pauseIcon.hidden = !playing;
    el.playBtn.setAttribute('aria-label', playing ? '일시정지' : '재생');
  }

  /* ── clip strip and panel ──────────────────────────────── */

  function renderClipStrip() {
    if (!el.clipStrip) return;
    el.clipStrip.innerHTML = '';
    const segments = segmentsOf(state.clips);
    segments.forEach((segment) => {
      const button = doc.createElement('button');
      button.className = 'strip-item';
      button.dataset.clipId = segment.clipId;
      // 길이에 비례하되 한 클립이 화면을 다 차지하지 않게 폭을 제한한다.
      const stripWidth = Math.round(Math.max(48, Math.min(150, segment.duration * 18)));
      button.style.flex = `0 0 ${stripWidth}px`;
      if (segment.clipId === state.selectedId) button.classList.add('is-active');
      const source = state.sources.get(segment.clip.sourceId);
      if (source && source.thumb) {
        button.style.backgroundImage = `linear-gradient(180deg, rgba(20, 14, 24, 0.08), rgba(20, 14, 24, 0.5)), url("${source.thumb}")`;
      } else {
        // 썸네일을 못 뽑았을 때 검은 막대 대신 파스텔 카드 + 길이 표시
        button.classList.add('no-thumb');
        button.textContent = '';
        const dur = doc.createElement('span');
        dur.className = 'strip-dur';
        dur.textContent = formatTimecode(segment.duration);
        button.appendChild(dur);
      }
      const number = doc.createElement('span');
      number.className = 'strip-no';
      number.textContent = String(segment.index + 1);
      button.appendChild(number);
      button.setAttribute('aria-label', `클립 ${segment.index + 1}, ${formatTimecode(segment.duration)}`);
      button.addEventListener('click', () => selectClip(segment.clipId, { seekToStart: true }));
      el.clipStrip.appendChild(button);
    });
  }

  function renderClipPanel() {
    const clip = selectedClip();
    if (!clip) {
      if (el.clipCard) el.clipCard.hidden = true;
      return;
    }
    if (el.clipCard) el.clipCard.hidden = false;
    const index = selectedIndex();
    const source = state.sources.get(clip.sourceId);
    if (el.clipTitle) {
      const name = source ? source.name : '영상';
      el.clipTitle.textContent = `클립 ${index + 1} · ${shortName(name)}`;
    }
    if (el.clipSub) {
      el.clipSub.textContent = `길이 ${formatTimecode(clipDuration(clip))} · 원본 ${formatTimecode(clip.sourceDuration)}`;
    }
    if (el.clipThumb) {
      el.clipThumb.style.backgroundImage = source && source.thumb ? `url("${source.thumb}")` : '';
    }
    if (el.trimStart) {
      el.trimStart.min = '0';
      el.trimStart.max = String(clip.sourceDuration);
      el.trimStart.value = String(clip.start);
    }
    if (el.trimEnd) {
      el.trimEnd.min = '0';
      el.trimEnd.max = String(clip.sourceDuration);
      el.trimEnd.value = String(clip.end);
    }
    if (el.trimStartLabel) el.trimStartLabel.textContent = formatTimecode(clip.start);
    if (el.trimEndLabel) el.trimEndLabel.textContent = formatTimecode(clip.end);
    if (el.upBtn) el.upBtn.disabled = index <= 0;
    if (el.downBtn) el.downBtn.disabled = index >= state.clips.length - 1;
    if (el.speedValue) el.speedValue.textContent = formatSpeed(clip.speed);
    if (el.speedFine) el.speedFine.value = String(clip.speed);
    if (el.speedChips) {
      el.speedChips.querySelectorAll('[data-speed]').forEach((button) => {
        const active = Math.abs(Number(button.dataset.speed) - clip.speed) < 0.001;
        button.classList.toggle('is-active', active);
      });
    }
    updateSplitAvailability();
  }

  function updateSplitAvailability() {
    if (!el.splitBtn) return;
    el.splitBtn.disabled = !canSplitNow();
  }

  function canSplitNow() {
    const clip = selectedClip();
    if (!clip) return false;
    const hit = locate(state.clips, state.time);
    if (!hit || hit.clip.id !== clip.id) return false;
    return (
      hit.sourceTime - clip.start >= MIN_CLIP_SECONDS &&
      clip.end - hit.sourceTime >= MIN_CLIP_SECONDS
    );
  }

  /* ── clip actions ──────────────────────────────────────── */

  function selectClip(id, { seekToStart = false } = {}) {
    state.selectedId = id;
    state.editingSubId = null;
    renderClipPanel();
    renderClipStrip();
    if (seekToStart) {
      const segment = segmentsOf(state.clips).find((seg) => seg.clipId === id);
      if (segment) player.seek(segment.timelineStart);
    }
  }

  function commitClips(nextClips, { selectedId = state.selectedId, seekTo = null } = {}) {
    state.clips = nextClips;
    state.selectedId = selectedId;
    syncAll();
    if (seekTo !== null) player.seek(seekTo);
  }

  function onTrimInput(edge) {
    const clip = selectedClip();
    if (!clip) return;
    if (!trimDirty) {
      pushHistory();
      trimDirty = true;
    }
    const value = edge === 'start' ? Number(el.trimStart.value) : Number(el.trimEnd.value);
    const next = trimClip(clip, edge === 'start' ? { start: value } : { end: value });
    state.clips = state.clips.map((item) => (item.id === clip.id ? next : item));
    if (edge === 'start' && el.trimStartLabel) el.trimStartLabel.textContent = formatTimecode(next.start);
    if (edge === 'end' && el.trimEndLabel) el.trimEndLabel.textContent = formatTimecode(next.end);
    player.setTimeline(state.clips, state.sources);
    renderClipStrip();
    renderClipPanel();
    updateTimeUI({ time: player.getTime(), total: player.getTotal(), playing: false });
    player.seek(Math.min(player.getTime(), player.getTotal()));
  }

  function endTrim() {
    trimDirty = false;
  }

  function markPlayhead(edge) {
    const clip = selectedClip();
    if (!clip) return;
    const hit = locate(state.clips, state.time);
    if (!hit || hit.clip.id !== clip.id) {
      showToast('재생바를 이 클립 안으로 먼저 옮겨 주세요.');
      return;
    }
    pushHistory();
    const next = trimClip(clip, edge === 'start' ? { start: hit.sourceTime } : { end: hit.sourceTime });
    state.clips = replaceClip(state.clips, clip.id, next);
    syncAll();
    showToast(edge === 'start' ? '시작 지점을 옮겼어요.' : '끝 지점을 옮겼어요.');
  }

  function doSplit() {
    const clip = selectedClip();
    if (!clip) return;
    const hit = locate(state.clips, state.time);
    if (!hit || hit.clip.id !== clip.id) {
      showToast('나눌 위치를 이 클립 안으로 옮겨 주세요.');
      return;
    }
    const parts = splitClip(clip, hit.sourceTime);
    if (!parts) {
      showToast('너무 짧아서 나눌 수 없어요. 0.2초 이상 남겨 주세요.');
      return;
    }
    pushHistory();
    const next = [
      ...state.clips.slice(0, hit.index),
      ...parts,
      ...state.clips.slice(hit.index + 1),
    ];
    commitClips(next, { selectedId: parts[1].id, seekTo: hit.timelineStart });
    showToast('두 클립으로 나눴어요.');
  }

  function doDuplicate() {
    const clip = selectedClip();
    if (!clip) return;
    pushHistory();
    const copy = duplicateClip(clip);
    const index = selectedIndex();
    commitClips(insertClips(state.clips, index, [copy]), { selectedId: copy.id });
    showToast('클립을 복제했어요.');
  }

  function doDelete() {
    const clip = selectedClip();
    if (!clip) return;
    pushHistory();
    const index = selectedIndex();
    const next = removeClip(state.clips, clip.id);
    if (!next.length) {
      state.clips = [];
      state.selectedId = null;
      syncAll();
      showToast('클립을 지웠어요. 영상을 다시 불러올 수 있어요.', { undo: true });
      return;
    }
    const nextSelected = next[Math.min(index, next.length - 1)].id;
    commitClips(next, { selectedId: nextSelected, seekTo: 0 });
    showToast('클립을 지웠어요.', { undo: true });
  }

  function doMove(delta) {
    const index = selectedIndex();
    if (index < 0) return;
    const next = moveClip(state.clips, index, delta);
    if (next === state.clips) return;
    pushHistory();
    const clip = state.clips[index];
    state.clips = next;
    state.selectedId = clip.id;
    syncAll();
  }

  function setClipSpeed(speed) {
    const clip = selectedClip();
    if (!clip) return;
    pushHistory();
    const next = setSpeed(clip, speed);
    state.clips = replaceClip(state.clips, clip.id, next);
    syncAll();
  }

  /* ── colour ────────────────────────────────────────────── */

  function applyColor(next, { remember = true } = {}) {
    if (remember) pushHistory();
    state.color = normalizeColor(next);
    renderColorPanel();
    player.refresh();
  }

  function renderColorPanel() {
    const c = state.color;
    const preset = matchPreset(c);
    if (el.colorMood) el.colorMood.textContent = describeColor(c);
    if (el.colorPresets) {
      el.colorPresets.querySelectorAll('[data-preset]').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.preset === preset);
      });
    }
    ['brightness', 'contrast', 'saturation', 'warmth'].forEach((key) => {
      const input = $(key);
      const label = $(`${key}Val`);
      const value = Math.round((c[key] || 0) * 100);
      if (input) input.value = String(value);
      if (label) label.textContent = value > 0 ? `+${value}` : String(value);
    });
  }

  /* ── subtitles ─────────────────────────────────────────── */

  function readSubtitleForm() {
    return {
      text: el.subText ? el.subText.value : '',
      scope: el.subScope && el.subScope.value === 'clip' ? 'clip' : 'all',
      position: state.draft.position,
      size: state.draft.size,
      color: state.draft.color,
      background: state.draft.background,
      from: state.draft.from,
      to: state.draft.to,
    };
  }

  function syncSubtitleForm() {
    if (el.subPositions) {
      el.subPositions.querySelectorAll('[data-pos]').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.pos === state.draft.position);
      });
    }
    if (el.subSizes) {
      el.subSizes.querySelectorAll('[data-size]').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.size === state.draft.size);
      });
    }
    if (el.subColors) {
      el.subColors.querySelectorAll('[data-color]').forEach((button) => {
        button.classList.toggle(
          'is-active',
          button.dataset.color.toLowerCase() === state.draft.color.toLowerCase(),
        );
      });
    }
    if (el.subBg) el.subBg.checked = state.draft.background;
    if (el.subFrom) el.subFrom.value = String(Math.round(state.draft.from * 100));
    if (el.subTo) el.subTo.value = String(Math.round(state.draft.to * 100));
    if (el.subRangeLabel) {
      const full = state.draft.from <= 0.001 && state.draft.to >= 0.999;
      el.subRangeLabel.textContent = full
        ? '처음 ~ 끝'
        : `${Math.round(state.draft.from * 100)}% ~ ${Math.round(state.draft.to * 100)}%`;
    }
  }

  function resetSubtitleForm() {
    state.editingSubId = null;
    state.draft = {
      scope: 'all',
      position: 'bottom',
      size: 'medium',
      color: '#ffffff',
      background: true,
      from: 0,
      to: 1,
    };
    if (el.subText) el.subText.value = '';
    if (el.subScope) el.subScope.value = 'all';
    if (el.subFormTitle) el.subFormTitle.textContent = '자막 넣기';
    if (el.subAddBtn) el.subAddBtn.textContent = '자막 추가';
    if (el.subCancelEdit) el.subCancelEdit.hidden = true;
    syncSubtitleForm();
  }

  function saveSubtitle() {
    const form = readSubtitleForm();
    const check = validateSubtitleText(form.text);
    if (!check.valid) {
      showToast(check.reason);
      return;
    }
    const clip = selectedClip();
    if (form.scope === 'clip' && !clip) {
      showToast('먼저 클립을 골라 주세요.');
      return;
    }
    const payload = {
      text: check.text,
      scope: form.scope,
      clipId: form.scope === 'clip' ? clip.id : null,
      position: form.position,
      size: form.size,
      color: form.color,
      background: form.background,
      from: form.from,
      to: form.to,
    };
    pushHistory();
    let targetId = state.editingSubId;
    if (state.editingSubId) {
      state.subtitles = state.subtitles.map((sub) =>
        sub.id === state.editingSubId ? updateSubtitle(sub, payload) : sub,
      );
      showToast('자막을 고쳤어요.');
    } else {
      const sub = createSubtitle(payload);
      state.subtitles = [...state.subtitles, sub];
      targetId = sub.id;
      showToast('자막을 넣었어요.');
    }
    const target = state.subtitles.find((sub) => sub.id === targetId);
    resetSubtitleForm();
    renderSubtitleList();
    jumpToSubtitle(target);
    player.refresh();
  }

  function jumpToSubtitle(sub) {
    if (!sub) return;
    const segments = segmentsOf(state.clips);
    const windows = subtitleWindows([sub], segments, totalDuration(state.clips));
    if (!windows.length) return;
    const window = windows[0];
    const hit = locate(state.clips, window.start + 0.05);
    if (!hit) return;
    player.seek(hit.timelineStart + Math.max(0.05, Math.min(0.4, (window.end - window.start) / 2)));
    player.refresh();
  }

  function editSubtitle(id) {
    const sub = state.subtitles.find((item) => item.id === id);
    if (!sub) return;
    state.editingSubId = id;
    state.draft = {
      scope: sub.scope,
      position: sub.position,
      size: sub.size,
      color: sub.color,
      background: sub.background,
      from: sub.from,
      to: sub.to,
    };
    if (el.subText) el.subText.value = sub.text;
    if (el.subScope) el.subScope.value = sub.scope;
    if (el.subFormTitle) el.subFormTitle.textContent = '자막 고치기';
    if (el.subAddBtn) el.subAddBtn.textContent = '자막 수정';
    if (el.subCancelEdit) el.subCancelEdit.hidden = false;
    syncSubtitleForm();
    switchTab('subs');
    if (el.subText && el.subText.focus) el.subText.focus();
  }

  function deleteSubtitle(id) {
    pushHistory();
    state.subtitles = state.subtitles.filter((item) => item.id !== id);
    if (state.editingSubId === id) resetSubtitleForm();
    renderSubtitleList();
    player.refresh();
    showToast('자막을 지웠어요.', { undo: true });
  }

  function renderSubtitleList() {
    if (!el.subList) return;
    el.subList.innerHTML = '';
    state.subtitles.forEach((sub) => {
      const item = doc.createElement('li');
      item.className = 'sub-item';
      item.dataset.subId = sub.id;
      const text = doc.createElement('div');
      text.className = 'sub-item-text';
      const strong = doc.createElement('strong');
      strong.textContent = sub.text;
      const meta = doc.createElement('span');
      meta.textContent = subMeta(sub);
      text.appendChild(strong);
      text.appendChild(meta);
      const actions = doc.createElement('div');
      actions.className = 'sub-item-actions';
      const edit = doc.createElement('button');
      edit.textContent = '수정';
      edit.dataset.action = 'edit';
      edit.addEventListener('click', () => editSubtitle(sub.id));
      const del = doc.createElement('button');
      del.textContent = '삭제';
      del.className = 'del';
      del.dataset.action = 'delete';
      del.addEventListener('click', () => deleteSubtitle(sub.id));
      actions.appendChild(edit);
      actions.appendChild(del);
      item.appendChild(text);
      item.appendChild(actions);
      el.subList.appendChild(item);
    });
    if (el.subCount) el.subCount.textContent = `${state.subtitles.length}개`;
    if (el.subEmpty) el.subEmpty.hidden = state.subtitles.length > 0;
  }

  function subMeta(sub) {
    const position = { top: '위', center: '가운데', bottom: '아래' }[sub.position] || '아래';
    const size = { small: '작게', medium: '보통', large: '크게' }[sub.size] || '보통';
    let scope = '영상 전체';
    if (sub.scope === 'clip') {
      const index = state.clips.findIndex((clip) => clip.id === sub.clipId);
      scope = index >= 0 ? `클립 ${index + 1}` : '클립';
    }
    const range = sub.from > 0.001 || sub.to < 0.999
      ? ` · ${Math.round(sub.from * 100)}~${Math.round(sub.to * 100)}%`
      : '';
    return `${scope} · ${position} · ${size}${sub.background ? ' · 박스' : ''}${range}`;
  }

  /* ── loading media ─────────────────────────────────────── */

  async function addFiles(files) {
    const list = Array.from(files || []).filter(isVideoFile);
    if (!list.length) {
      showToast('영상 파일(mp4·mov)을 골라 주세요.');
      return { added: 0 };
    }
    if (el.previewOverlay) {
      el.previewOverlay.hidden = false;
      el.previewOverlay.textContent = `영상 ${list.length}개 읽는 중…`;
    }
    let added = 0;
    let failed = 0;
    for (const file of list) {
      try {
        const source = await media.load(file);
        if (!source || !(source.duration > 0)) throw new Error('길이를 읽지 못했어요');
        state.sources.set(source.id, source);
        if (source.thumbPromise && typeof source.thumbPromise.then === 'function') {
          source.thumbPromise
            .then((thumb) => {
              if (!thumb) return;
              const stored = state.sources.get(source.id);
              if (!stored) return;
              stored.thumb = thumb;
              renderClipStrip();
              renderClipPanel();
            })
            .catch(() => {});
        }
        const clip = createClip({
          sourceId: source.id,
          sourceDuration: source.duration,
        });
        state.clips = [...state.clips, clip];
        if (!state.selectedId) state.selectedId = clip.id;
        added += 1;
      } catch (error) {
        failed += 1;
      }
    }
    if (el.previewOverlay) el.previewOverlay.hidden = true;
    if (el.fileInput) el.fileInput.value = '';
    if (!added) {
      showToast(failed ? '영상을 읽지 못했어요. 다른 파일로 시도해 주세요.' : '추가된 영상이 없어요.');
      return { added: 0, failed };
    }
    syncAll();
    const segment = segmentsOf(state.clips).find((seg) => seg.clipId === state.selectedId);
    player.seek(segment ? segment.timelineStart : 0);
    if (failed) showToast(`${added}개는 불러왔고 ${failed}개는 읽지 못했어요.`);
    return { added, failed };
  }

  /* ── playback ──────────────────────────────────────────── */

  function togglePlay() {
    if (!state.clips.length) return;
    if (player.isPlaying()) {
      player.pause();
      setPlayingUI(false);
      return;
    }
    resumeAudio();
    if (el.video) el.video.muted = false;
    player.play();
  }

  function resumeAudio() {
    if (audioGraph && audioGraph.ctx.state !== 'running') {
      audioGraph.ctx.resume().catch(() => {});
    }
  }

  function scheduleSeek(value) {
    seekPending = value;
    const run = () => {
      const target = seekPending;
      seekPending = null;
      if (target === null) return;
      player.seek(target);
    };
    if (win.requestAnimationFrame) win.requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  /* ── export ────────────────────────────────────────────── */

  function ensureAudioGraph() {
    if (audioGraph) return audioGraph;
    if (options.disableAudio) return null;
    audioGraph = buildAudioGraph(win, el.video);
    return audioGraph;
  }

  async function requestWakeLock() {
    try {
      if (win.navigator && win.navigator.wakeLock && win.navigator.wakeLock.request) {
        wakeLock = await win.navigator.wakeLock.request('screen');
      }
    } catch (error) {
      wakeLock = null;
    }
  }

  function releaseWakeLock() {
    try {
      if (wakeLock && wakeLock.release) wakeLock.release();
    } catch (error) {
      /* noop */
    }
    wakeLock = null;
  }

  function openSheet(which) {
    const sheet = which === 'info' ? el.infoSheet : el.exportSheet;
    if (sheet) sheet.hidden = false;
    if (el.toast) el.toast.hidden = true;
  }

  function closeSheet(which) {
    const sheet = which === 'info' ? el.infoSheet : el.exportSheet;
    if (sheet) sheet.hidden = true;
  }

  function resetExportSheet() {
    if (state.exportUrl && win.URL && win.URL.revokeObjectURL) {
      try {
        win.URL.revokeObjectURL(state.exportUrl);
      } catch (error) {
        /* noop */
      }
      state.exportUrl = '';
    }
    state.exportBlob = null;
    state.exportMime = '';
    if (el.expResult) el.expResult.hidden = true;
    if (el.expVideo) {
      el.expVideo.removeAttribute('src');
      try {
        el.expVideo.load();
      } catch (error) {
        /* noop */
      }
    }
    if (el.expBar) el.expBar.style.width = '0%';
    if (el.expPercent) el.expPercent.textContent = '0%';
    if (el.expEta) el.expEta.textContent = '남은 시간 계산 중…';
    if (el.expStage) el.expStage.textContent = '준비 중…';
    if (el.expCancelBtn) el.expCancelBtn.hidden = false;
    if (el.expClose) el.expClose.hidden = true;
    if (el.expNote) el.expNote.hidden = false;
  }

  /**
   * iOS only allows play() after a user gesture. Starting a muted playback from
   * the export tap marks the element as activated, and the next unmuted play
   * inside the recorder keeps the audio track alive.
   */
  async function primeMedia() {
    if (!el.video || !el.video.play) return;
    try {
      el.video.muted = true;
      const started = el.video.play();
      if (started && started.then) {
        await Promise.race([
          started.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      }
      if (el.video.pause) el.video.pause();
    } catch (error) {
      /* recording still starts; audio may be silent on this device */
    }
    el.video.muted = false;
  }

  async function startExport() {
    if (state.exporting || !state.clips.length) return;
    player.pause();
    state.exporting = true;
    resetExportSheet();
    openSheet('export');
    if (el.exportBtn) el.exportBtn.disabled = true;
    const total = totalDuration(state.clips);
    exportSize = { ...state.size };
    if (el.exportCanvas) {
      el.exportCanvas.width = exportSize.width;
      el.exportCanvas.height = exportSize.height;
      exportCtx = el.exportCanvas.getContext ? el.exportCanvas.getContext('2d') : null;
    }
    abortController = new AbortController();
    ensureAudioGraph();
    await primeMedia();
    await requestWakeLock();
    const startedAt = Date.now();
    try {
      const result = await exportVideo({
        win,
        canvas: el.exportCanvas,
        video: el.video,
        clips: state.clips,
        sources: state.sources,
        drawAt: drawExportFrame,
        total,
        anyAudio: projectHasAudio(state.sources),
        audioGraph,
        signal: abortController.signal,
        onStage: (stage) => {
          if (el.expStage) el.expStage.textContent = stageLabel(stage, 0);
        },
        onProgress: ({ time, percent, elapsedSeconds }) => {
          if (el.expBar) el.expBar.style.width = formatPercent(percent);
          if (el.expPercent) el.expPercent.textContent = formatPercent(percent);
          if (el.expEta) {
            const eta = etaSeconds(elapsedSeconds, time, total);
            el.expEta.textContent =
              eta === null ? '계산 중…' : eta < 1 ? '거의 다 됐어요' : `약 ${formatSeconds(eta)} 남음`;
          }
          if (el.expStage) el.expStage.textContent = stageLabel(EXPORT_STAGES.recording, percent);
        },
      });
      if (result.cancelled) {
        if (el.expStage) el.expStage.textContent = '취소했어요.';
        if (el.expCancelBtn) el.expCancelBtn.hidden = true;
        if (el.expClose) el.expClose.hidden = false;
        return;
      }
      showExportResult(result, { total, startedAt });
    } catch (error) {
      if (el.expStage) el.expStage.textContent = error && error.message ? error.message : '내보내기에 실패했어요.';
      if (el.expEta) el.expEta.textContent = '사파리를 새로 고친 뒤 다시 시도해 주세요.';
      if (el.expCancelBtn) el.expCancelBtn.hidden = true;
      if (el.expClose) el.expClose.hidden = false;
    } finally {
      state.exporting = false;
      if (el.exportBtn) el.exportBtn.disabled = false;
      releaseWakeLock();
      const hit = locate(state.clips, state.time);
      if (hit) player.seek(hit.timelineStart);
    }
  }

  function showExportResult(result, { total, startedAt }) {
    state.exportBlob = result.blob;
    state.exportMime = result.mime;
    const url = win.URL.createObjectURL(result.blob);
    state.exportUrl = url;
    const name = exportFileName(result.mime);
    if (el.expVideo) el.expVideo.src = url;
    if (el.downloadBtn) {
      el.downloadBtn.href = url;
      el.downloadBtn.download = name;
    }
    if (el.expFileInfo) {
      el.expFileInfo.textContent = `${result.mime.includes('mp4') ? 'MP4' : 'WEBM'} · ${formatBytes(
        result.blob.size,
      )} · ${formatTimecode(total)} · 만드는 데 ${formatSeconds((Date.now() - startedAt) / 1000)}`;
    }
    if (el.expResult) el.expResult.hidden = false;
    if (el.expStage) el.expStage.textContent = '완성! 공유하거나 저장하세요.';
    if (el.expPercent) el.expPercent.textContent = '100%';
    if (el.expEta) el.expEta.textContent = '';
    if (el.expCancelBtn) el.expCancelBtn.hidden = true;
    if (el.expClose) el.expClose.hidden = false;
    if (el.expNote) el.expNote.hidden = true;
    if (el.expBar) el.expBar.style.width = '100%';
  }

  async function shareExport() {
    if (!state.exportBlob) return;
    const name = exportFileName(state.exportMime);
    const type = state.exportMime || 'video/mp4';
    try {
      const FileCtor = win.File;
      const file = new FileCtor([state.exportBlob], name, { type });
      const shareData = { files: [file], title: '릴스 컷 스튜디오' };
      if (win.navigator && win.navigator.canShare && win.navigator.canShare(shareData)) {
        await win.navigator.share(shareData);
        return;
      }
    } catch (error) {
      if (error && error.name === 'AbortError') return;
    }
    showToast('공유 시트를 열 수 없어요. 저장하기를 눌러 주세요.');
  }

  /* ── toast ─────────────────────────────────────────────── */

  function showToast(message, { undo: allowUndo = false } = {}) {
    if (!el.toast) return;
    if (el.toastMsg) el.toastMsg.textContent = message;
    if (el.undoBtn) el.undoBtn.hidden = !allowUndo;
    el.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, allowUndo ? 5000 : 2600);
  }

  /* ── tabs ──────────────────────────────────────────────── */

  function switchTab(name) {
    doc.querySelectorAll('.tab').forEach((tab) => {
      const active = tab.dataset.panel === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    ['clips', 'color', 'subs'].forEach((panel) => {
      const node = $(`panel-${panel}`);
      if (node) node.hidden = panel !== name;
    });
    scrollPanelToTop($(`panel-${name}`));
  }

  /** 탭을 바꾸면 그 패널이 위에서부터 온전히 보이게 맞춘다(입력창이 잘리지 않게). */
  function scrollPanelToTop(panel) {
    if (!panel) return;
    if (el.panelScroll) el.panelScroll.scrollTop = 0;
    const scroller = win.scrollY !== undefined ? win : doc.defaultView;
    if (!scroller || typeof scroller.scrollTo !== 'function') return;
    const bar = doc.querySelector('.tabs-bar');
    const barHeight = bar && bar.getBoundingClientRect ? bar.getBoundingClientRect().height : 0;
    const rect = panel.getBoundingClientRect ? panel.getBoundingClientRect() : null;
    if (!rect) return;
    const current = Number(scroller.scrollY) || 0;
    const target = Math.max(0, current + rect.top - barHeight - 6);
    if (current > target) scroller.scrollTo({ top: target, behavior: 'auto' });
  }

  /* ── events ────────────────────────────────────────────── */

  function bind() {
    if (el.pickBtn) el.pickBtn.addEventListener('click', () => el.fileInput && el.fileInput.click());
    if (el.addMoreBtn) el.addMoreBtn.addEventListener('click', () => el.fileInput && el.fileInput.click());
    if (el.fileInput) {
      el.fileInput.addEventListener('change', () => {
        addFiles(el.fileInput.files);
      });
    }
    if (el.playBtn) el.playBtn.addEventListener('click', togglePlay);
    if (el.seekBar) {
      el.seekBar.addEventListener('input', () => {
        const value = Number(el.seekBar.value);
        if (el.curTime) el.curTime.textContent = formatTimecode(value, { decimals: 0 });
        scheduleSeek(value);
      });
    }
    if (el.trimStart) {
      el.trimStart.addEventListener('input', () => onTrimInput('start'));
      el.trimStart.addEventListener('change', endTrim);
    }
    if (el.trimEnd) {
      el.trimEnd.addEventListener('input', () => onTrimInput('end'));
      el.trimEnd.addEventListener('change', endTrim);
    }
    if (el.markStartBtn) el.markStartBtn.addEventListener('click', () => markPlayhead('start'));
    if (el.markEndBtn) el.markEndBtn.addEventListener('click', () => markPlayhead('end'));
    if (el.splitBtn) el.splitBtn.addEventListener('click', doSplit);
    if (el.dupBtn) el.dupBtn.addEventListener('click', doDuplicate);
    if (el.delBtn) el.delBtn.addEventListener('click', doDelete);
    if (el.upBtn) el.upBtn.addEventListener('click', () => doMove(-1));
    if (el.downBtn) el.downBtn.addEventListener('click', () => doMove(1));

    if (el.speedChips) {
      el.speedChips.querySelectorAll('[data-speed]').forEach((button) => {
        button.addEventListener('click', () => setClipSpeed(Number(button.dataset.speed)));
      });
    }
    if (el.speedFine) {
      el.speedFine.addEventListener('change', () => {
        setClipSpeed(Number(el.speedFine.value) || 1);
      });
    }

    if (el.colorPresets) {
      el.colorPresets.querySelectorAll('[data-preset]').forEach((button) => {
        button.addEventListener('click', () => {
          const preset = COLOR_PRESETS.find((item) => item.id === button.dataset.preset);
          if (preset) applyColor(preset.settings);
        });
      });
    }
    ['brightness', 'contrast', 'saturation', 'warmth'].forEach((key) => {
      const input = $(key);
      if (!input) return;
      input.addEventListener('input', () => {
        if (!colorDirty) {
          pushHistory();
          colorDirty = true;
        }
        applyColor({ ...state.color, [key]: Number(input.value) / 100 }, { remember: false });
      });
      input.addEventListener('change', () => {
        colorDirty = false;
      });
    });
    if (el.resetColorBtn) {
      el.resetColorBtn.addEventListener('click', () => {
        applyColor(DEFAULT_COLOR);
        showToast('색감을 원본으로 되돌렸어요.');
      });
    }

    if (el.subPositions) {
      el.subPositions.querySelectorAll('[data-pos]').forEach((button) => {
        button.addEventListener('click', () => {
          state.draft.position = button.dataset.pos;
          syncSubtitleForm();
        });
      });
    }
    if (el.subSizes) {
      el.subSizes.querySelectorAll('[data-size]').forEach((button) => {
        button.addEventListener('click', () => {
          state.draft.size = button.dataset.size;
          syncSubtitleForm();
        });
      });
    }
    if (el.subColors) {
      el.subColors.querySelectorAll('[data-color]').forEach((button) => {
        button.addEventListener('click', () => {
          state.draft.color = button.dataset.color;
          syncSubtitleForm();
        });
      });
    }
    if (el.subBg) {
      el.subBg.addEventListener('change', () => {
        state.draft.background = Boolean(el.subBg.checked);
      });
    }
    if (el.subScope) {
      el.subScope.addEventListener('change', () => {
        state.draft.scope = el.subScope.value;
      });
    }
    if (el.subFrom) {
      el.subFrom.addEventListener('input', () => {
        const value = Number(el.subFrom.value) / 100;
        state.draft.from = Math.min(value, state.draft.to - 0.05);
        syncSubtitleForm();
      });
    }
    if (el.subTo) {
      el.subTo.addEventListener('input', () => {
        const value = Number(el.subTo.value) / 100;
        state.draft.to = Math.max(value, state.draft.from + 0.05);
        syncSubtitleForm();
      });
    }
    if (el.subAddBtn) el.subAddBtn.addEventListener('click', saveSubtitle);
    if (el.subCancelEdit) el.subCancelEdit.addEventListener('click', resetSubtitleForm);
    if (el.expCancelBtn) el.expCancelBtn.addEventListener('click', () => {
      if (abortController) abortController.abort();
    });
    if (el.expClose) el.expClose.addEventListener('click', () => closeSheet('export'));
    if (el.shareBtn) el.shareBtn.addEventListener('click', shareExport);
    if (el.exportBtn) el.exportBtn.addEventListener('click', startExport);
    if (el.infoBtn) el.infoBtn.addEventListener('click', () => openSheet('info'));
    if (el.undoBtn) {
      el.undoBtn.addEventListener('click', () => {
        undo();
        el.toast.hidden = true;
      });
    }
    doc.querySelectorAll('[data-close]').forEach((node) => {
      node.addEventListener('click', () => closeSheet(node.dataset.close));
    });
    doc.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.panel));
    });

    if (el.video && el.video.addEventListener) {
      el.video.addEventListener('ended', () => setPlayingUI(false));
      el.video.addEventListener('pause', () => setPlayingUI(false));
      el.video.addEventListener('play', () => setPlayingUI(true));
    }

    if (doc.addEventListener) {
      doc.addEventListener('keydown', (event) => {
        if (event.key === ' ' && event.target === doc.body) {
          event.preventDefault();
          togglePlay();
        }
      });
    }
  }

  function shortName(name) {
    const text = String(name || '영상');
    return text.length > 22 ? `${text.slice(0, 19)}…` : text;
  }

  bind();
  resetSubtitleForm();
  syncAll();

  return {
    state,
    el,
    addFiles,
    undo,
    togglePlay,
    selectClip,
    doSplit,
    doDuplicate,
    doDelete,
    doMove,
    setClipSpeed,
    markPlayhead,
    applyColor,
    saveSubtitle,
    deleteSubtitle,
    editSubtitle,
    startExport,
    switchTab,
    syncAll,
    player,
    isFilterSupported: () => filterSupported,
  };
}
