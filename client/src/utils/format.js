/**
 * Format seconds into human-readable duration.
 * @param {number} seconds
 * @returns {string} e.g. "2h 15m", "45m", "30s"
 */
export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Format a date string to locale short date.
 * @param {string} dateStr
 * @returns {string}
 */
export function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString();
}

/**
 * Calculate days remaining until a date.
 * @param {string|null} expiresAt - ISO date string or null (= lifetime)
 * @returns {{ days: number|null, label: string, color: string }}
 */
/**
 * Get MUI color for a release channel.
 */
export function getChannelColor(channel) {
  switch (channel) {
    case 'release': return 'success';
    case 'beta':    return 'warning';
    case 'alpha':   return 'error';
    default:        return 'default';
  }
}

export function getExpiryInfo(expiresAt) {
  if (!expiresAt) return { days: null, label: 'Lifetime', color: 'success' };
  const diff = new Date(expiresAt) - new Date();
  const days = Math.ceil(diff / 86400000);
  if (days <= 0) return { days: 0, label: 'Expired', color: 'default' };
  if (days <= 7) return { days, label: `${days}d`, color: 'error' };
  if (days <= 30) return { days, label: `${days}d`, color: 'warning' };
  return { days, label: `${days}d`, color: 'success' };
}
