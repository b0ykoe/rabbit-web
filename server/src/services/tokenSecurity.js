/**
 * Token replay + revocation helpers (W-1 and W-2).
 *
 * jti — per-token random 32-char hex id in the payload. Blocklisting a
 *       jti invalidates exactly one token. Used when the user explicitly
 *       "kicks" a session from the portal UI.
 * tvr — token_version claim. Each principal (user + license) has a
 *       monotonically-increasing token_version column. All tokens
 *       outstanding for that principal carry the version at issue time.
 *       Bumping the column invalidates every outstanding token at once.
 *       Used on password reset, HWID reset, license revoke, role demote.
 *
 * Keep the blocklist table small: rows auto-expire at their own `exp`.
 */

/**
 * Is this jti in the blocklist? Returns true if the token is revoked.
 * @param {import('knex').Knex} db
 * @param {string} jti
 * @returns {Promise<boolean>}
 */
export async function isJtiBlocked(db, jti) {
  if (!jti) return false;
  const now = Math.floor(Date.now() / 1000);
  const row = await db('token_blocklist')
    .where('jti', jti)
    .where('expires_at', '>', now)
    .first();
  return !!row;
}

/**
 * Revoke a single token by its jti. Harmless if already revoked.
 * @param {import('knex').Knex} db
 * @param {string} jti
 * @param {number} expiresAt unix timestamp of token exp
 * @param {string} [reason='manual']
 */
export async function blockJti(db, jti, expiresAt, reason = 'manual') {
  if (!jti || !expiresAt) return;
  await db('token_blocklist')
    .insert({ jti, expires_at: expiresAt, reason })
    .onConflict('jti').ignore();
}

/**
 * Remove expired rows from the blocklist. Called by the periodic
 * cleanup job alongside stale-session archival.
 */
export async function purgeExpiredBlocklist(db) {
  const now = Math.floor(Date.now() / 1000);
  return db('token_blocklist').where('expires_at', '<=', now).del();
}

/**
 * Bump the user's token_version. Any outstanding token whose tvr claim
 * is older than the new value is invalidated on next verify.
 * @param {import('knex').Knex} db
 * @param {number} userId
 * @returns {Promise<number>} the new version
 */
export async function bumpUserTokenVersion(db, userId) {
  await db('users').where('id', userId).increment('token_version', 1);
  const row = await db('users').where('id', userId).select('token_version').first();
  return Number(row?.token_version || 0);
}

/**
 * Bump a license's token_version. Same semantics as user bump but per-key.
 */
export async function bumpLicenseTokenVersion(db, licenseKey) {
  await db('licenses').where('license_key', licenseKey).increment('token_version', 1);
  const row = await db('licenses').where('license_key', licenseKey).select('token_version').first();
  return Number(row?.token_version || 0);
}

/**
 * Verify that the token's claimed `tvr` is still current. Returns true
 * if the token is still valid against the DB's token_version. When the
 * principal doesn't exist, returns false (conservative).
 *
 * @param {import('knex').Knex} db
 * @param {'user'|'license'} kind
 * @param {string|number} id user_id or license_key
 * @param {number} claimedVersion token payload's tvr claim (missing = 1)
 */
export async function isTokenVersionCurrent(db, kind, id, claimedVersion) {
  const cv = Number(claimedVersion) || 1;
  let row;
  if (kind === 'user') {
    row = await db('users').where('id', id).select('token_version').first();
  } else if (kind === 'license') {
    row = await db('licenses').where('license_key', id).select('token_version').first();
  } else {
    return false;
  }
  if (!row) return false;
  return Number(row.token_version) <= cv;
}
