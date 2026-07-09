//
// admin.flags.js — feature-flag catalog API (migration 042).
//
//   GET   /api/admin/feature-flags       — full catalog (any admin; the user
//                                          editor renders its checkboxes from
//                                          this instead of a hardcoded list)
//   PATCH /api/admin/feature-flags/:key  — super-admin only; update the
//                                          global kill-switch and/or the
//                                          per-user default. Audited.
//
// Effective bot-side value = enabled_globally && (super_admin || user value
// ?? default_value) — see services/featureFlags.js.
//

import { Router } from 'express';
import db from '../db.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { recordAudit } from '../services/auditLog.js';

const router = Router();

// GET / — catalog rows, group-sorted for direct UI rendering.
router.get('/', async (req, res) => {
  const rows = await db('feature_flag_catalog')
    .select('flag_key', 'label', 'group_label', 'is_shop',
            'default_value', 'enabled_globally', 'sort')
    .orderBy([{ column: 'group_label' }, { column: 'sort' }]);
  res.json({
    flags: rows.map(r => ({
      flag_key:         r.flag_key,
      label:            r.label,
      group_label:      r.group_label,
      is_shop:          !!r.is_shop,
      default_value:    !!r.default_value,
      enabled_globally: !!r.enabled_globally,
      sort:             r.sort,
    })),
  });
});

// PATCH /:key — { enabled_globally?, default_value? } (booleans). At least
// one field required. Super-admin only; every change lands in the audit log.
router.patch('/:key', requireSuperAdmin, async (req, res) => {
  const { key } = req.params;
  const body = req.body || {};

  const patch = {};
  if (typeof body.enabled_globally === 'boolean') patch.enabled_globally = body.enabled_globally;
  if (typeof body.default_value === 'boolean')    patch.default_value    = body.default_value;
  if (Object.keys(patch).length === 0) {
    return res.status(422).json({ error: 'enabled_globally or default_value (boolean) required' });
  }

  const existing = await db('feature_flag_catalog').where('flag_key', key).first();
  if (!existing) return res.status(404).json({ error: 'Unknown flag' });

  await db('feature_flag_catalog').where('flag_key', key).update(patch);

  await recordAudit(db, req, {
    action: 'feature_flags.update',
    subjectType: 'feature_flag',
    subjectId: key,
    oldValues: {
      enabled_globally: !!existing.enabled_globally,
      default_value:    !!existing.default_value,
    },
    newValues: patch,
  });

  const updated = await db('feature_flag_catalog').where('flag_key', key).first();
  res.json({
    flag_key:         updated.flag_key,
    enabled_globally: !!updated.enabled_globally,
    default_value:    !!updated.default_value,
  });
});

export default router;
