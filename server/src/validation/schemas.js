import { z } from 'zod';

// ── Auth ─────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
  remember: z.boolean().optional().default(false),
});

export const changePasswordSchema = z.object({
  password:              z.string().min(10)
    .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Must contain at least one number')
    .regex(/[^a-zA-Z0-9]/, 'Must contain at least one special character'),
  password_confirmation: z.string(),
}).refine(d => d.password === d.password_confirmation, {
  message: 'Passwords do not match',
  path:    ['password_confirmation'],
});

// ── Admin: Users ─────────────────────────────────────────────────────────────

export const createUserSchema = z.object({
  name:               z.string().min(1).max(255),
  email:              z.string().email().max(255),
  password:           z.string().min(8),
  role:               z.enum(['admin', 'user']),
  allowed_channels:   z.array(z.enum(['release', 'beta', 'alpha'])).optional().default(['release']),
  status:             z.string().max(255).nullable().optional(),
  hwid_reset_enabled: z.boolean().optional().default(true),
  feature_flags:      z.record(z.boolean()).optional(),
});

export const updateUserSchema = z.object({
  name:               z.string().min(1).max(255).optional(),
  email:              z.string().email().max(255).optional(),
  password:           z.string().min(8).optional(),
  role:               z.enum(['admin', 'user']).optional(),
  allowed_channels:   z.array(z.enum(['release', 'beta', 'alpha'])).optional(),
  status:             z.string().max(255).nullable().optional(),
  hwid_reset_enabled: z.boolean().optional(),
  feature_flags:      z.record(z.boolean()).optional(),
});

export const adjustCreditsSchema = z.object({
  credits: z.coerce.number().int(),
});

// ── Admin: Licenses ──────────────────────────────────────────────────────────

export const createLicenseSchema = z.object({
  max_sessions: z.coerce.number().int().min(1).max(100).default(1),
  note:         z.string().max(255).optional(),
  expires_at:   z.string().nullable().optional(),
});

export const updateLicenseSchema = z.object({
  max_sessions: z.coerce.number().int().min(1).max(100).optional(),
  note:         z.string().max(255).nullable().optional(),
  expires_at:   z.string().nullable().optional(),
});

export const extendLicenseSchema = z.object({
  days:       z.coerce.number().int().positive().optional(),
  expires_at: z.string().nullable().optional(),
}).refine(d => d.days || d.expires_at !== undefined, {
  message: 'Provide days or expires_at',
});

export const assignLicenseSchema = z.object({
  user_id: z.coerce.number().int().positive().nullable(),
});

// ── Admin: Releases ──────────────────────────────────────────────────────────

export const uploadReleaseSchema = z.object({
  type:      z.enum(['dll', 'loader']),
  channel:   z.enum(['release', 'beta', 'alpha']).default('release'),
  version:   z.string().regex(/^\d+\.\d+(\.\d+)?(-[a-zA-Z0-9_.]+)?$/),
  changelog: z.string().min(1),
});

export const updateReleaseSchema = z.object({
  changelog: z.string().min(1).optional(),
  channel:   z.enum(['release', 'beta', 'alpha']).optional(),
});

// ── Portal ───────────────────────────────────────────────────────────────────

export const redeemKeySchema = z.object({
  key: z.string().min(1).max(32),
});

export const purchaseSchema = z.object({
  product_id:  z.string().min(1),
  license_key: z.string().max(32).optional(),
});

export const resetHwidSchema = z.object({
  license_key: z.string().min(1).max(32),
});

// ── Bot API ──────────────────────────────────────────────────────────────────

export const botLoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

export const botAuthStartSchema = z.object({
  key:        z.string().min(1),
  session_id: z.string().min(1).max(64),
  hwid:       z.string().max(128).optional(),
});

export const botHeartbeatSchema = z.object({
  session_id: z.string().min(1),
  token:      z.string().optional(),
  stats:      z.object({
    kills:         z.number().int().default(0),
    xp_earned:     z.number().int().default(0),
    items_looted:  z.number().int().default(0),
    skills_used:   z.number().int().default(0),
    deaths:        z.number().int().default(0),
    stuck_escapes: z.number().int().default(0),
    runtime_ms:    z.number().int().default(0),
  }).optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(422).json({ errors: result.error.flatten().fieldErrors });
    }
    req.validated = result.data;
    next();
  };
}
