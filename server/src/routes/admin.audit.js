import { Router } from 'express';
import db from '../db.js';

const router = Router();

// GET /api/admin/audit — filterable, paginated audit log
router.get('/', async (req, res) => {
  const page   = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit  = 50;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';
  const action = req.query.action || '';

  let query = db('audit_logs')
    .leftJoin('users', 'audit_logs.user_id', 'users.id')
    .select(
      'audit_logs.id',
      'audit_logs.action',
      'audit_logs.subject_type',
      'audit_logs.subject_id',
      'audit_logs.old_values',
      'audit_logs.new_values',
      'audit_logs.ip_address',
      'audit_logs.created_at',
      'users.name as user_name',
      'users.email as user_email',
    );

  // Filter by action prefix
  if (action) {
    query = query.where('audit_logs.action', 'like', `${action}%`);
  }

  // Search across action, subject_id, user email/name
  if (search) {
    query = query.where((qb) => {
      qb.where('audit_logs.action', 'like', `%${search}%`)
        .orWhere('audit_logs.subject_id', 'like', `%${search}%`)
        .orWhere('users.name', 'like', `%${search}%`)
        .orWhere('users.email', 'like', `%${search}%`);
    });
  }

  const countQuery = query.clone().clearSelect().clearOrder().count('* as total').first();
  const dataQuery  = query.orderBy('audit_logs.created_at', 'desc').limit(limit).offset(offset);

  const [rows, countResult] = await Promise.all([dataQuery, countQuery]);

  // Parse JSON columns
  for (const row of rows) {
    row.old_values = row.old_values ? JSON.parse(row.old_values) : null;
    row.new_values = row.new_values ? JSON.parse(row.new_values) : null;
  }

  // Collect unique action prefixes for the filter dropdown
  const actionPrefixes = await db('audit_logs')
    .distinct(db.raw("SUBSTRING_INDEX(action, '.', 1) as prefix"))
    .orderBy('prefix');

  res.json({
    data: rows,
    actionPrefixes: actionPrefixes.map(a => a.prefix),
    page,
    totalPages: Math.ceil(Number(countResult.total) / limit),
    total:      Number(countResult.total),
  });
});

export default router;
