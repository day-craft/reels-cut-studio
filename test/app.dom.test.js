// jsdom integration test: the real app module against the real index.html,
// with a fake media adapter and a fake <video> element so no decoding happens.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

import { createApp } from '../js/ui/app.js';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function makeFakeVideo() {
  const listeners = new Map();
  return {
    src: '',
    currentTime: 0,
    playbackRate: 1,
    paused: true,
    ended: false,
    readyState: 4,
    videoWidth: 720,
    videoHeight: 1280,
    muted: true,
    dataset: {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    load() {},
  };
}

function setup() {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const video = makeFakeVideo();
  const draws = [];
  const loads = [];
  const media = {
    async load(file) {
      loads.push(file.name);
      const wide = file.name.includes('wide');
      return {
        id: `src_${file.name}`,
        name: file.name,
        url: `blob:${file.name}`,
        thumb: '',
        duration: wide ? 8 : 6,
        width: wide ? 1280 : 720,
        height: wide ? 720 : 1280,
        hasAudio: true,
      };
    },
  };
  const app = createApp({
    doc: window.document,
    win: window,
    media,
    videoEl: video,
    drawFrame: (ctx, options) => draws.push(options),
    disableAudio: true,
  });
  const doc = window.document;
  return {
    app,
    doc,
    window,
    video,
    draws,
    loads,
    dom,
    $: (id) => doc.getElementById(id),
    file: (name) => new window.File([new window.Blob(['video'])], name, { type: 'video/mp4' }),
    tick: (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

test('the empty state is shown before any video is loaded', () => {
  const t = setup();
  assert.equal(t.$('emptyState').hidden, false);
  assert.equal(t.$('editor').hidden, true);
  assert.equal(t.$('dock').hidden, true);
  assert.equal(t.$('clipStrip').children.length, 0);
});

test('loading two videos creates clips, duration labels and a dock summary', async () => {
  const t = setup();
  const result = await t.app.addFiles([t.file('a.mp4'), t.file('b.mp4')]);
  assert.equal(result.added, 2);
  assert.equal(t.app.state.clips.length, 2);
  assert.equal(t.$('emptyState').hidden, true);
  assert.equal(t.$('editor').hidden, false);
  assert.equal(t.$('dock').hidden, false);
  assert.equal(t.$('totalTime').textContent, '0:12');
  assert.equal(t.$('dockDuration').textContent, '0:12.0');
  assert.match(t.$('dockMeta').textContent, /클립 2개/);
  assert.equal(t.$('clipStrip').children.length, 2);
  assert.ok(t.$('previewBadge').textContent.includes('720'));
  assert.ok(t.draws.length > 0, 'preview should be drawn after loading');
});

test('non-video files are ignored with a toast', async () => {
  const t = setup();
  const result = await t.app.addFiles([
    new t.window.File([new t.window.Blob(['x'])], 'memo.txt', { type: 'text/plain' }),
  ]);
  assert.equal(result.added, 0);
  assert.equal(t.$('toast').hidden, false);
  assert.equal(t.$('emptyState').hidden, false);
});

test('choosing a speed chip recalculates the total length immediately', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4'), t.file('b.mp4')]);
  const chip = t.doc.querySelector('#speedChips [data-speed="2"]');
  chip.click();
  assert.equal(t.app.state.clips[0].speed, 2);
  assert.equal(t.$('speedValue').textContent, '2x');
  assert.equal(t.$('totalTime').textContent, '0:09');
  assert.match(t.$('dockMeta').textContent, /9초/);
  assert.equal(chip.classList.contains('is-active'), true);
});

test('the up/down buttons reorder clips', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4'), t.file('b.mp4')]);
  const firstId = t.app.state.clips[0].id;
  t.$('downBtn').click();
  assert.notEqual(t.app.state.clips[0].id, firstId);
  assert.equal(t.app.state.clips[1].id, firstId);
  assert.equal(t.$('clipStrip').children[1].dataset.clipId, firstId);
  assert.equal(t.$('upBtn').disabled, false);
});

test('splitting at the playhead creates two clips at that point', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4')]);
  await t.app.player.seek(3);
  await t.tick();
  assert.ok(Math.abs(t.app.state.time - 3) < 0.1, `time was ${t.app.state.time}`);
  assert.equal(t.$('splitBtn').disabled, false);
  t.$('splitBtn').click();
  assert.equal(t.app.state.clips.length, 2);
  assert.ok(Math.abs(t.app.state.clips[0].end - 3) < 0.05);
  assert.ok(Math.abs(t.app.state.clips[1].start - 3) < 0.05);
  assert.equal(t.$('totalTime').textContent, '0:06');
});

test('“현재 = 시작” moves the clip start to the playhead', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4')]);
  await t.app.player.seek(2);
  await t.tick();
  t.$('markStartBtn').click();
  assert.ok(Math.abs(t.app.state.clips[0].start - 2) < 0.1);
  assert.equal(t.$('trimStartLabel').textContent.startsWith('0:02'), true);
  assert.ok(Math.abs(t.app.player.getTotal() - 4) < 0.01);
  assert.equal(t.$('totalTime').textContent, '0:04');
});

