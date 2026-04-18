import { Router } from 'express';
import db from '../db.js';
import { recordAudit } from '../services/auditLog.js';
import { validate, redeemKeySchema } from '../validation/schemas.js';

const router = Router();

// POST /api/portal/redeem — user claims an unassigned key
router.post('/', validate(redeemKeySchema), async (req, res) => {
  const { key } = req.validated;
  const userId = req.session.user.id;

  const license = await db('licenses').where('license_key', key).first();

  if (!license) {
    return res.status(404).json({ error: 'License key not found' });
  }

  if (!license.active) {
    return res.status(422).json({ error: 'This key has been revoked' });
  }

  if (license.user_id) {
    return res.status(422).json({ error: 'This key is already claimed' });
  }

  // Check expiry (only applies to keys that already had a concrete date)
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.status(422).json({ error: 'This key has expired' });
  }

  // Compute expires_at from banked duration at redeem time, so an
  // unclaimed key doesn't bleed time while sitting in the user's
  // inbox. If the key has no duration (admin-issued with a fixed
  // date or a true lifetime key), we keep whatever's there.
  const updates = { user_id: userId };
  let resolvedExpiry = license.expires_at;
  if (!license.expires_at && license.duration_days) {
    const expiry = new Date(Date.now() + license.duration_days * 86400000);
    resolvedExpiry = expiry.toISOString().slice(0, 19).replace('T', ' ');
    updates.expires_at = resolvedExpiry;
    // duration_days left as-is for audit trail; expires_at is now the
    // source of truth and any further extend() updates it directly.
  }

  await db('licenses').where('license_key', key).update(updates);

  await recordAudit(db, req, {
    action: 'license.redeem', subjectType: 'license', subjectId: key,
    newValues: { user_id: userId, expires_at: resolvedExpiry },
  });

  res.json({
    message: 'Key redeemed successfully',
    license_key: key,
    max_sessions: license.max_sessions,
    expires_at: resolvedExpiry,
  });
});

export default router;
