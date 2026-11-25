// Subtitle model, timing windows, text wrapping and canvas layout.
// Positioning is resolution independent: every number derives from the canvas
// height, so the preview (small canvas) and the export (full size) match.

import { clamp, round } from './util.js';

export const SUBTITLE_MAX_LENGTH = 140;
export const SUBTITLE_MIN_LENGTH = 1;

export const SUBTITLE_POSITIONS = Object.freeze([
  { id: 'top', label: '위' },
  { id: 'center', label: '가운데' },
  { id: 'bottom', label: '아래' },
]);

export const SUBTITLE_SIZES = Object.freeze([
  { id: 'small', label: '작게', ratio: 0.032 },
  { id: 'medium', label: '보통', ratio: 0.042 },
  { id: 'large', label: '크게', ratio: 0.054 },
]);

export const SUBTITLE_COLORS = Object.freeze([
  { id: 'white', value: '#ffffff', label: '흰색' },
  { id: 'black', value: '#1d1a20', label: '검정' },
  { id: 'yellow', value: '#ffe066', label: '노랑' },
  { id: 'pink', value: '#ffb3cf', label: '핑크' },
]);

export const SUBTITLE_SCOPES = Object.freeze([
  { id: 'all', label: '영상 전체' },
  { id: 'clip', label: '이 클립' },
]);

let subCounter = 0;

export function nextSubtitleId() {
  subCounter += 1;
  return `s${subCounter}_${Math.random().toString(36).slice(2, 6)}`;
}

export function resetSubtitleIds() {
  subCounter = 0;
}

export function cleanSubtitleText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, SUBTITLE_MAX_LENGTH);
}

export function validateSubtitleText(text) {
  const cleaned = cleanSubtitleText(text);
  if (cleaned.length < SUBTITLE_MIN_LENGTH) {
    return { valid: false, reason: '자막 문구를 입력해 주세요.' };
  }
  if (cleaned.length > SUBTITLE_MAX_LENGTH) {
    return { valid: false, reason: `자막은 ${SUBTITLE_MAX_LENGTH}자까지 넣을 수 있어요.` };
  }
  return { valid: true, text: cleaned };
}

export function createSubtitle({
  id,
  text,
  scope = 'all',
  clipId = null,
  from = 0,
  to = 1,
  position = 'bottom',
  size = 'medium',
  color = '#ffffff',
  background = true,
} = {}) {
  const cleaned = cleanSubtitleText(text);
  const sc = scope === 'clip' && clipId ? 'clip' : 'all';
  const start = clamp(from, 0, 1);
  const end = clamp(to, 0, 1);
  return {
    id: id || nextSubtitleId(),
    text: cleaned,
    scope: sc,
    clipId: sc === 'clip' ? clipId : null,
    from: round(Math.min(start, end), 3),
    to: round(Math.max(start, end), 3),
    position: SUBTITLE_POSITIONS.some((p) => p.id === position) ? position : 'bottom',
    size: SUBTITLE_SIZES.some((s) => s.id === size) ? size : 'medium',
    color: typeof color === 'string' && color ? color : '#ffffff',
    background: Boolean(background),
  };
}

export function updateSubtitle(subtitle, patch = {}) {
  return createSubtitle({ ...subtitle, ...patch });
}

/**
 * Turn subtitles into concrete [start, end) windows on the output timeline.
 * `from`/`to` are fractions of the subtitle's scope, so trimming or changing a
 * clip's speed keeps the caption attached to the same relative moment.
 */
export function subtitleWindows(subtitles, segments, total) {
  const windows = [];
  const trackTotal = Number.isFinite(total) ? total : 0;
  for (const subtitle of subtitles || []) {
    if (!subtitle || !subtitle.text) continue;
    let scopeStart = 0;
    let scopeEnd = trackTotal;
    if (subtitle.scope === 'clip') {
      const seg = (segments || []).find((s) => s.clipId === subtitle.clipId);
      if (!seg) continue;
      scopeStart = seg.timelineStart;
      scopeEnd = seg.timelineEnd;
    }
    const span = Math.max(0, scopeEnd - scopeStart);
    if (span <= 0) continue;
    const start = round(scopeStart + span * clamp(subtitle.from, 0, 1), 3);
    const end = round(scopeStart + span * clamp(subtitle.to, 0, 1), 3);
    if (end - start <= 0.01) continue;
    windows.push({ subtitle, start, end });
  }
  return windows.sort((a, b) => a.start - b.start);
}