test('trim sliders edit the clip range and keep the end after the start', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4')]);
  const start = t.$('trimStart');
  start.value = '1.5';
  start.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  start.dispatchEvent(new t.window.Event('change', { bubbles: true }));
  assert.ok(Math.abs(t.app.state.clips[0].start - 1.5) < 0.01);
  assert.ok(Math.abs(t.app.player.getTotal() - 4.5) < 0.01);

  const end = t.$('trimEnd');
  end.value = '0.5';
  end.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  assert.ok(t.app.state.clips[0].end > t.app.state.clips[0].start);
});

test('delete removes a clip and undo brings it back', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4'), t.file('b.mp4')]);
  t.$('delBtn').click();
  assert.equal(t.app.state.clips.length, 1);
  assert.equal(t.$('toast').hidden, false);
  assert.equal(t.$('undoBtn').hidden, false);
  t.$('undoBtn').click();
  assert.equal(t.app.state.clips.length, 2);
  assert.equal(t.$('totalTime').textContent, '0:12');
});

test('deleting the last clip returns to the picker screen', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4')]);
  t.$('delBtn').click();
  assert.equal(t.app.state.clips.length, 0);
  assert.equal(t.$('emptyState').hidden, false);
  assert.equal(t.$('editor').hidden, true);
  assert.equal(t.$('dock').hidden, true);
});

test('duplicate inserts a copy right after the selected clip', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4'), t.file('b.mp4')]);
  t.$('dupBtn').click();
  assert.equal(t.app.state.clips.length, 3);
  assert.equal(t.app.state.clips[1].sourceId, t.app.state.clips[0].sourceId);
  assert.equal(t.$('totalTime').textContent, '0:18');
});

test('a subtitle can be added to the selected clip and listed', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4'), t.file('b.mp4')]);
  t.app.selectClip(t.app.state.clips[1].id);
  t.$('subText').value = '핑크 크런치 개봉!';
  t.$('subScope').value = 'clip';
  t.$('subAddBtn').click();
  assert.equal(t.app.state.subtitles.length, 1);
  const sub = t.app.state.subtitles[0];
  assert.equal(sub.text, '핑크 크런치 개봉!');
  assert.equal(sub.scope, 'clip');
  assert.equal(sub.clipId, t.app.state.clips[1].id);
  assert.equal(t.$('subList').children.length, 1);
  assert.equal(t.$('subCount').textContent, '1개');
  assert.equal(t.$('subEmpty').hidden, true);
  assert.match(t.$('subList').children[0].textContent, /핑크 크런치 개봉/);
  assert.match(t.$('subList').children[0].textContent, /클립 2/);
  // form is cleared for the next caption
  assert.equal(t.$('subText').value, '');
});

test('empty subtitles are rejected', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4')]);
  t.$('subText').value = '   ';
  t.$('subAddBtn').click();
  assert.equal(t.app.state.subtitles.length, 0);
  assert.match(t.$('toastMsg').textContent, /자막 문구/);
});

test('subtitles can be edited and deleted', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4')]);
  t.$('subText').value = '처음 문구';
  t.$('subAddBtn').click();
  const id = t.app.state.subtitles[0].id;
  t.doc.querySelector('#subList [data-action="edit"]').click();
  assert.equal(t.$('subFormTitle').textContent, '자막 고치기');
  t.$('subText').value = '고친 문구';
  t.$('subAddBtn').click();
  assert.equal(t.app.state.subtitles.length, 1);
  assert.equal(t.app.state.subtitles[0].text, '고친 문구');
  assert.equal(t.app.state.subtitles[0].id, id);

  t.doc.querySelector('#subList [data-action="delete"]').click();
  assert.equal(t.app.state.subtitles.length, 0);
  t.$('undoBtn').click();
  assert.equal(t.app.state.subtitles.length, 1);
});

