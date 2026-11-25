// Colour grading: preset definitions, CSS filter string, warmth overlay and a
// pixel fallback for Safari versions without CanvasRenderingContext2D.filter.

import { clamp, round } from './util.js';

export const DEFAULT_COLOR = Object.freeze({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
});

export const COLOR_LIMITS = Object.freeze({ min: -1, max: 1, step: 0.01 });

export const COLOR_PRESETS = Object.freeze([
  {
    id: 'original',
    label: '원본',
    settings: { brightness: 0, contrast: 0, saturation: 0, warmth: 0 },
  },
  {
    id: 'fresh',
    label: '화사하게',
    settings: { brightness: 0.16, contrast: 0.05, saturation: 0.1, warmth: 0.08 },
  },
  {
    id: 'soft',
    label: '뽀얗게',
    settings: { brightness: 0.2, contrast: -0.12, saturation: -0.08, warmth: 0.04 },
  },
  {
    id: 'crisp',
    label: '선명하게',
    settings: { brightness: 0.02, contrast: 0.16, saturation: 0.2, warmth: -0.04 },
  },
]);

export function normalizeColor(input = {}) {
  return {
    brightness: round(clamp(input.brightness ?? 0, -1, 1), 3),
    contrast: round(clamp(input.contrast ?? 0, -1, 1), 3),
    saturation: round(clamp(input.saturation ?? 0, -1, 1), 3),
    warmth: round(clamp(input.warmth ?? 0, -1, 1), 3),
  };
}

export function isNeutral(color) {
  const c = normalizeColor(color);
  return (
    Math.abs(c.brightness) < 0.005 &&
    Math.abs(c.contrast) < 0.005 &&
    Math.abs(c.saturation) < 0.005 &&
    Math.abs(c.warmth) < 0.005
  );
}

/** Which preset (if any) exactly matches these slider values. */
export function matchPreset(color) {
  const c = normalizeColor(color);
  for (const preset of COLOR_PRESETS) {
    const p = normalizeColor(preset.settings);
    if (
      Math.abs(c.brightness - p.brightness) < 0.006 &&
      Math.abs(c.contrast - p.contrast) < 0.006 &&
      Math.abs(c.saturation - p.saturation) < 0.006 &&
      Math.abs(c.warmth - p.warmth) < 0.006
    ) {
      return preset.id;
    }
  }
  return 'custom';
}

/**
 * CSS/canvas filter string for brightness, contrast and saturation.
 * Warmth is a separate soft-light overlay so it composites the same way with
 * or without ctx.filter support.
 */
export function cssFilter(color) {
  const c = normalizeColor(color);
  const brightness = round(1 + c.brightness * 0.5, 3);
  const contrast = round(1 + c.contrast * 0.5, 3);
  const saturate = round(1 + c.saturation * 0.8, 3);
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturate})`;
}

/** Warm/cool veil drawn over the frame with soft-light blending. */
export function warmthLayer(color) {
  const c = normalizeColor(color);
  if (Math.abs(c.warmth) < 0.01) return null;
  const amount = Math.min(1, Math.abs(c.warmth));
  const alpha = round(0.06 + amount * 0.24, 3);
  const warm = c.warmth > 0;
  return {
    color: warm
      ? `rgba(255, 176, 92, ${alpha})`
      : `rgba(112, 168, 255, ${alpha})`,
    alpha,
    composite: 'soft-light',
    direction: warm ? 'warm' : 'cool',
  };
}

/** True when this canvas can do context.filter (Safari 18+/iOS 18+). */
export function supportsCanvasFilter(ctx) {
  if (!ctx) return false;
  if (!('filter' in ctx)) return false;
  try {
    const before = ctx.filter;
    ctx.filter = 'brightness(1.2)';
    const ok = ctx.filter !== 'none' && ctx.filter !== '';
    ctx.filter = before ?? 'none';
    return Boolean(ok);
  } catch (error) {
    return false;
  }
}

/**
 * Per-pixel fallback path for browsers without ctx.filter.
 * Mutates `data` in place (Uint8ClampedArray RGBA) and returns it.
 */
export function adjustPixels(data, color) {
  const c = normalizeColor(color);
  const brightness = 1 + c.brightness * 0.5;
  const contrast = 1 + c.contrast * 0.5;
  const saturation = 1 + c.saturation * 0.8;
  const warmGain =
    c.warmth >= 0
      ? [1 + c.warmth * 0.12, 1, 1 - c.warmth * 0.14]
      : [1 + c.warmth * 0.14, 1 + c.warmth * 0.02, 1 - c.warmth * 0.12];

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] * brightness;
    let g = data[i + 1] * brightness;
    let b = data[i + 2] * brightness;

    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;

    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = luma + (r - luma) * saturation;
    g = luma + (g - luma) * saturation;
    b = luma + (b - luma) * saturation;

    data[i] = r * warmGain[0];
    data[i + 1] = g * warmGain[1];
    data[i + 2] = b * warmGain[2];
  }
  return data;
}

/** Short human label shown under the sliders. */
export function describeColor(color) {
  const preset = matchPreset(color);
  if (preset !== 'custom') {
    return COLOR_PRESETS.find((p) => p.id === preset).label;
  }
  const c = normalizeColor(color);
  const parts = [];
  if (Math.abs(c.brightness) >= 0.01) parts.push(c.brightness > 0 ? '밝게' : '어둡게');
  if (Math.abs(c.contrast) >= 0.01) parts.push(c.contrast > 0 ? '또렷하게' : '부드럽게');
  if (Math.abs(c.saturation) >= 0.01) parts.push(c.saturation > 0 ? '진하게' : '차분하게');
  if (Math.abs(c.warmth) >= 0.01) parts.push(c.warmth > 0 ? '따뜻하게' : '시원하게');
  return parts.length ? parts.join(' · ') : '원본';
}
