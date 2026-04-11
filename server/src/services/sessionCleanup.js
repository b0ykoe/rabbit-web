/**
 * In-process stale bot session cleanup.
 * Replaces the Laravel scheduler + artisan command.
 * Deletes bot_sessions where last_heartbeat is older than 90 seconds.
 */

/**
 * @param {import('knex').Knex} db
 * @param {number} [intervalMs=60000]
 * @returns {NodeJS.Timeout}
 */
export function startSessionCleanup(db, intervalMs = 60_000) {
  const run = async () => {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - 90;
      const deleted = await db('bot_sessions').where('last_heartbeat', '<', cutoff).del();
      if (deleted > 0) {
        console.log(`[cleanup] Removed ${deleted} stale bot session(s)`);
      }
    } catch (err) {
      console.error('[cleanup] Error:', err.message);
    }
  };

  // Run once immediately, then on interval
  run();
  return setInterval(run, intervalMs);
}
