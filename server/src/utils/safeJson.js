/**
 * Safely parse a JSON string from a MySQL column.
 * Returns fallback if null, undefined, or malformed.
 */
export function safeParseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value; // already parsed (some MySQL drivers do this)
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Default allowed channels constant — used everywhere. */
export const DEFAULT_CHANNELS = ['release'];
