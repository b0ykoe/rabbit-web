import { Router } from 'express';
import db from '../db.js';
import { recordAudit } from '../services/auditLog.js';
import { loadProducts, purchaseNewLicense, extendLicense } from '../services/shopService.js';
import { validate, purchaseSchema } from '../validation/schemas.js';

const router = Router();

// GET /api/portal/shop — products + user credit balance
router.get('/', async (req, res) => {
  const products = loadProducts();
  const user = await db('users').where('id', req.session.user.id).select('credits').first();

  // Also return user's licenses (for extend product dropdown)
  const licenses = await db('licenses')
    .where({ user_id: req.session.user.id, active: true })
    .select('license_key', 'expires_at', 'max_sessions');

  res.json({
    products,
    credits: user.credits,
    licenses,
  });
});

// POST /api/portal/shop/purchase — buy a product
router.post('/purchase', validate(purchaseSchema), async (req, res) => {
  const { product_id, license_key } = req.validated;
  const userId = req.session.user.id;

  const products = loadProducts();
  const product = products.find(p => p.id === product_id);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  try {
    if (product.type === 'new_license') {
      const result = await purchaseNewLicense(db, userId, product);

      await recordAudit(db, req, {
        action: 'shop.purchase', subjectType: 'license', subjectId: result.license_key,
        newValues: { product_id, product_name: product.name, credits_cost: product.credits_cost },
      });

      // Update session credits
      const user = await db('users').where('id', userId).select('credits').first();
      req.session.user.credits = user.credits;

      res.json({ message: `License created: ${result.license_key}`, ...result });

    } else if (product.type === 'extend_license') {
      if (!license_key) {
        return res.status(422).json({ error: 'license_key is required for extension' });
      }

      const result = await extendLicense(db, userId, license_key, product);

      await recordAudit(db, req, {
        action: 'shop.extend', subjectType: 'license', subjectId: license_key,
        newValues: { product_id, product_name: product.name, credits_cost: product.credits_cost, new_expires_at: result.expires_at },
      });

      // Update session credits
      const user = await db('users').where('id', userId).select('credits').first();
      req.session.user.credits = user.credits;

      res.json({ message: `License extended`, ...result });

    } else {
      res.status(422).json({ error: 'Unknown product type' });
    }
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

export default router;
