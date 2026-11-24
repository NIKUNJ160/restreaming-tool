/**
 * Time utility functions for media streaming, clipping, and downloading.
 */

/**
 * Converts a time string (e.g. "01:30", "00:01:30", "90", 90) to numeric seconds.
 * Supports:
 *   - "HH:MM:SS" -> hours * 3600 + minutes * 60 + seconds
 *   - "MM:SS"    -> minutes * 60 + seconds
 *   - "SS" / numeric -> parsed float
 * Returns 0 if invalid or empty.
 */
function timeToSeconds(timeStr) {
  if (typeof timeStr === 'number') return Math.max(0, timeStr);
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const trimmed = timeStr.trim();
  if (!trimmed) return 0;

  if (!trimmed.includes(':')) {
    const parsed = parseFloat(trimmed);
    return isNaN(parsed) || parsed < 0 ? 0 : parsed;
  }

  const parts = trimmed.split(':').map(p => parseFloat(p));
  for (const p of parts) {
    if (isNaN(p)) return 0;
  }

  if (parts.length === 3) {
    return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  } else if (parts.length === 2) {
    return Math.max(0, parts[0] * 60 + parts[1]);
  }
  return 0;
}

/**
 * Formats seconds into a human-readable HH:MM:SS or MM:SS format.
 */
function formatSecondsToTime(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

module.exports = {
  timeToSeconds,
  formatSecondsToTime
};
