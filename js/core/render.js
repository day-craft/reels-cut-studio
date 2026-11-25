// Canvas rendering: one frame of the timeline (background, fitted video,
// colour grade, subtitles). Shared by the live preview and the exporter so the
// exported file matches what the user saw.

import { cssFilter, warmthLayer, normalizeColor, isNeutral, adjustPixels } from './color.js';
import {
  layoutSubtitle,
  wrapText,
  subtitleFont,
  sizeRatio,
} from './subtitles.js';

export const BACKGROUND = '#15111a';

export function drawFrame(ctx, options = {}) {
  const {
    width,
    height,
    video,
    videoWidth,
    videoHeight,
    color,
    filterSupported = false,
    subtitles = [],
    background = BACKGROUND,
  } = options;

  const metrics = { videoRect: null, subtitleBoxes: [] };
  if (!ctx || !width || !height) return metrics;

  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  const sw = Number(videoWidth) || (video && video.videoWidth) || 0;
  const sh = Number(videoHeight) || (video && video.videoHeight) || 0;
  if (video && sw > 0 && sh > 0) {
    const rect = fitContain(sw, sh, width, height);
    metrics.videoRect = rect;
    const graded = !isNeutral(color);
    const filterCss = graded ? cssFilter(color) : 'none';

    ctx.save();
    if (graded && filterSupported) {
      try {
        ctx.filter = filterCss;
      } catch (error) {
        // ignore: the pixel path below covers it
      }
    }
    try {
      ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height);
    } catch (error) {
      // A frame may not be ready yet; keep the background.
    }
    if (graded && filterSupported) {
      try {
        ctx.filter = 'none';
      } catch (error) {
        /* noop */
      }
    }
    if (graded && !filterSupported) {
      applyPixelGrade(ctx, rect, color);
    }
    ctx.restore();

    const veil = graded ? warmthLayer(color) : null;
    if (veil) {
      ctx.save();
      ctx.globalCompositeOperation = veil.composite;
      ctx.fillStyle = veil.color;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }
  }

  for (const subtitle of subtitles || []) {
    const box = drawSubtitle(ctx, subtitle, width, height);
    if (box) metrics.subtitleBoxes.push(box);
  }
  return metrics;
}

export function fitContain(sw, sh, dw, dh) {
  const scale = Math.min(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, width: w, height: h, scale };
}

/** Slow but accurate fallback for Safari without ctx.filter. */
export function applyPixelGrade(ctx, rect, color) {
  try {
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    const image = ctx.getImageData(x, y, w, h);
    adjustPixels(image.data, color);
    ctx.putImageData(image, x, y);
  } catch (error) {
    // Tainted or zero-sized canvas: leave the frame ungraded rather than fail.
  }
}

export function measureWith(ctx, text, fontCss) {
  if (!ctx || typeof ctx.measureText !== 'function') return 0;
  const previous = ctx.font;
  if (fontCss) ctx.font = fontCss;
  let width = 0;
  try {
    width = ctx.measureText(text).width || 0;
  } catch (error) {
    width = 0;
  }
  if (fontCss) ctx.font = previous;
  return width;
}

/**
 * Draw one subtitle and return its geometry. Lines are wrapped to the safe
 * width using the real canvas metrics, so Korean text never overflows.
 */
export function drawSubtitle(ctx, subtitle, width, height) {
  const text = String(subtitle?.text || '').trim();
  if (!text) return null;
  const ratio = sizeRatio(subtitle.size);
  const fontPx = Math.max(10, Math.round(ratio * height));
  const fontCss =
    '800 ' +
    `${fontPx}px "Apple SD Gothic Neo", -apple-system, BlinkMacSystemFont, "Noto Sans KR", "Malgun Gothic", sans-serif`;
  const sideMargin = Math.round(width * 0.07);
  const limit = width - sideMargin * 2;
  const measure = (line) => {
    const measured = measureWith(ctx, line, fontCss);
    return measured > 0 ? measured : roughWidth(line, fontPx);
  };
  const lines = wrapText(text, limit, measure);
  const layout = layoutSubtitle({
    lines,
    canvasWidth: width,
    canvasHeight: height,
    position: subtitle.position,
    size: subtitle.size,
    maxWidth: limit,
  });

  if (!ctx) return layout.box;

  ctx.save();
  if (subtitle.background) {
    ctx.fillStyle = 'rgba(20, 16, 24, 0.46)';
    roundRect(ctx, layout.box.x, layout.box.y, layout.box.width, layout.box.height, fontPx * 0.34);
    ctx.fill();
  }
  ctx.font = fontCss;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  layout.lines.forEach((line, index) => {
    const baselineY = layout.firstBaseline + index * layout.lineHeight;
    if (!subtitle.background) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.lineWidth = Math.max(2, Math.round(fontPx * 0.14));
      ctx.strokeText(line, layout.textX, baselineY);
    }
    ctx.fillStyle = subtitle.color || '#ffffff';
    ctx.fillText(line, layout.textX, baselineY);
  });
  ctx.restore();
  return layout.box;
}

export function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function roughWidth(line, fontPx) {
  let width = 0;
  for (const char of String(line)) {
    width += /[\uAC00-\uD7A3\u1100-\u11FF]/.test(char) ? fontPx : fontPx * 0.55;
  }
  return width;
}
