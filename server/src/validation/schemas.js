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
  // Admin-defined NAMED server (034). When present it is the AUTHORITATIVE
  // identity — the route resolves it directly to a game_servers.id and ignores
  // the ip/variant hint for keying. Positive int.
  server_id: z.coerce.number().int().positive().optional(),
  // Legacy ip/variant hint — now OPTIONAL. Used ONLY as a fallback resolve
  // (game_server_hosts.ip → variant MIN(id)) when server_id is absent, and as
  // a scan_sessions ip/variant snapshot. port is vestigial.
  server: z.object({
    ip:      z.string().min(1).max(45),
    variant: z.string().min(1).max(32),
    port:    z.string().max(8).optional(),
  }).optional(),
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
  // Admin-defined NAMED server (034). Optional — a Debug-with-key start may not
  // know the server yet; when present the session snapshots it, else null.
  server_id: z.coerce.number().int().positive().optional(),
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
// POST /api/admin/world/servers — create an admin-defined NAMED server (034).
// name is required; visible defaults false (publish is an explicit follow-up).
// known_ips seeds game_server_hosts so the bot can preselect this server by its
// game socket IP. `variant` is now OPTIONAL + vestigial — a server IS its own
// build (identified by its Engine.dll fingerprint on the Offsets tab), so the
// UI no longer collects it; kept in the schema only for legacy/back-compat.
export const serverCreateSchema = z.object({
  name:      z.string().min(1).max(128),
  variant:   z.string().max(32).optional(),
  visible:   z.boolean().optional(),
  known_ips: z.array(z.string().min(1).max(45)).optional(),
});

// PATCH /api/admin/world/servers/:id — edit name/variant/visible and/or add or
// remove known IPs (034). Every field optional so a caller can flip just one;
// at least one must be present. display_name kept for back-compat. name/variant
// are trimmed (name ≤128, variant ≤32); display_name may be an explicit null to
// clear. add_ips/remove_ips mutate game_server_hosts for this server.
export const serverUpdateSchema = z.object({
  display_name: z.string().max(128).nullable().optional(),
  name:         z.string().max(128).optional(),
  variant:      z.string().max(32).optional(),
  visible:      z.boolean().optional(),
  add_ips:      z.array(z.string().min(1).max(45)).optional(),
  remove_ips:   z.array(z.string().min(1).max(45)).optional(),
}).refine(
  d => d.display_name !== undefined || d.name !== undefined || d.variant !== undefined
    || d.visible !== undefined || d.add_ips !== undefined || d.remove_ips !== undefined,
  { message: 'Provide at least one field to update' },
);

// POST /api/admin/world/servers/:id/merge — FOLD one server (source_id) INTO
// the target (:id survivor). source_id is required + positive; the route also
// rejects source_id === :id (400 "cannot merge a server into itself") since
// :id is a URL param not visible here. dry_run:true returns per-child-table
// move counts WITHOUT mutating; dry_run:false (default) re-points every child
// of source_id onto :id and deletes the source game_servers row.
export const serverMergeSchema = z.object({
  source_id: z.coerce.number().int().positive(),
  dry_run:   z.boolean().optional().default(false),
});

// ── Admin: Game variants (world, 037) ────────────────────────────────────────
// The variant LABEL layer (Phase C). name is the join key = game_servers.variant
// so it is bounded to the same VARCHAR(32) as that column; it is REQUIRED on
// create and IMMUTABLE afterwards (only display_name/notes/archived are editable).
//
// POST /api/admin/world/variants — create a managed variant row. name required
// (1..32); display_name (≤64) + notes (≤255) optional.
export const variantCreateSchema = z.object({
  name:         z.string().min(1).max(32),
  display_name: z.string().max(64).optional(),
  notes:        z.string().max(255).optional(),
});

// PATCH /api/admin/world/variants/:id — edit the label fields only (name is
// immutable here). display_name may be an explicit null to clear it; archived
// flips the picker visibility; notes is free-form. At least one field required.
export const variantUpdateSchema = z.object({
  display_name: z.string().max(64).nullable().optional(),
  archived:     z.boolean().optional(),
  notes:        z.string().max(255).optional(),
}).refine(
  d => d.display_name !== undefined || d.archived !== undefined || d.notes !== undefined,
  { message: 'Provide at least one field to update' },
);

// ── Admin: Offset overrides (world, 038 — Phase D) ───────────────────────────
// The signed offset-override system. A server = base "Stock EP4" GameLayout +
// a few field overrides, signed with a SEPARATE password-encrypted Ed25519 key
// (NOT the always-hot bot-token key). See crypto/offsetSigning.js.
//
// POST /api/admin/world/offset-key/generate — mint the signing key. The
// password wraps the private key at rest (scrypt+aes-256-gcm); min 8 chars.
export const offsetKeyGenSchema = z.object({
  password: z.string().min(8),
});

// PUT /api/admin/world/servers/:id/offsets — set the engine fingerprint
// (stamp/size, both optional) + REPLACE the server's field overrides. Every
// field_name is validated against offset_field_catalog in the route (400 else);
// values are plain integers (an offset can be negative, so no nonnegative gate).
// overrides capped at 600 (the whole GameLayout is well under that).
export const offsetsPutSchema = z.object({
  stamp:     z.coerce.number().int().nonnegative().optional(),
  size:      z.coerce.number().int().nonnegative().optional(),
  // Which build template this server forks (Phase 1). null clears it; omit to leave
  // unchanged. A missing value on a field falls back to the template's base value.
  offset_template_id: z.coerce.number().int().positive().nullable().optional(),
  overrides: z.array(z.object({
    field_name: z.string().min(1).max(64),
    value:      z.coerce.number().int(),
  })).max(600),
});

// POST /api/admin/world/servers/:id/offsets/sign — sign the current overrides
// into a blob. password is required (min 1); a WRONG password fails cleanly (403)
// in the route via the crypto module's typed auth error.
export const offsetSignSchema = z.object({
  password: z.string().min(1),
});

// ── Admin: Build templates (world, 039 — Phase 1) ────────────────────────────
// A build template is a named per-edition base value-set (Stock EP4, Stock EP2, …)
// that servers fork. name 1..64; notes ≤255.
export const templateCreateSchema = z.object({
  name:  z.string().min(1).max(64),
  notes: z.string().max(255).nullable().optional(),
});

export const templateUpdateSchema = z.object({
  name:  z.string().min(1).max(64).optional(),
  notes: z.string().max(255).nullable().optional(),
}).refine(
  d => d.name !== undefined || d.notes !== undefined,
  { message: 'Provide at least one field to update' },
);

// PUT /offset-templates/:id/values — REPLACE-ALL a template's base field values.
// Each field_name is validated against offset_field_catalog in the route.
export const templateValuesPutSchema = z.object({
  values: z.array(z.object({
    field_name: z.string().min(1).max(64),
    value:      z.coerce.number().int(),
  })).max(2000),
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
