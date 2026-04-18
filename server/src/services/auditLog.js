/**
 * Audit log recorder — equivalent of Laravel's AuditLog::record().
 * Automatically captures user ID, IP, and user agent from the request.
 */

/**
 * @param {import('knex').Knex} db
 * @param {import('express').Request} req
 * @param {object} opts
 * @param {string} opts.action - e.g. 'user.create', 'license.revoke', 'release.upload'
 * @param {string} [opts.subjectType] - e.g. 'user', 'license', 'release'
 * @param {string|number} [opts.subjectId]
 * @param {object} [opts.oldValues]
 * @param {object} [opts.newValues]
 * @param {number} [opts.userId] - override user_id (bot endpoints: derive from license)
 */
export async function recordAudit(db, req, { action, subjectType, subjectId, oldValues, newValues, userId }) {
  const resolvedUserId = userId != null
    ? userId
    : (req.session?.user?.id || null);
  await db('audit_logs').insert({
    user_id:      resolvedUserId,
    action,
    subject_type: subjectType || null,
    subject_id:   subjectId != null ? String(subjectId) : null,
    old_values:   oldValues ? JSON.stringify(oldValues) : null,
    new_values:   newValues ? JSON.stringify(newValues) : null,
    ip_address:   req.ip || null,
    user_agent:   (req.get('user-agent') || '').slice(0, 255) || null,
  });
}