test('subtitle visibility range narrows when the caption appears', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4')]);
  t.$('subText').value = '잠깐만 보이는 자막';
  const from = t.$('subFrom');
  const to = t.$('subTo');
  from.value = '20';
  from.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  to.value = '60';
  to.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  assert.equal(t.$('subRangeLabel').textContent, '20% ~ 60%');
  t.$('subAddBtn').click();
  const sub = t.app.state.subtitles[0];
  assert.equal(sub.from, 0.2);
  assert.equal(sub.to, 0.6);
  assert.match(t.$('subList').textContent, /20~60%/);
});

test('subtitle settings (position, size, colour, box) reach the model', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4')]);
  t.doc.querySelector('#subPositions [data-pos="top"]').click();
  t.doc.querySelector('#subSizes [data-size="large"]').click();
  t.doc.querySelector('#subColors [data-color="#ffe066"]').click();
  t.$('subBg').checked = false;
  t.$('subBg').dispatchEvent(new t.window.Event('change', { bubbles: true }));
  t.$('subText').value = '위쪽 큰 노란 자막';
  t.$('subAddBtn').click();
  const sub = t.app.state.subtitles[0];
  assert.equal(sub.position, 'top');
  assert.equal(sub.size, 'large');
  assert.equal(sub.color, '#ffe066');
  assert.equal(sub.background, false);
  assert.match(t.$('subList').textContent, /위 · 크게/);
});

test('colour presets update sliders and the preview', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4')]);
  const before = t.draws.length;
  t.doc.querySelector('#colorPresets [data-preset="fresh"]').click();
  assert.equal(t.app.state.color.brightness, 0.16);
  assert.equal(t.$('brightness').value, '16');
  assert.equal(t.$('brightnessVal').textContent, '+16');
  assert.equal(t.$('colorMood').textContent, '화사하게');
  assert.equal(t.doc.querySelector('[data-preset="fresh"]').classList.contains('is-active'), true);
  assert.ok(t.draws.length > before);
  const last = t.draws[t.draws.length - 1];
  assert.equal(last.color.brightness, 0.16);

  t.$('brightness').value = '40';
  t.$('brightness').dispatchEvent(new t.window.Event('input', { bubbles: true }));
  assert.equal(t.app.state.color.brightness, 0.4);
  assert.equal(t.$('colorMood').textContent.includes('밝게'), true);

  t.$('resetColorBtn').click();
  assert.equal(t.app.state.color.brightness, 0);
});

test('tabs switch the visible panel', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4')]);
  t.doc.querySelector('.tab[data-panel="color"]').click();
  assert.equal(t.$('panel-color').hidden, false);
  assert.equal(t.$('panel-clips').hidden, true);
  assert.equal(t.doc.querySelector('.tab[data-panel="color"]').getAttribute('aria-selected'), 'true');
  t.doc.querySelector('.tab[data-panel="subs"]').click();
  assert.equal(t.$('panel-subs').hidden, false);
  assert.equal(t.$('panel-color').hidden, true);
});

test('the info sheet opens and closes', async () => {
  const t = setup();
  t.$('infoBtn').click();
  assert.equal(t.$('infoSheet').hidden, false);
  t.doc.querySelector('#infoSheet [data-close="info"]').click();
  assert.equal(t.$('infoSheet').hidden, true);
});

test('a portrait and a landscape clip keep the project aspect of the first clip', async () => {
  const t = setup();
  await t.app.addFiles([t.file('portrait.mp4'), t.file('wide.mp4')]);
  assert.deepEqual(t.app.state.size, { width: 720, height: 1280 });
  const lastDraw = t.draws[t.draws.length - 1];
  assert.equal(lastDraw.height, 540);
  assert.equal(lastDraw.width, 304);
});

test('playing toggles the play/pause icons', async () => {
  const t = setup();
  await t.app.addFiles([t.file('a.mp4')]);
  t.$('playBtn').click();
  await t.tick();
  assert.equal(t.app.player.isPlaying(), true);
  assert.equal(t.$('playBtn').querySelector('.i-play').hidden, true);
  t.$('playBtn').click();
  await t.tick();
  assert.equal(t.app.player.isPlaying(), false);
  assert.equal(t.$('playBtn').querySelector('.i-play').hidden, false);
});
