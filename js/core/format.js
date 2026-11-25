// Time and size formatting helpers.

export function formatTimecode(seconds, { decimals = 1 } = {}) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  const text = rest.toFixed(decimals);
  const padded = Number(text) < 10 ? `0${text}` : text;
  return `${minutes}:${padded}`;
}

export function formatClock(seconds) {
  return formatTimecode(seconds, { decimals: 0 });
}

export function formatSpeed(speed) {
  const n = Number(speed);
  if (!Number.isFinite(n)) return '1x';
  const trimmed = Math.round(n * 100) / 100;
  return `${trimmed}x`;
}

export function formatPercent(ratio) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  return `${Math.round(r * 100)}%`;
}

export function formatSeconds(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}분 ${rest}초` : `${m}분`;
}

export function formatBytes(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b < 1024) return `${Math.round(b)}B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)}KB`;
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatFileStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function parseNumber(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}
