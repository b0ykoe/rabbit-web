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
  role:               z.enum(['super_admin', 'admin', 'user']),
  allowed_channels:   z.array(z.enum(['release', 'beta', 'alpha'])).optional().default(['release']),
  status:             z.string().max(255).nullable().optional(),
  hwid_reset_enabled: z.boolean().optional().default(true),
  feature_flags:      z.record(z.boolean()).optional(),
});

export const updateUserSchema = z.object({
  name:               z.string().min(1).max(255).optional(),
  email:              z.string().email().max(255).optional(),
  password:           z.string().min(8).optional(),
  role:               z.enum(['super_admin', 'admin', 'user']).optional(),
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
  // Game server the bot client is currently connected to. All three
  // optional — the bot only knows them once the game has an established
  // TCP socket to the login/channel server.
  server_ip:      z.string().max(45).optional(),
  server_port:    z.string().max(8).optional(),
  server_variant: z.string().max(32).optional(),
  // Per-SOCKS5-proxy traffic breakdown. Cumulative since bot start; server
  // keeps the latest value per (session_id, profile). Credentials are
  // never sent by the client — only name/host/port + counters.
  proxy_stats: z.array(z.object({
    profile:        z.string().min(1).max(64),
    host:           z.string().max(253).optional().default(''),
    port:           z.number().int().min(0).max(65535).optional().default(0),
    bytes_sent:     z.number().nonnegative().default(0),
    bytes_recv:     z.number().nonnegative().default(0),
    sockets_active: z.number().int().nonnegative().default(0),
    sockets_total:  z.number().int().nonnegative().default(0),
  })).optional(),
});

// ── Bot: Monster-map ingest (world) ──────────────────────────────────────────
// PLAN_v2 §3.6. channel/maxhp/netid are all .optional() so OLDER bots that
// POST no channel still validate → they land as channel 0 and collapse as
// today. netid is accepted for optional intra-batch dedup then DROPPED —
// never stored, never a key [A8]. Coordinates get sane-bounds validation; the
// sightings array is capped so an authenticated-but-hostile client can't
// drive a huge upsert.
const WORLD_COORD_MIN = -100_000;
const WORLD_COORD_MAX = 100_000;

export const spawnSightingSchema = z.object({
  mob_id:  z.number().int(),                       // >0 enforced in the route (drop <=0 [A2])
  name:    z.string().max(96).optional(),
  level:   z.number().int().min(0).max(1000).optional(),
  maxhp:   z.number().int().min(0).optional(),
  channel: z.number().int().min(0).max(65535).optional().default(0),
  x:       z.number().min(WORLD_COORD_MIN).max(WORLD_COORD_MAX),
  z:       z.number().min(WORLD_COORD_MIN).max(WORLD_COORD_MAX),
  y:       z.number().min(WORLD_COORD_MIN).max(WORLD_COORD_MAX),
  // Bot-side pre-quantized cell index floor((world-origin)/4) [B1]. When present,
  // stored DIRECTLY so bot + portal grids align; legacy bots omit it → floor(x/4).
  cell_x:  z.number().int().optional(),
  cell_z:  z.number().int().optional(),
  // v2 ADDITIVE deltas — the portal ADDs these onto the row (never re-adds a
  // cumulative total → no super-linear inflation). All three >= 0; a legacy
  // migrated cell may send a small 1/1/1 delta (reads as low-confidence). Each
  // defaults to 0 so a delta that omits one dimension still validates.
  // Per-sighting delta caps TIGHTENED (hardening): one drained cell in a single
  // scan session realistically contributes only a handful of hits/passes and a
  // modest instance_sum. The prior 1e6 / 1e8 ceilings let a hostile-but-authed
  // client inflate a cell arbitrarily in one batch. Additive tightening only —
  // fields stay optional + default 0, so a legacy/partial delta still validates.
  hits_delta:         z.number().int().min(0).max(10_000).optional().default(0),
  passes_delta:       z.number().int().min(0).max(10_000).optional().default(0),
  instance_sum_delta: z.number().int().min(0).max(100_000).optional().default(0),
  // Optional distinct-run guard. When present and != the stored last_*_run_id
  // the delta is applied and the run_id stored (keeps hits/passes distinct-runs).
  // Accept either a JS number or a bigint-as-string (JSON can't hold a bigint).
  run_id:  z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(),
  netid:   z.number().int().optional(),            // dedup-only, never persisted [A8]
});