export function activeSubtitles(windows, time) {
  return (windows || [])
    .filter((w) => time >= w.start - 1e-6 && time < w.end - 1e-6)
    .map((w) => w.subtitle);
}

/**
 * Wrap text into lines that fit `maxWidth`. Break on explicit newlines first,
 * then on spaces, then per character for long Korean runs without spaces.
 */
export function wrapText(text, maxWidth, measure) {
  const lines = [];
  const paragraphs = String(text ?? '').split('\n');
  const limit = Math.max(1, Number(maxWidth) || 1);
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) {
      lines.push('');
      continue;
    }
    const words = trimmed.split(/\s+/);
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate) <= limit) {
        current = candidate;
        continue;
      }
      if (current) {
        lines.push(current);
        current = '';
      }
      if (measure(word) <= limit) {
        current = word;
        continue;
      }
      // Break an over-long token (Korean text often has no spaces).
      let chunk = '';
      for (const char of word) {
        if (chunk && measure(chunk + char) > limit) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      current = chunk;
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [''];
}

export function sizeRatio(sizeId) {
  const found = SUBTITLE_SIZES.find((s) => s.id === sizeId);
  return (found || SUBTITLE_SIZES[1]).ratio;
}

export function subtitleFont(sizeId, canvasHeight) {
  const px = Math.max(10, Math.round(sizeRatio(sizeId) * canvasHeight));
  return {
    px,
    family:
      '800 ' +
      `${px}px "Apple SD Gothic Neo", -apple-system, BlinkMacSystemFont, "Noto Sans KR", "Malgun Gothic", sans-serif`,
  };
}

/**
 * Geometry for one subtitle block, in canvas pixels.
 * Returns a box that can be drawn with a rounded background, plus the first
 * line's baseline for fillText.
 */
export function layoutSubtitle({
  lines,
  canvasWidth,
  canvasHeight,
  position = 'bottom',
  size = 'medium',
  paddingX = null,
  paddingY = null,
  maxWidth = null,
} = {}) {
  const font = subtitleFont(size, canvasHeight);
  const fontPx = font.px;
  const lineHeight = Math.round(fontPx * 1.32);
  const padX = paddingX ?? Math.round(fontPx * 0.52);
  const padY = paddingY ?? Math.round(fontPx * 0.3);
  const sideMargin = Math.round(canvasWidth * 0.07);
  const limit = maxWidth ?? canvasWidth - sideMargin * 2;
  const textLines = lines && lines.length ? lines : [''];
  const widest = Math.max(
    1,
    ...textLines.map((line) => (line ? estimatedWidth(line, fontPx) : fontPx * 0.5)),
  );
  const boxWidth = Math.min(limit + padX * 2, widest + padX * 2);
  const boxHeight = lineHeight * textLines.length + padY * 2;
  const marginBottom = Math.round(canvasHeight * 0.088);
  const marginTop = Math.round(canvasHeight * 0.09);

  let boxY;
  if (position === 'top') boxY = marginTop;
  else if (position === 'center') boxY = Math.round((canvasHeight - boxHeight) / 2);
  else boxY = canvasHeight - marginBottom - boxHeight;

  const boxX = Math.round((canvasWidth - boxWidth) / 2);
  return {
    font,
    fontPx,
    lineHeight,
    lines: textLines,
    limit,
    paddingX: padX,
    paddingY: padY,
    box: { x: boxX, y: boxY, width: boxWidth, height: boxHeight },
    textX: canvasWidth / 2,
    firstBaseline:
      boxY + padY + Math.round(lineHeight / 2) + Math.round(fontPx * 0.35),
  };
}

/** Rough width used before a canvas measure function is available. */
export function estimatedWidth(line, fontPx) {
  let width = 0;
  for (const char of String(line)) {
    width += /[\u1100-\u11FF\u2E80-\uD7FF\uAC00-\uD7A3]/.test(char)
      ? fontPx * 1.0
      : fontPx * 0.55;
  }
  return width;
}

export function groupByScope(subtitles, clips) {
  const groups = new Map();
  for (const subtitle of subtitles || []) {
    const key = subtitle.scope === 'clip' ? subtitle.clipId : 'all';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(subtitle);
  }
  return groups;
}
