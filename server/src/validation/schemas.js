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
  name:     z.string().min(1).max(255),
  email:    z.string().email().max(255),
  password: z.string().min(8),
  role:     z.enum(['admin', 'user']),
});

export const updateUserSchema = z.object({
  name:     z.string().min(1).max(255).optional(),
  email:    z.string().email().max(255).optional(),
  password: z.string().min(8).optional(),
  role:     z.enum(['admin', 'user']).optional(),
});

// ── Admin: Licenses ──────────────────────────────────────────────────────────

export const createLicenseSchema = z.object({
  max_sessions: z.coerce.number().int().min(1).max(100).default(1),
  note:         z.string().max(255).optional(),
});

export const assignLicenseSchema = z.object({
  user_id: z.coerce.number().int().positive().nullable(),
});

// ── Admin: Releases ──────────────────────────────────────────────────────────
// Note: file upload validated via multer; these are the text fields

export const uploadReleaseSchema = z.object({
  type:      z.enum(['dll', 'loader']),
  version:   z.string().regex(/^\d+\.\d+(\.\d+)?(-[a-zA-Z0-9_.]+)?$/),
  changelog: z.string().min(1),
});

// ── Bot API ──────────────────────────────────────────────────────────────────

export const botAuthStartSchema = z.object({
  key:        z.string().min(1),
  session_id: z.string().min(1).max(64),
});

export const botHeartbeatSchema = z.object({
  session_id: z.string().min(1),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Express middleware factory: validate req.body against a zod schema.
 * Validated data goes to req.validated.
 */
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
