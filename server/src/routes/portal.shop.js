import { Router } from 'express';
import db from '../db.js';
import { recordAudit } from '../services/auditLog.js';
import { loadProducts, purchaseNewLicense, extendLicense, purchaseModule } from '../services/shopService.js';
import { validate, purchaseSchema } from '../validation/schemas.js';

const router = Router();

// GET /api/portal/shop — products + user credit balance + bought keys + shop status
router.get('/', async (req, res) => {
  // Check if shop is enabled
  const shopSetting = await db('settings').where('key', 'shop_enabled').first();
  const shopEnabled = shopSetting ? shopSetting.value === 'true' : true;

  const products = loadProducts();
  const user = await db('users').where('id', req.session.user.id).select('credits', 'feature_flags').first();

  // User's assigned licenses (for extend product list)
  const licenses = await db('licenses')
    .where({ user_id: req.session.user.id, active: true })
    .select('license_key', 'expires_at', 'max_sessions');

  // Bought but unredeemed keys. `duration_days` is the banked time the
  // user will get *from the moment they redeem* — no clock ticking while
  // the key sits here.
  const boughtKeys = await db('licenses')
    .where({ purchased_by: req.session.user.id, active: true })
    .whereNull('user_id')
    .select('license_key', 'expires_at', 'duration_days', 'max_sessions', 'note', 'created_at');

  // Parse feature flags
  let featureFlags = {};
  try {
    featureFlags = user.feature_flags
      ? (typeof user.feature_flags === 'string' ? JSON.parse(user.feature_flags) : user.feature_flags)
      : {};
  } catch { /* empty */ }

  res.json({
    shopEnabled,
    products,
    credits: user.credits,
    featureFlags,
    licenses,
    boughtKeys,
  });
});

// POST /api/portal/shop/purchase — buy a product
router.post('/purchase', validate(purchaseSchema), async (req, res) => {
  // Check if shop is enabled
  const shopSetting = await db('settings').where('key', 'shop_enabled').first();
  if (shopSetting && shopSetting.value !== 'true') {
    return res.status(403).json({ error: 'Shop is currently disabled' });
  }

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

      res.json({ message: `Key purchased: ${result.license_key}`, ...result });

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

    } else if (product.type === 'module') {
      const result = await purchaseModule(db, userId, product);

      await recordAudit(db, req, {
        action: 'shop.purchase_module', subjectType: 'user', subjectId: String(userId),
        newValues: { product_id, product_name: product.name, credits_cost: product.credits_cost, flag_key: product.flag_key },
      });

      // Update session credits
      const user = await db('users').where('id', userId).select('credits').first();
      req.session.user.credits = user.credits;

      res.json({ message: `Module "${product.name}" activated`, ...result });

    } else {
      res.status(422).json({ error: 'Unknown product type' });
    }
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

export default router;