export const spawnIngestSchema = z.object({
  token:  z.string().optional(),                   // consumed by validateSpawnIngest, ignored here
  server: z.object({
    ip:      z.string().min(1).max(45),
    variant: z.string().min(1).max(32),
    port:    z.string().max(8).optional(),
  }),
  zone_no:   z.number().int().min(0).max(65535),
  sightings: z.array(spawnSightingSchema).min(1).max(200),
  // Backend-issued recording session (033). When present + valid + owned, every
  // cell in this batch is attributed to it (stamped on spawn_version_meta INSERT
  // only). null-tolerant in the route: a bad/foreign session_id is dropped, not
  // rejected, so ingest never fails on a stale session. Absent for legacy bots.
  session_id: z.string().uuid().optional(),
});

// ── Bot: Recording sessions (world) ──────────────────────────────────────────
// Backend-issued scan sessions (033). session_id rides ALONGSIDE run_id (run_id
// stays the version bucket); the portal mints the uuid so the bot never has to.
//
//   POST /session/start — open a 'running' session. server{}/zone_no/run_id are
//     all optional (the bot may not know the server yet, and a Debug-with-key
//     start still wants a session). client_started_sec is informational; the
//     server always stamps its own started_sec.
//   POST /session/stop  — close a session by its (required) uuid. ended_sec is
//     optional + server-clamped to [started, now].
export const sessionStartSchema = z.object({
  token:  z.string().optional(),                   // consumed by validateSpawnIngest, ignored here
  server: z.object({
    ip:      z.string().min(1).max(45),
    variant: z.string().min(1).max(32),
    port:    z.string().max(8).optional(),
  }).optional(),
  zone_no: z.number().int().min(0).max(65535).optional(),
  // run_id may arrive as a JS number or a bigint-as-string (JSON can't hold a
  // bigint) — same contract as spawnSightingSchema.run_id.
  run_id:  z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(),
  // Bot's own clock at start; informational only — server stamps started_sec.
  client_started_sec: z.number().int().nonnegative().optional(),
});

export const sessionStopSchema = z.object({
  token:      z.string().optional(),
  session_id: z.string().uuid(),                   // required — the session to close
  ended_sec:  z.number().int().nonnegative().optional(),
});

export const zoneBoundsSchema = z.object({
  token:  z.string().optional(),
  server: z.object({
    ip:      z.string().min(1).max(45),
    variant: z.string().min(1).max(32),
    port:    z.string().max(8).optional(),
  }),
  zone_no:          z.number().int().min(0).max(65535),
  origin_x:         z.number(),
  origin_z:         z.number(),
  world_min_x:      z.number(),
  world_min_z:      z.number(),
  world_max_x:      z.number(),
  world_max_z:      z.number(),
  size_px:          z.number().int().positive().max(16384).optional(),
  meters_per_pixel: z.number().positive().optional(),
  cell_size_m:      z.number().positive().optional().default(4),
});

// ── Portal: Monster-map versioned read (world) ───────────────────────────────
// STEP 3 versioned-spots read guard for the optional ?version query on
// GET /:serverId/zones/:zoneNo/spawns. Lightweight + ADDITIVE — it does NOT
// touch spawnSightingSchema (run_id there stays optional). Accepts:
//   absent / 'all' → all-time (legacy) path
//   'latest'       → newest revision per spot
//   numeric string → an exact version bucket (bigint carried as a string)
// The route itself parses this (parseVersionParam); this schema is exported for
// reuse/tests and mirrors that contract without tightening anything else.
export const versionQuerySchema = z.object({
  version: z.union([
    z.enum(['all', 'latest']),
    z.string().regex(/^\d+$/),
  ]).optional(),
});

// ── Admin: Monster-map ingest tokens (world) ─────────────────────────────────
export const ingestTokenMintSchema = z.object({
  // SELF path: bind the token to the REQUESTING super_admin (no user/license
  // selection). When true, user_id/license_key may be omitted entirely.
  self:        z.boolean().optional(),
  user_id:     z.coerce.number().int().positive().optional(),
  license_key: z.string().min(1).max(32).optional(),
  // Seeding-key window: default 6h (short-lived), hard-capped at 72h. Threaded
  // into the token exp + the issued_ingest_tokens.expires_at so both stay coherent.
  duration_hours: z.coerce.number().int().min(1).max(72).optional().default(6),
}).refine(d => d.self === true || d.user_id != null || d.license_key, {
  message: 'Provide self, user_id, or license_key',
});

// ── Admin: Monster-map per-server management (world) ──────────────────────────
// PATCH /api/admin/world/servers/:id — edit display_name and/or visible. Both
// fields are optional so a caller can flip just one; at least one must be
// present. display_name is a trimmed string (≤128) or an explicit null to clear.
export const serverUpdateSchema = z.object({
  display_name: z.string().max(128).nullable().optional(),
  visible:      z.boolean().optional(),
}).refine(d => d.display_name !== undefined || d.visible !== undefined, {
  message: 'Provide display_name and/or visible',
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
