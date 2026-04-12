/**
 * In-process stale bot session cleanup.
 * Archives bot_sessions where last_heartbeat is older than the configured timeout.
 */
import { config } from '../config.js';

/**
 * @param {import('knex').Knex} db
 * @param {number} [intervalMs=60000]
 * @returns {NodeJS.Timeout}
 */
export function startSessionCleanup(db, intervalMs = 60_000) {
  const run = async () => {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - config.bot.sessionTimeoutSec;
      const now = Math.floor(Date.now() / 1000);
      const archived = await db('bot_sessions')
        .where('active', true)
        .where('last_heartbeat', '<', cutoff)
        .update({ active: false, ended_at: now, end_reason: 'heartbeat_timeout' });
      if (archived > 0) {
        console.log(`[cleanup] Archived ${archived} stale bot session(s)`);
      }
    } catch (err) {
      console.error('[cleanup] Error:', err.message);
    }
  };

  run();
  return setInterval(run, intervalMs);
}
