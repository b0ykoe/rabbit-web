import { Router } from 'express';
import db from '../db.js';

const router = Router();

// GET /api/portal/statuses — active global statuses (shown as banners)
router.get('/', async (req, res) => {
  const statuses = await db('global_statuses')
    .where('active', true)
    .orderBy('created_at', 'desc')
    .select('id', 'message', 'color');
  res.json(statuses);
});

export default router;
