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

  // Check expiry
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.status(422).json({ error: 'This key has expired' });
  }

  await db('licenses').where('license_key', key).update({ user_id: userId });

  await recordAudit(db, req, {
    action: 'license.redeem', subjectType: 'license', subjectId: key,
    newValues: { user_id: userId },
  });

  res.json({
    message: 'Key redeemed successfully',
    license_key: key,
    max_sessions: license.max_sessions,
    expires_at: license.expires_at,
  });
});

export default router;
