import { Router } from 'express';
import db from '../db.js';
import { recordAudit } from '../services/auditLog.js';
import { validate, resetHwidSchema } from '../validation/schemas.js';

const router = Router();

// POST /api/portal/reset-hwid — user resets their own key's bound HWID
router.post('/', validate(resetHwidSchema), async (req, res) => {
  const { license_key } = req.validated;
  const userId = req.session.user.id;

  // Check user owns this key
  const license = await db('licenses').where({ license_key, user_id: userId }).first();
  if (!license) {
    return res.status(404).json({ error: 'License not found or not owned by you' });
  }

  if (!license.bound_hwid) {
    return res.json({ message: 'No HWID bound to this key' });
  }

  // Check if user is allowed to reset
  const user = await db('users').where('id', userId).select('hwid_reset_enabled').first();
  if (!user.hwid_reset_enabled) {
    return res.status(403).json({ error: 'HWID reset is disabled for your account. Contact an admin.' });
  }

  await db('licenses').where('license_key', license_key).update({ bound_hwid: null });
  // W-2: invalidate outstanding tokens bound to the old HWID.
  await db('licenses').where('license_key', license_key).increment('token_version', 1);
  // Archive active sessions so new HWID can connect
  const { archiveSessionsByKey } = await import('../services/licenseService.js');
  await archiveSessionsByKey(db, license_key, 'hwid_reset');

  await recordAudit(db, req, {
    action: 'license.reset_hwid', subjectType: 'license', subjectId: license_key,
    oldValues: { bound_hwid: license.bound_hwid },
    newValues: { bound_hwid: null, reset_by: 'user' },
  });

  res.json({ message: 'HWID reset successfully. You can now use a different machine.' });
});

export default router;
