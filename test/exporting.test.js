import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIME_CANDIDATES,
  pickMimeType,
  extensionFor,
  recorderOptions,
  videoBitrate,
  exportFileName,
  progressOf,
  etaSeconds,
  projectHasAudio,
  recordingPlan,
  stageLabel,
  EXPORT_STAGES,
} from '../js/core/exporting.js';

test('MP4 is preferred when the browser supports it', () => {
  assert.equal(pickMimeType(() => true), MIME_CANDIDATES[0]);
  assert.equal(pickMimeType((m) => m === 'video/webm'), 'video/webm');
  assert.equal(pickMimeType((m) => m.startsWith('video/mp4')), 'video/mp4;codecs=avc1.42E01E,mp4a.40.2');
  assert.equal(pickMimeType(() => false), '');
  assert.equal(pickMimeType(() => {
    throw new Error('unsupported');
  }), '');
});

test('extensions and file names follow the chosen mime', () => {
  assert.equal(extensionFor('video/mp4;codecs=avc1'), 'mp4');
  assert.equal(extensionFor('video/webm;codecs=vp9'), 'webm');
  assert.equal(extensionFor(''), 'webm');
  const name = exportFileName('video/mp4', new Date('2026-11-25T23:07:00'));
  assert.equal(name, '릴스컷_20261125_2307.mp4');
  assert.match(exportFileName('video/webm', new Date('2026-01-02T03:04:00')), /^릴스컷_20260102_0304\.webm$/);
});

test('bitrate scales with resolution and stays sane', () => {
  assert.equal(videoBitrate(720, 1280), 3_041_280);
  assert.equal(videoBitrate(1920, 1080), 6_842_880);
  assert.equal(videoBitrate(100, 100), 2_000_000);
  assert.equal(videoBitrate(4000, 4000), 14_000_000);
  const options = recorderOptions({ mime: 'video/mp4', width: 720, height: 1280 });
  assert.equal(options.mimeType, 'video/mp4');
  assert.equal(options.audioBitsPerSecond, 128_000);
  assert.ok(options.videoBitsPerSecond >= 2_000_000);
});

test('progress and ETA follow the timeline clock', () => {
  assert.equal(progressOf(5, 10), 0.5);
  assert.equal(progressOf(99, 10), 1);
  assert.equal(progressOf(1, 0), 0);
  assert.equal(etaSeconds(0, 0, 10), null);
  assert.equal(etaSeconds(5, 5, 10), 5);
  assert.equal(etaSeconds(10, 2.5, 10), 30);
  assert.equal(etaSeconds(10, 20, 10), 0);
});

test('audio is requested only when a source has it', () => {
  assert.equal(projectHasAudio([{ hasAudio: false }, { hasAudio: false }]), false);
  assert.equal(projectHasAudio([{ hasAudio: false }, { hasAudio: true }]), true);
  assert.equal(projectHasAudio(new Map([['a', { hasAudio: true }]])), true);
  assert.equal(projectHasAudio([]), false);
  const plan = recordingPlan({
    sources: [{ hasAudio: false }],
    size: { width: 720, height: 1280 },
    isSupported: () => true,
  });
  assert.equal(plan.hasAudio, false);
  assert.equal(plan.extension, 'mp4');
});

test('stage labels read naturally in Korean', () => {
  assert.equal(stageLabel(EXPORT_STAGES.recording, 0.42), '영상 만드는 중 42%');
  assert.equal(stageLabel(EXPORT_STAGES.done), '완성!');
  assert.equal(stageLabel(EXPORT_STAGES.preparing), '내보낼 준비 중…');
});
