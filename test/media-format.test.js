import test from 'node:test';
import assert from 'node:assert/strict';

import { capSize, fitRect, hasAudioTrack, readVideoMeta, isVideoFile, aspectLabel } from '../js/core/media.js';
import {
  formatTimecode,
  formatSpeed,
  formatSeconds,
  formatBytes,
  formatPercent,
  formatFileStamp,
} from '../js/core/format.js';

test('capSize keeps the aspect ratio, caps the long side and stays even', () => {
  assert.deepEqual(capSize(720, 1280), { width: 720, height: 1280 });
  const big = capSize(2160, 3840, 1920);
  assert.equal(big.height, 1920);
  assert.ok(Math.abs(big.width / big.height - 2160 / 3840) < 0.01);
  assert.equal(big.width % 2, 0);
  const odd = capSize(719, 1279, 1920);
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);
  const tiny = capSize(1, 1);
  assert.ok(tiny.width >= 2);
});

test('fitRect contain and cover behave differently', () => {
  const contain = fitRect(1280, 720, 720, 1280);
  assert.equal(contain.width, 720);
  assert.ok(contain.height < 1280);
  const cover = fitRect(1280, 720, 720, 1280, 'cover');
  assert.equal(cover.height, 1280);
  assert.ok(cover.width > 720);
  assert.ok(cover.x < 0);
});

test('hasAudioTrack understands the browser variants', () => {
  assert.equal(hasAudioTrack({ mozHasAudio: false }), false);
  assert.equal(hasAudioTrack({ mozHasAudio: true }), true);
  assert.equal(hasAudioTrack({ audioTracks: { length: 0 } }), false);
  assert.equal(hasAudioTrack({ audioTracks: { length: 1 } }), true);
  assert.equal(hasAudioTrack(null), false);
  // Unknown engines are assumed to have audio instead of dropping it.
  assert.equal(hasAudioTrack({}), true);
});

test('readVideoMeta tolerates missing values', () => {
  assert.deepEqual(readVideoMeta({ videoWidth: 1920, videoHeight: 1080, duration: 12.5 }), {
    width: 1920,
    height: 1080,
    duration: 12.5,
    hasAudio: true,
  });
  const empty = readVideoMeta({});
  assert.equal(empty.width, 0);
  assert.equal(empty.duration, 0);
});

test('isVideoFile accepts files and extensions', () => {
  assert.equal(isVideoFile({ type: 'video/mp4', name: 'a.mp4' }), true);
  assert.equal(isVideoFile({ type: '', name: 'IMG_4283.MOV' }), true);
  assert.equal(isVideoFile({ type: 'image/jpeg', name: 'a.jpg' }), false);
  assert.equal(isVideoFile(null), false);
});

test('aspectLabel names the common reels ratios', () => {
  assert.equal(aspectLabel(720, 1280), '세로 9:16');
  assert.equal(aspectLabel(1280, 720), '가로 16:9');
  assert.equal(aspectLabel(1080, 1080), '정사각');
  assert.equal(aspectLabel(1080, 1350), '세로 4:5');
  assert.equal(aspectLabel(0, 0), '');
});

test('time and size formatting', () => {
  assert.equal(formatTimecode(0), '0:00.0');
  assert.equal(formatTimecode(50), '0:50.0');
  assert.equal(formatTimecode(65.4), '1:05.4');
  assert.equal(formatTimecode(65, { decimals: 0 }), '1:05');
  assert.equal(formatSpeed(1), '1x');
  assert.equal(formatSpeed(1.25), '1.25x');
  assert.equal(formatSeconds(45), '45초');
  assert.equal(formatSeconds(75), '1분 15초');
  assert.equal(formatBytes(900), '900B');
  assert.equal(formatBytes(17_726_829), '16.9MB');
  assert.equal(formatPercent(0.426), '43%');
  assert.equal(formatFileStamp(new Date('2026-11-25T23:22:00')), '20261125_2322');
});
